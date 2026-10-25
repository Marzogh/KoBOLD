// Installer boundary: private handles and signed evidence never enter UI state.
import { identify, policyProposal, settings } from './core.js';
import { hashFile, hashBytes } from './sha256.js';
import {
  exists,
  readText,
  fileHandle,
  separateLocations,
  backupReader,
} from './storage.js';
import {
  getRelease,
  installationGate,
  stage,
  collectSystemBackup,
  queue,
  healthy,
  endpointMatches,
  configureEndpoint,
  enableStartup,
  HOME,
} from './installer.js';
import {
  discoverBackups,
  requireSystemBackup,
  skipMainBackup,
  assertBackupChoice,
  skipAcknowledgementFreshness,
} from './backup-store.js';
import { updateBackup } from './automatic-backup.js';
import { collectionPackage, stageCollection, collectPreflight } from './collection.js';
import { readVerifiedReport, stageManagedUpgrade } from './connection.js';
import { installationLayout } from './installation-layout.js';
import { connectionInstallation } from './install-flow.js';
import {
  scanPreparation,
  prepareScanProtection,
  confirmScanRestart,
  requireScanReady,
} from './scan-protection.js';
import { requireSignedRelease, requestedReportId } from './provenance.js';
import { repairManagedPayload } from './managed-repair.js';
import { collectDiagnostics } from './diagnostics.js';
import { folderRecord, folderPermission } from './session.js';
import { browserSupport, phaseLabels } from './backup-ui.js';
import { wizardView, deviceCycle, nextConnectionJob } from './wizard-view.js';
const STORE = 'kobold.wizard.v1';
const mutations = new Set([
  'prepare-folders',
  'prepare-collection',
  'install',
  'authorise',
  'endpoint',
  'enable',
  'update',
  'repair',
  'disable',
  'remove',
  'skip-backup',
  'save-system',
]);
const freeze = (object) => {
  if (object && typeof object === 'object') {
    Object.values(object).forEach(freeze);
    Object.freeze(object);
  }
  return object;
};
const defaults = {
  ip: '',
  ports: '8083',
  hostname: 'kobo-reader',
  tag: 'tag:kobo-sync',
  owner: 'autogroup:admin',
  'extra-deny': '',
  'original-policy': '',
  rewrite: false,
};
export function createWizardAdapter({
  journal,
  storage,
  scope = globalThis,
  preview = false,
  dependencies = {},
}) {
  const d = {
    installationLayout,
    policyProposal,
    identify,
    hashFile,
    hashBytes,
    exists,
    readText,
    fileHandle,
    separateLocations,
    backupReader,
    getRelease,
    installationGate,
    stage,
    collectSystemBackup,
    queue,
    healthy,
    endpointMatches,
    configureEndpoint,
    enableStartup,
    discoverBackups,
    requireSystemBackup,
    skipMainBackup,
    assertBackupChoice,
    skipAcknowledgementFreshness,
    updateBackup,
    collectionPackage,
    stageCollection,
    collectPreflight,
    readVerifiedReport,
    stageManagedUpgrade,
    connectionInstallation,
    scanPreparation,
    prepareScanProtection,
    confirmScanRestart,
    requireScanReady,
    requestedReportId,
    repairManagedPayload,
    collectDiagnostics,
    folderRecord,
    folderPermission,
    ...dependencies,
  };
  let saved;
  try {
    saved = JSON.parse(storage?.getItem(STORE));
  } catch {}
  if (saved?.sessionId !== journal.id) saved = null;
  let form = { ...defaults, ...saved?.form },
    config = null,
    policy = null,
    policyConfirmed = false;
  let reader,
    root,
    backup,
    release,
    collection,
    identity,
    fingerprint = saved?.fingerprint,
    report,
    trust,
    activeRelease,
    collectionResult;
  let layout = 'none';
  let backupVerified = false,
    systemVerified = false,
    endpointCorrect = false,
    connectionHealthy = false,
    signinOpened = false;
  let scan = null,
    owned = false,
    unknown = false,
    incomplete = false,
    permissionNeeded = false,
    handles,
    collectionPrepared = false;
  let cycle = preview === true ? null : (saved?.cycle ?? null),
    syncConfirmed = false,
    finalConfirmed = false,
    journey = saved?.journey ?? 'new';
  let initialized = false,
    revision = 0,
    guardRevision = 0,
    busy = false,
    operation = null,
    progress = null,
    error = null,
    message = '',
    cancel = false;
  const listeners = new Set(),
    consents = new Map();
  let lastProgressPaint = 0,
    lastProgressLog = 0,
    lastProgressPhase = '';
  function emit(guard = false) {
    revision++;
    if (guard) {
      guardRevision++;
      consents.clear();
    }
    for (const fn of listeners) fn(snapshot());
  }
  function persist() {
    try {
      storage.setItem(
        STORE,
        JSON.stringify({
          sessionId: journal.id,
          form,
          policyConfirmed,
          policyText: policy?.text,
          journey,
          cycle,
          fingerprint,
          syncConfirmed,
          finalConfirmed,
          backupVerified:
            backupVerified ||
            (!!backup &&
              saved?.backupVerified === true &&
              saved.fingerprint === fingerprint &&
              saved.backupName === backup.name),
          backupName: backup?.name,
          trustDigest: trust?.digest,
        }),
      );
    } catch {
      message =
        'Setup storage is unavailable. Keep this tab open and export diagnostics.';
    }
  }
  function snapshot() {
    const s = {
      version: 1,
      preview: preview === true,
      layout,
      revision,
      guardRevision,
      sessionId: journal.id,
      initialized,
      journey,
      fileAccess: browserSupport(scope).fileAccess,
      reader: identity
        ? { model: identity.model, firmware: identity.firmware, folder: reader?.name }
        : null,
      backupFolder: root?.name ?? null,
      backupVerified,
      backupPreviouslyVerified:
        !backupVerified &&
        !!backup &&
        saved?.fingerprint === fingerprint &&
        saved?.backupName === backup.name &&
        saved?.backupVerified === true,
      backupSkipped:
        backup?.skipped === true &&
        d.skipAcknowledgementFreshness(backup.receipt).fresh,
      backupPresent: !!backup,
      supported: identity?.matched === true,
      active: !!trust && d.connectionInstallation(activeRelease ?? release, trust),
      trust: trust ? { status: trust.status, sequence: trust.sequence } : null,
      systemVerified,
      connectionHealthy,
      endpointCorrect,
      signinReady: !!report?.signin,
      signinOpened,
      existingEnrollment: owned && !report?.status && !report?.signin,
      managedDetected: owned,
      syncConfirmed,
      finalConfirmed,
      startupVerified: trust?.status === 'healthy',
      policyConfirmed,
      configured: !!config,
      policy: policy
        ? {
            text: policy.text,
            findings: [
              ...policy.conflicts,
              ...policy.rewritten.map((x) => 'Wildcard sources changed: ' + x),
            ],
            conflicts: policy.conflicts.length,
          }
        : null,
      form: { ...form },
      scan: scan?.state ?? 'unknown',
      collectionReady: collectionResult?.ready === true,
      collectionAvailable: !!collection,
      collectionPrepared,
      releaseAllowsInstall: false,
      updateAvailable:
        !!trust &&
        !!release?.continuation &&
        release.continuation.purpose === 'upgrade-managed-install' &&
        trust.descriptor === release.continuation.previous.installationDescriptorSha256,
      permissionNeeded,
      cycle: cycle ? { ...cycle, instructions: [...cycle.instructions] } : null,
      busy,
      operation: operation ? { ...operation } : null,
      progress: progress ? { ...progress } : null,
      error: error ? { ...error } : null,
      message,
      incomplete,
      unknown,
      collectionFiles: collection?.rootFiles ? [...collection.rootFiles] : [],
      initializedRelease: !!release,
    };
    try {
      requireSignedRelease(release);
      s.releaseAllowsInstall =
        release.channel !== 'connection-trial' &&
        (release.trial?.purpose === 'install-and-connect' ||
          release.profile.bootstrapAccepted === true);
    } catch {}
    s.view = wizardView(s);
    return freeze(s);
  }
  function record(code, values) {
    journal.record(operation?.action ?? 'setup', code, values);
  }
  async function onProgress(event) {
    if (cancel)
      throw new DOMException(
        'Backup cancelled. Partial files have not been accepted.',
        'AbortError',
      );
    progress =
      typeof event === 'string'
        ? { phase: event, fraction: null }
        : {
            phase: phaseLabels[event.phase] ?? 'Checking files',
            fraction: Number.isFinite(event.fraction)
              ? event.fraction
              : Number.isFinite(event.size) && event.size > 0
                ? event.bytes / event.size
                : null,
            currentFile: event.path ?? '',
            fileBytes: event.fileBytes ?? event.bytes,
            fileSize: event.fileSize ?? event.size,
            completedFiles: event.completedFiles,
            totalFiles: event.totalFiles,
            copiedBytes: event.copiedBytes,
            totalBytes: event.totalBytes,
          };
    // Manifest verification has known file counts even when the legacy event
    // leaves its overall fraction null. Show progress within this named phase.
    if (
      typeof event !== 'string' &&
      progress.fraction === null &&
      Number.isFinite(event.totalFiles) &&
      event.totalFiles > 0 &&
      Number.isFinite(event.completedFiles)
    ) {
      const within =
        event.fileSize > 0 && Number.isFinite(event.fileBytes)
          ? Math.min(1, event.fileBytes / event.fileSize)
          : 0;
      progress.fraction = Math.min(
        0.999,
        (event.completedFiles + within) / event.totalFiles,
      );
    }
    if (typeof event !== 'string' && Number.isFinite(event.scannedFiles)) {
      progress.scannedFiles = event.scannedFiles;
    }
    progress.step = operation?.step;
    // Only class/count telemetry persists; filenames remain transient display data.
    const now = performance.now(),
      phase = typeof event === 'string' ? 'checking' : (event.phase ?? 'checking');
    const changed = typeof event === 'string' || phase !== lastProgressPhase;
    if (changed || now - lastProgressLog >= 150 || phase === 'complete') {
      record('progress-' + phase, { ...progress, fileClass: 'other' });
      lastProgressLog = now;
    }
    if (changed || now - lastProgressPaint >= 50 || phase === 'complete') {
      lastProgressPaint = now;
      emit();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    lastProgressPhase = phase;
  }
  async function capture() {
    if (preview === true || !reader || !root) return;
    try {
      journal.evidence(await d.collectDiagnostics(reader, root));
    } catch {
      record('diagnostic-read-unavailable');
    }
  }
  function setCycle(kind, requestId, step, action) {
    cycle = { ...deviceCycle(kind, crypto.randomUUID(), step), requestId, action };
    persist();
    record('awaiting-device');
  }
  async function identityCheck(handle = reader) {
    const f = await (await d.fileHandle(handle, '.kobo/version')).getFile();
    const next = await d.hashFile(f);
    if (fingerprint && next !== fingerprint)
      throw Error(
        'This is a different reader or firmware. Select the Kobo again. Previous evidence has been retained.',
      );
    return next;
  }
  async function selectReader(handle) {
    if (operation) await onProgress('Reading the Kobo model and firmware…');
    const nextIdentity = d.identify(await d.readText(handle, '.kobo/version'));
    const next = await d.hashFile(
      await (await d.fileHandle(handle, '.kobo/version')).getFile(),
    );
    if (fingerprint && fingerprint !== next) {
      root =
        backup =
        report =
        trust =
        activeRelease =
        collectionResult =
        scan =
        cycle =
          null;
      backupVerified =
        systemVerified =
        endpointCorrect =
        connectionHealthy =
        syncConfirmed =
        finalConfirmed =
        policyConfirmed =
          false;
      layout = 'none';
      consents.clear();
      journal.start();
      record('reader-changed');
    }
    reader = handle;
    fingerprint = next;
    identity = nextIdentity;
    if (preview === true) {
      owned = unknown = incomplete = false;
      cycle = null;
      message = 'Kobo selected.';
      return;
    }
    if (operation)
      await onProgress('Checking installed setup files and pending operations…');
    layout = await d.installationLayout(reader);
    owned = layout === 'kobold';
    unknown = false;
    incomplete = await d.exists(reader, HOME + '/INSTALL-INCOMPLETE.txt');
    collectionPrepared =
      !!collection &&
      (await d.exists(
        reader,
        '.adds/kobold-preflight/' + collection.id + '/verified.tgz',
      ));
    if (incomplete) journey = 'recovery';
    else if (owned && journey === 'new') journey = 'managed';
    await restorePending();
    // USB remounts can invalidate a previously selected handle. Recover status
    // from signed evidence, without restarting setup or scanning the library.
    if (owned && backup && root && !cycle) {
      trust = report = activeRelease = null;
      systemVerified = connectionHealthy = endpointCorrect = false;
      try {
        await loadReport(false);
      } catch (failure) {
        trust = report = activeRelease = null;
        systemVerified = connectionHealthy = endpointCorrect = false;
        journey = 'managed';
        throw failure;
      }
    } else message = 'Kobo selected.';
  }
  async function restorePending() {
    if (!reader) return;
    if (await d.exists(reader, HOME + '/request.txt')) {
      const text = await d.readText(reader, HOME + '/request.txt');
      const requestId = text.match(/^id=([a-f0-9]{32})$/m)?.[1],
        action = text.match(
          /^action=(inspect|enrol|status|enable|disable|uninstall)$/m,
        )?.[1];
      if (requestId && action)
        setCycle(
          action === 'inspect' ? 'install' : 'status',
          requestId,
          ['disable', 'uninstall'].includes(action) ? 'recovery' : 'connect',
          action,
        );
    }
    if (release?.continuation) {
      const path = '.adds/kobold-connect/' + release.continuation.id + '/request.json';
      if (await d.exists(reader, path)) {
        const request = JSON.parse(await d.readText(reader, path));
        if (
          /^[a-f0-9]{32}$/.test(request.id) &&
          !trust &&
          !(await d.exists(reader, HOME + '/reports/' + request.id + '/result.txt'))
        )
          setCycle('update', request.id, 'install', 'update');
      }
    }
  }
  async function saveHandles() {
    if (reader && root)
      try {
        handles = { reader, backup: root };
        await d.folderRecord(journal.id, handles);
      } catch {
        message =
          'Folder references could not be saved. Select the folders again after refreshing.';
        record('handle-storage-unavailable');
      }
  }
  async function selectBackup(handle, autoBackup) {
    if (operation) await onProgress('Checking the selected backup folder…');
    await d.separateLocations(reader, handle);
    if (await d.exists(handle, 'manifest.json'))
      throw Error(
        'Choose the parent folder containing your backup generations, not one individual backup.',
      );
    root = handle;
    backup = null;
    backupVerified = systemVerified = false;
    if (operation) await onProgress('Looking for existing backup generations…');
    const found = await d.discoverBackups(reader, root);
    if (operation)
      await onProgress(
        found.matches.length +
          ' matching backup generation(s) found. Checking saved setup records…',
      );
    backup = found.matches[0] ?? null;
    await saveHandles();
    scan =
      preview === true
        ? null
        : await d.scanPreparation(reader, { root }).catch(() => null);
    if (scan?.state === 'restart' && !cycle)
      setCycle('folders', null, 'install', 'folders');
    if (owned && backup)
      await loadReport(false).catch(() => {
        record('result-not-verified');
      });
    if (!owned && !cycle && autoBackup) await refreshBackup();
  }
  async function refreshBackup() {
    await onProgress('Checking and updating the Kobo backup. Keep USB connected.');
    backup = await d.updateBackup(reader, root, backup, onProgress);
    backupVerified = true;
    record('backup-verified');
    message = 'Backup completed and verified.';
    if (!['backup', 'select-backup'].includes(operation?.action))
      await onProgress('Backup verified. Continuing setup. Keep USB connected.');
  }
  async function loadReport(saveSystem = false) {
    if (operation)
      await onProgress(
        'Reading and verifying the signed Kobo result and installer files…',
      );
    connectionHealthy = false;
    endpointCorrect = false;
    const result = await d.readVerifiedReport(reader, backup, release);
    report = result.report;
    trust = result.trust;
    activeRelease = result.active ?? release;
    signinOpened = false;
    connectionHealthy = false;
    if (report.status && config)
      try {
        d.healthy(report.status, config);
        connectionHealthy = true;
      } catch {}
    endpointCorrect =
      connectionHealthy &&
      (await d.endpointMatches(reader, config, report.status).catch(() => false));
    // A bounded archive check is not a book-backup enumeration.
    if (backup)
      systemVerified = !!(await d
        .requireSystemBackup(reader, backup)
        .catch(() => null));
    if (saveSystem && !report.status && !systemVerified) {
      await d.collectSystemBackup(reader, backup, report, onProgress);
      systemVerified = true;
      await refreshBackup();
    }
    message =
      trust.status === 'healthy'
        ? 'Automatic startup verified. Complete the restart and sync test.'
        : 'Signed result verified.';
    record('signed-result-verified', { sequence: trust.sequence });
    return result;
  }
  function errorCode(e) {
    return [
      'NotAllowedError',
      'NotFoundError',
      'NotReadableError',
      'QuotaExceededError',
      'AbortError',
      'SecurityError',
    ].includes(e.name)
      ? e.name
      : 'operation-failed';
  }
  function allowed(action) {
    if (
      preview === true &&
      ![
        'select-reader',
        'select-backup',
        'resume-access',
        'backup',
        'review-policy',
        'confirm-policy',
        'forget-session',
      ].includes(action)
    )
      return false;
    const s = snapshot(),
      main = s.view.action;
    if (action === main && action !== 'manage') return true;
    if (['select-reader', 'forget-session'].includes(action)) return true;
    if (action === 'select-backup') return !!reader;
    if (action === 'review-policy') return true;
    if (action === 'confirm-policy') return !!policy && !policy.conflicts.length;
    if (action === 'backup') return !!reader && !!root && !cycle;
    if (action === 'skip-backup')
      return (
        !!root &&
        !backupVerified &&
        !owned &&
        release?.channel !== 'attended-trial' &&
        !!release?.profile?.bootstrapAccepted
      );
    if (action === 'manage') return !!trust;
    if (action === 'status') return !!reader && !!backup && !!release;
    if (action === 'update')
      return (
        s.updateAvailable &&
        !!backup &&
        scan?.state === 'ready' &&
        !cycle &&
        !incomplete
      );
    if (action === 'repair')
      return owned && !!backup && !backup.skipped && scan?.state === 'ready' && !cycle;
    if (['disable', 'remove'].includes(action))
      return (
        owned &&
        !!backup &&
        !!trust &&
        !cycle &&
        !incomplete &&
        !['disabled', 'removed'].includes(trust.status)
      );
    return false;
  }
  function consent(action) {
    if (busy || !allowed(action)) throw Error('This action is not available.');
    const token = crypto.randomUUID();
    consents.set(token, {
      action,
      revision: guardRevision,
      fingerprint,
      artifact: release?.installationDescriptorSha256,
      config: JSON.stringify(config),
    });
    return token;
  }
  // Pickers execute before the first await, preserving browser user activation.
  async function run(action, context = {}) {
    if (busy) throw Error('Wait for the current operation to finish.');
    if (
      !browserSupport(scope).fileAccess &&
      !['review-policy', 'confirm-policy', 'forget-session'].includes(action)
    )
      throw Error(
        'Use a supported desktop browser with folder access for this action.',
      );
    if (context.guardRevision !== guardRevision)
      throw Error('Setup changed. Review the current action and try again.');
    if (!allowed(action))
      throw Error('This action is unavailable until its requirements are met.');
    if (mutations.has(action)) {
      const grant = consents.get(context.consent);
      if (
        !grant ||
        grant.action !== action ||
        grant.revision !== guardRevision ||
        grant.fingerprint !== fingerprint ||
        grant.artifact !== release?.installationDescriptorSha256 ||
        grant.config !== JSON.stringify(config)
      )
        throw Error('Approve this specific action before continuing.');
      consents.delete(context.consent);
    }
    if (
      action === 'return' &&
      (!cycle || context.cycleId !== cycle.id || context.acknowledged !== true)
    )
      throw Error('Confirm the current disconnect and reconnect steps.');
    if (action === 'open-signin') {
      if (!/^https:\/\/login\.tailscale\.com\/a\/[a-zA-Z0-9]+$/.test(report?.signin))
        throw Error('No verified sign-in link is available.');
      scope.open(report.signin, '_blank', 'noopener,noreferrer');
      signinOpened = true;
      emit(true);
      persist();
      return;
    }
    let selection;
    if (action === 'select-reader' || action === 'select-backup')
      selection = scope.showDirectoryPicker({
        id: action === 'select-reader' ? 'kobold-reader' : 'kobold-backup',
        mode: 'readwrite',
      });
    busy = true;
    cancel = false;
    error = null;
    progress = null;
    let resetting = false;
    operation = {
      id: crypto.randomUUID(),
      action,
      step: snapshot().view.step,
      view: snapshot().view,
      cancellable: action === 'backup',
    };
    progress = {
      step: operation.step,
      phase: selection
        ? 'Choose the folder in the browser dialog…'
        : 'Starting the selected action…',
      fraction: null,
    };
    const started = Date.now();
    record('started');
    emit(true);
    try {
      if (
        reader &&
        !['select-reader', 'forget-session', 'resume-access'].includes(action)
      )
        await identityCheck();
      switch (action) {
        case 'select-reader':
          await selectReader(await selection);
          break;
        case 'select-backup':
          await selectBackup(await selection, journey === 'new');
          break;
        case 'resume-access':
          if (!handles || !(await d.folderPermission(handles, true)))
            throw Error('Allow access to both folders, or select them again.');
          await selectReader(handles.reader);
          await selectBackup(handles.backup, false);
          permissionNeeded = false;
          break;
        case 'backup':
          await refreshBackup();
          break;
        case 'skip-backup':
          backup = await d.skipMainBackup(reader, root, true);
          message =
            'Backup skipped with your approval. System backup remains required.';
          break;
        case 'review-policy': {
          const input = context.input;
          if (
            !input ||
            typeof input !== 'object' ||
            Object.keys(input).some((k) => !Object.hasOwn(defaults, k))
          )
            throw Error('Enter valid setup fields.');
          form = { ...defaults, ...input };
          config = dSettings(form);
          policy = d.policyProposal
            ? d.policyProposal(
                form['original-policy'],
                config,
                form.rewrite === true,
                form['extra-deny'],
              )
            : policyProposal(
                form['original-policy'],
                config,
                form.rewrite === true,
                form['extra-deny'],
              );
          config = policy.config;
          policyConfirmed = false;
          message = 'Review the proposal, validate and save it in Tailscale.';
          break;
        }
        case 'confirm-policy':
          if (context.acknowledged !== true)
            throw Error('Confirm policy backup and acceptance first.');
          policyConfirmed = true;
          message = 'Policy confirmation recorded.';
          if (report?.status) {
            try {
              d.healthy(report.status, config);
              connectionHealthy = true;
              endpointCorrect = await d.endpointMatches(reader, config, report.status);
            } catch {
              connectionHealthy = false;
            }
          }
          break;
        case 'manage':
          journey = 'continue';
          if (!config || !policyConfirmed)
            message =
              'Confirm your server settings and working policy before connection changes.';
          break;
        case 'prepare-folders':
          await refreshBackup();
          scan = await d.prepareScanProtection(reader, backup, release);
          setCycle('folders', null, 'install', 'folders');
          break;
        case 'prepare-collection': {
          await d.requireScanReady(reader, backup);
          await refreshBackup();
          const nonce = await d.stageCollection(reader, backup, collection, true);
          collectionPrepared = true;
          setCycle('collection', nonce, 'install', 'collection');
          break;
        }
        case 'install': {
          d.installationGate(identity, release, {
            trialAcknowledged: true,
            collectionResult,
          });
          await d.requireScanReady(reader, backup);
          await refreshBackup();
          const nonce = await d.stage(
            reader,
            backup,
            release,
            config,
            policyConfirmed,
            { trialAcknowledged: true, collectionResult, progress: onProgress },
          );
          owned = true;
          setCycle('install', nonce, 'install', 'inspect');
          break;
        }
        case 'return': {
          const current = cycle;
          if (current.kind === 'folders') {
            scan = await d.confirmScanRestart(reader, { root }, true);
            await refreshBackup();
          } else if (current.kind === 'collection') {
            collectionResult = await d.collectPreflight(
              reader,
              { root },
              collection,
              onProgress,
            );
            await refreshBackup();
            if (!collectionResult.ready)
              throw Error(
                'System checks did not pass. Keep the backup and review diagnostics.',
              );
          } else if (current.kind === 'sync') syncConfirmed = true;
          else if (current.kind === 'final') finalConfirmed = true;
          else {
            const result = await loadReport(current.kind === 'install');
            if (current.requestId && result.report.id !== current.requestId)
              throw Error('The returned result belongs to another operation.');
          }
          cycle = null;
          break;
        }
        case 'resume-collection':
          collectionResult = await d.collectPreflight(
            reader,
            { root },
            collection,
            onProgress,
          );
          await refreshBackup();
          if (!collectionResult.ready) throw Error('System checks did not pass.');
          break;
        case 'save-system':
          await d.collectSystemBackup(reader, backup, report, onProgress);
          systemVerified = true;
          await refreshBackup();
          break;
        case 'authorise': {
          await d.requireScanReady(reader, backup);
          await refreshBackup();
          await d.requireSystemBackup(reader, backup);
          const job = nextConnectionJob({
            existingEnrollment: owned,
            status: report?.status,
            signin: report?.signin,
            opened: signinOpened,
          });
          const nonce = await d.queue(reader, job, config, backup);
          report = null;
          connectionHealthy = false;
          setCycle('status', nonce, 'connect', job);
          break;
        }
        case 'endpoint':
          await d.requireScanReady(reader, backup);
          await refreshBackup();
          await d.configureEndpoint(reader, backup, config, report.status);
          endpointCorrect = true;
          setCycle('sync', null, 'connect', 'sync-test');
          break;
        case 'sync-test':
          setCycle('sync', null, 'connect', 'sync-test');
          break;
        case 'enable': {
          if (!syncConfirmed || !endpointCorrect || !connectionHealthy)
            throw Error('Confirm successful sync before enabling startup.');
          await d.requireScanReady(reader, backup);
          await refreshBackup();
          const nonce = await d.enableStartup(reader, backup, config, report.status);
          report = null;
          setCycle('status', nonce, 'connect', 'enable');
          break;
        }
        case 'final-test':
          setCycle('final', null, 'connect', 'final-test');
          break;
        case 'status':
          await loadReport(false);
          break;
        case 'update':
          await refreshBackup();
          {
            const nonce = await d.stageManagedUpgrade(reader, backup, release, true, {
              progress: onProgress,
            });
            setCycle('update', nonce, 'install', 'update');
          }
          break;
        case 'repair':
          await refreshBackup();
          await d.repairManagedPayload(reader, backup, release, {
            progress: onProgress,
          });
          await refreshBackup();
          message = 'Missing installer files restored and checked.';
          break;
        case 'disable':
        case 'remove': {
          const nonce = await d.queue(
            reader,
            action === 'remove' ? 'uninstall' : 'disable',
            config ?? settings({ ...defaults, ip: '100.64.0.1' }),
            backup,
          );
          setCycle('status', nonce, 'recovery', action);
          break;
        }
        case 'forget-session':
          resetting = true;
          await d.folderRecord(journal.id, null, true).catch(() => {});
          journal.start();
          storage?.removeItem(STORE);
          scope.location.replace(
            scope.location.pathname + scope.location.search + '#overview',
          );
          scope.location.reload();
          break;
      }
      record('completed', { durationMs: Date.now() - started });
      if (progress) {
        const completed = {
          backup: 'Kobo backup completed',
          'select-backup': 'Kobo backup completed',
          'prepare-folders': 'Folder setting saved',
          'prepare-collection': 'Collection files prepared',
          install: 'Installation files prepared',
          update: 'Update files prepared',
          return: 'Returned result and required checks completed',
          authorise: 'Connection request prepared',
          enable: 'Startup request prepared',
          endpoint: 'Sync address updated',
          repair: 'Installer files checked',
          status: 'Signed result verified',
        };
        progress = {
          ...progress,
          phase: completed[action] ?? 'Operation completed',
          currentFile: '',
          fraction: 1,
        };
      }
    } catch (e) {
      if (e.name !== 'AbortError') {
        error = { code: errorCode(e), message: e.message };
        record('failed-' + errorCode(e));
        if (e.name === 'NotAllowedError' && handles) permissionNeeded = true;
      } else {
        message =
          action === 'backup'
            ? 'Backup cancelled. Partial files were not accepted.'
            : 'Selection cancelled. Previous folder retained.';
        record('cancelled');
      }
      if (progress) {
        progress = {
          ...progress,
          phase: e.name === 'AbortError' ? 'Cancelled' : 'Failed',
          fraction: Number.isFinite(progress.fraction) ? progress.fraction : 0,
        };
        // Stop activity feedback before identity checks and diagnostic capture.
        emit();
      }
      if (reader && e.name !== 'NotAllowedError') {
        try {
          await identityCheck();
        } catch {
          identity = null;
          reader = null;
          trust = report = null;
          connectionHealthy =
            systemVerified =
            endpointCorrect =
            syncConfirmed =
            finalConfirmed =
              false;
          cycle = null;
        }
      }
    } finally {
      // Capture immediately after failure too; exporting never reruns device work.
      if (!resetting) await capture();
      busy = false;
      operation = null;
      if (!resetting) {
        persist();
        emit(true);
      }
    }
  }
  function dSettings(values) {
    return settings({
      ip: values.ip,
      ports: values.ports,
      hostname: values.hostname,
      tag: values.tag,
      owner: values.owner,
    });
  }
  async function init() {
    record('session-resumed');
    if (preview !== true) {
      try {
        release = await d.getRelease();
      } catch (e) {
        error = { code: 'release-unavailable', message: e.message };
      }
      try {
        collection = await d.collectionPackage();
      } catch {
        record('collection-unavailable');
      }
    }
    if (saved) {
      try {
        config = dSettings(form);
        if (saved.policyText) {
          policy = policyProposal(
            form['original-policy'],
            config,
            form.rewrite,
            form['extra-deny'],
          );
          policyConfirmed =
            saved.policyConfirmed === true &&
            policy.text === saved.policyText &&
            !policy.conflicts.length;
        }
      } catch {}
      try {
        handles = await d.folderRecord(journal.id);
      } catch {
        record('handle-storage-unavailable');
      }
      if (handles) {
        if (await d.folderPermission(handles, false)) {
          try {
            await selectReader(handles.reader);
            await selectBackup(handles.backup, false);
          } catch (e) {
            error = { code: 'resume-failed', message: e.message };
          }
        } else permissionNeeded = true;
      }
    }
    if (
      trust &&
      saved?.fingerprint === fingerprint &&
      saved.trustDigest === trust.digest &&
      endpointCorrect
    ) {
      syncConfirmed = saved.syncConfirmed === true;
      finalConfirmed = trust.status === 'healthy' && saved.finalConfirmed === true;
    }
    initialized = true;
    persist();
    await capture();
    emit(true);
  }
  return {
    init,
    getSnapshot: snapshot,
    run,
    consent,
    allowed,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    cancel() {
      if (operation?.cancellable) {
        cancel = true;
        record('cancellation-requested');
      }
    },
    journey(value) {
      if (
        busy ||
        (cycle && value !== 'recovery') ||
        !['managed', 'continue', 'recovery'].includes(value)
      )
        return;
      journey = value;
      error = null;
      persist();
      emit(true);
    },
    editForm(input) {
      if (busy) return;
      form = {
        ...defaults,
        ...Object.fromEntries(
          Object.entries(input).filter(([key]) => Object.hasOwn(defaults, key)),
        ),
      };
      policyConfirmed = false;
      policy = null;
      config = null;
      connectionHealthy = false;
      persist();
      emit(true);
    },
  };
}
