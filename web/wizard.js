// The view requests adapter actions; it never manufactures verified completion.
import { createWizardAdapter } from './lib/wizard-adapter.js';
import { diagnosticJournal } from './lib/wizard-log.js';
import { STAGES } from './lib/wizard-view.js';
import { attachValidation } from './lib/form-validation.js';
const $ = (id) => document.getElementById(id);
let storage;
try {
  storage = window.sessionStorage;
} catch {}
const journal = diagnosticJournal(storage);
const previewMode =
  document.querySelector('meta[name="kobold-site-mode"]')?.content === 'preview';
const adapter = createWizardAdapter({
  journal,
  storage,
  scope: window,
  preview: previewMode,
});
let snapshot = adapter.getSnapshot(),
  overview = !location.hash || location.hash === '#overview',
  reviewStep = null;
let formLoaded = false,
  example = false,
  editing = false,
  pendingConsent = null,
  shownCycle = null,
  selectedLog = journal.id,
  lastStep = null;
const names = [
  'Reader & backup',
  'Tailscale settings',
  'Install',
  'Connect',
  'Complete',
];
const art = (step) =>
  ({
    reader: 'tunnel',
    network: 'network',
    install: 'install',
    connect: 'network',
    complete: 'emblem',
    recovery: 'emblem',
  })[step] ?? 'tunnel';
const bytes = (n) =>
  !Number.isFinite(n)
    ? 'Not measured'
    : n < 1024
      ? n + ' B'
      : n < 1048576
        ? (n / 1024).toFixed(1) + ' KiB'
        : (n / 1048576).toFixed(1) + ' MiB';
function setText(id, text) {
  $(id).textContent = text ?? '';
}
function showError(e) {
  $('action-error').hidden = false;
  setText('action-error', e.message);
}
function renderLogs() {
  $('show-log').checked = journal.show;
  $('diagnostic-panel').hidden = !journal.show;
  const sessions = journal.list();
  if (!sessions.some((s) => s.id === selectedLog)) selectedLog = journal.id;
  $('log-session').replaceChildren(
    ...sessions.map((s, i) => {
      const option = document.createElement('option');
      option.value = s.id;
      option.textContent = `Session ${i + 1} · ${new Date(s.started).toLocaleTimeString()}${s.id === journal.id ? ' · current' : ''}`;
      option.selected = s.id === selectedLog;
      return option;
    }),
  );
  const data = JSON.parse(journal.export(selectedLog)).session;
  setText(
    'diagnostic-log',
    data?.events
      .map(
        (e) =>
          `${new Date(e.time).toLocaleTimeString()}  ${e.step}  ${e.code}${e.totalFiles !== undefined ? `  ${e.completedFiles ?? 0}/${e.totalFiles} files` : ''}`,
      )
      .join('\n') || 'No recorded events in this session.',
  );
  $('storage-notice').hidden = !journal.warning;
  setText('storage-warning', journal.warning);
}
function render(s) {
  const resumedPermission = snapshot.permissionNeeded && !s.permissionNeeded;
  snapshot = s;
  if (resumedPermission) shownCycle = null;
  const v =
      example && !s.reader
        ? {
            step: 'network',
            action: 'review-policy',
            label: 'Review proposed policy',
            title: 'Review an example policy',
            instruction: s.preview
              ? 'Enter your server details and review a policy proposal. Folder selection is not required for policy review.'
              : 'Prepare an example policy. Select a Kobo and backup folder before starting setup.',
          }
        : s.busy && s.operation?.view
          ? s.operation.view
          : s.view,
    step = reviewStep ?? v.step;
  $('overview').hidden = !overview;
  $('wizard-current').hidden = overview;
  $('browser-notice').hidden = s.fileAccess;
  $('device-label').textContent = s.reader
    ? `${s.reader.model} · ${s.reader.firmware}`
    : 'No Kobo selected';
  $('preview-notice').hidden = !s.preview;
  $('availability').textContent = s.preview
    ? 'This site provides Kobo backups and Tailscale policy review. Installation, updates and device status checks are unavailable.'
    : s.releaseAllowsInstall
      ? 'This package permits installation on the supported model after its required checks.'
      : 'Fresh installation is unavailable in this package. Backups, policy preparation and supported existing-installation actions remain available.';
  if (!formLoaded && s.initialized) {
    for (const [key, value] of Object.entries(s.form)) {
      if (key === 'rewrite') $('rewrite').checked = value;
      else if ($(key)) $(key).value = value;
    }
    formLoaded = true;
  }
  const visibleStages = s.preview ? STAGES.slice(0, 2) : STAGES;
  $('wizard-steps').replaceChildren(
    ...visibleStages.map((key, index) => {
      const li = document.createElement('li'),
        button = document.createElement('button');
      const currentIndex = visibleStages.indexOf(v.step),
        completed =
          currentIndex > index &&
          v.step !== 'recovery' &&
          {
            reader:
              !!s.reader &&
              !!s.backupFolder &&
              (s.backupVerified || s.backupPreviouslyVerified || s.backupSkipped),
            network: s.policyConfirmed,
            install: s.active && s.systemVerified,
            connect: s.finalConfirmed,
          }[key] === true;
      button.textContent =
        (completed ? '✓ ' : `${index + 1}. `) +
        (s.preview && key === 'network' ? 'Policy review' : names[STAGES.indexOf(key)]);
      if (step === key && !overview) button.setAttribute('aria-current', 'step');
      button.disabled = s.busy || (!completed && key !== v.step);
      button.onclick = () => {
        overview = false;
        reviewStep = completed ? key : null;
        render(snapshot);
      };
      li.append(button);
      return li;
    }),
  );
  if (step !== lastStep) {
    const nav = $('wizard-steps'),
      current = nav.querySelector('[aria-current=step]');
    if (current) nav.scrollLeft = Math.max(0, current.offsetLeft - nav.offsetLeft - 12);
    lastStep = step;
  }
  $('wizard-current').classList.toggle('wizard-existing', !!v.existingSummary);
  $('installation-banner').hidden = !v.existingSummary || !!reviewStep;
  $('stage-art').hidden = !!v.existingSummary && !reviewStep;
  $('wizard-steps').parentElement.hidden = !!v.existingSummary;
  $('open-management').hidden = !!v.existingSummary || s.preview;
  $('open-recovery').hidden = !!v.existingSummary || s.preview;
  if (v.existingSummary) {
    const li = document.createElement('li'),
      button = document.createElement('button');
    button.textContent = 'Your installation';
    button.setAttribute('aria-current', 'step');
    button.disabled = s.busy;
    li.append(button);
    $('wizard-steps').replaceChildren(li);
  }
  setText(
    'step-label',
    v.existingSummary
      ? 'EXISTING INSTALLATION'
      : step === 'recovery'
        ? 'RECOVERY'
        : `STEP ${visibleStages.indexOf(step) + 1} OF ${visibleStages.length}`,
  );
  setText(
    'task-title',
    reviewStep ? names[STAGES.indexOf(step)] + ' completed' : v.title,
  );
  setText(
    'task-instruction',
    reviewStep
      ? 'This step is complete. Return to the current step to continue.'
      : v.existingSummary && !s.error
        ? 'Installation verified. Automatic startup verified.'
        : v.instruction,
  );
  setText(
    'operation-title',
    reviewStep || v.management || step === 'recovery'
      ? ''
      : s.busy
        ? (s.operation?.view?.label ?? 'Current operation')
        : v.label,
  );
  setText(
    'operation-instruction',
    step !== 'reader'
      ? ''
      : !s.reader
        ? 'Model and firmware checks start automatically after you choose the Kobo USB drive.'
        : !s.backupFolder
          ? 'Backup discovery and the required checks start automatically after folder selection.'
          : '',
  );
  const image = art(step),
    width = image === 'emblem' ? 320 : 640;
  $('stage-art').src = `assets/images/${image}-${width}.webp`;
  $('stage-art').classList.toggle('wizard-emblem', image === 'emblem');
  const completed = [];
  if (s.backupVerified) completed.push('✓ Kobo backup verified');
  else if (s.backupPreviouslyVerified)
    completed.push('Backup selected; checks repeat before changes');
  if (s.policyConfirmed) completed.push('✓ Policy confirmed');
  if (s.scan === 'ready') completed.push('✓ Library folders prepared');
  if (s.collectionReady || s.systemVerified) completed.push('✓ System backup verified');
  if (s.active) completed.push('✓ Installation verified');
  if (s.connectionHealthy) completed.push('✓ Connection verified');
  if (s.startupVerified) completed.push('✓ Automatic startup verified');
  $('completed-summary').replaceChildren(
    ...completed.map((text) => {
      const item = document.createElement('span');
      item.textContent = text;
      return item;
    }),
  );
  $('folder-summary').replaceChildren();
  for (const [label, folder, action] of [
    ['Kobo', s.reader?.folder, 'select-reader'],
    ['Backup', s.backupFolder, 'select-backup'],
  ]) {
    if (!folder) continue;
    const item = document.createElement('span');
    item.textContent = `${label}: ${folder} `;
    const button = document.createElement('button');
    button.className = 'text-button';
    button.textContent = 'Change';
    button.disabled = s.busy;
    button.onclick = () => execute(action);
    item.append(button);
    $('folder-summary').append(item);
  }
  $('installation-details').hidden =
    !completed.length && !$('folder-summary').childElementCount;
  const network = !reviewStep && (step === 'network' || example);
  $('network-form').hidden = !network || (!!s.policy && !editing);
  $('edit-settings').hidden = !network || !s.policy;
  $('network-summary').hidden = !network || !s.policy;
  setText(
    'network-summary',
    s.policy
      ? `Server: ${s.form.ip} · Ports: ${s.form.ports} · Hostname: ${s.form.hostname}`
      : '',
  );
  $('policy-review').hidden = !network || !s.policy;
  if (s.policy) {
    $('proposed-policy').value = s.policy.text;
    setText(
      'policy-findings',
      s.policy.findings.join('\n') ||
        'Review the policy below, then validate and save it in Tailscale.',
    );
    $('policy-ack').disabled = s.busy || s.policyConfirmed || s.policy.conflicts > 0;
    $('policy-ack').checked = s.policyConfirmed;
  }
  for (const field of $('network-form').querySelectorAll('input,textarea'))
    field.disabled = s.busy;
  $('management-options').hidden = !v.management || !!reviewStep;
  $('managed-status').textContent =
    {
      healthy: 'Automatic startup verified.',
      installed: 'Installation verified.',
      prepared: 'Installation preparation verified.',
      disabled: 'Automatic startup is disabled.',
      removed: 'Automatic startup integration was removed.',
    }[s.trust?.status] ?? 'A signed result has not been verified.';
  $('recovery-options').hidden = v.step !== 'recovery' || !!reviewStep;
  for (const [id, action] of [
    ['read-status', 'status'],
    ['prepare-update', 'update'],
    ['repair-files', 'repair'],
    ['disable-startup', 'disable'],
    ['remove-startup', 'remove'],
  ])
    $(id).disabled = s.busy || !adapter.allowed(action);
  $('manage-recovery').disabled = s.busy;
  $('continue-setup').disabled = s.busy || !s.trust;
  $('continue-setup').hidden = true;
  $('prepare-update').hidden = !s.updateAvailable;
  setText('action-message', s.busy ? '' : v.management ? '' : s.message);
  $('action-error').hidden = !s.error;
  if (s.error) setText('action-error', s.error.message);
  const reserveProgress =
    !overview &&
    !reviewStep &&
    !v.management &&
    ['reader', 'install', 'connect', 'recovery'].includes(step);
  $('wizard-progress').hidden =
    (v.management && !s.busy) ||
    (!reserveProgress && (!s.progress || !!reviewStep || s.progress.step !== step));
  $('wizard-progress').classList.toggle(
    'wizard-progress-readonly',
    v.management ||
      ['status', 'select-reader', 'resume-access'].includes(s.operation?.action),
  );
  $('wizard-progress').setAttribute('aria-busy', String(s.busy));
  if (reserveProgress || s.progress) {
    const p = s.progress?.step === step ? s.progress : { phase: 'Ready', fraction: 0 };
    setText('progress-phase', p.phase);
    setText(
      'progress-file',
      p.currentFile
        ? 'Current file: ' + p.currentFile
        : p.phase === 'Ready'
          ? 'Current file: Waiting to start'
          : 'Operation: ' + p.phase,
    );
    setText(
      'progress-file-bytes',
      p.fileSize !== undefined
        ? `File progress: ${bytes(p.fileBytes ?? 0)} of ${bytes(p.fileSize)}`
        : 'File progress: Not yet measured',
    );
    setText(
      'progress-count',
      p.totalFiles !== undefined
        ? `Files: ${p.completedFiles ?? 0} of ${p.totalFiles}`
        : p.scannedFiles !== undefined
          ? `Files found: ${p.scannedFiles}`
          : 'Files: Counting when available',
    );
    setText(
      'progress-bytes',
      p.totalBytes !== undefined
        ? `Copied: ${bytes(p.copiedBytes ?? 0)} of ${bytes(p.totalBytes)}`
        : 'Copied: Not yet measured',
    );
    $('progress-file-bytes').hidden = p.fileSize === undefined;
    $('progress-count').hidden =
      p.totalFiles === undefined && p.scannedFiles === undefined;
    $('progress-bytes').hidden = p.totalBytes === undefined;
    if (p.fraction === null) {
      $('progress-bar').removeAttribute('value');
      setText('progress-percent', '');
    } else {
      $('progress-bar').value = p.fraction;
      setText('progress-percent', Math.floor(p.fraction * 100) + '%');
    }
  }
  $('device-inline').hidden = !s.cycle || !!reviewStep;
  if (s.cycle) setText('device-inline-text', s.cycle.instructions.join(' '));
  $('wizard-primary').hidden =
    (!!s.cycle && v.action === 'return') ||
    (!v.action && !reviewStep) ||
    (network && !!s.policy && !editing);
  $('wizard-primary').textContent = reviewStep
    ? 'Return to current step'
    : s.busy
      ? 'Working…'
      : v.label;
  $('wizard-primary').disabled =
    s.busy ||
    (!reviewStep &&
      (!v.action ||
        !adapter.allowed(v.action) ||
        (!s.fileAccess && v.action !== 'review-policy')));
  $('cancel-operation').hidden = !s.operation?.cancellable;
  $('reader-options').hidden = step !== 'reader' || !s.backupFolder || !!s.cycle;
  $('another-backup').hidden = !s.backupVerified;
  $('another-backup').disabled = s.busy;
  $('skip-options').hidden = s.backupVerified || !adapter.allowed('skip-backup');
  $('collection-files-link').hidden = !s.collectionFiles.length || step !== 'install';
  $('open-management').disabled = s.busy || !s.reader;
  $('open-recovery').disabled = s.busy;
  if (
    s.cycle &&
    !s.permissionNeeded &&
    s.journey !== 'recovery' &&
    !s.busy &&
    !overview &&
    s.cycle.id !== shownCycle
  )
    openDeviceDialog();
  renderLogs();
}
const validate = attachValidation($('network-form'));
function formInput() {
  return {
    ...Object.fromEntries(new FormData($('network-form'))),
    rewrite: $('rewrite').checked,
  };
}
const consentText = {
  'prepare-folders':
    'Save and back up the folder setting on this Kobo. You must fully restart before installation files are copied.',
  migrate:
    'Migrate this installation using the signed package. Keep the full backup. Existing Tailscale registration will be retained. An interrupted update can require recovery.',
  'prepare-collection':
    'Install a signed collection helper before saving its system backup. Let its update finish before reconnecting. An interrupted update can require recovery.',
  install:
    'Install Tailscale on this supported Kobo. The required backup and signed files will be checked first. An interrupted firmware update can require recovery.',
  authorise:
    'Prepare a Tailscale check or sign-in request on this Kobo. Disconnect and reconnect as instructed.',
  endpoint:
    'Back up the current configuration and update its existing sync address to the server you selected.',
  enable:
    'Prepare automatic startup after your successful sync test. Signed verification will follow.',
  update:
    'Back up this managed installation and apply the authenticated supported update. Existing enrolment and identity will be retained.',
  repair:
    'Restore only missing managed installer files from the authenticated matching release. Changed or unknown files will not be overwritten.',
  disable:
    'Disable automatic startup. Restart the Kobo afterward to stop the current connection.',
  remove:
    'Remove automatic startup integration. Client files, books, settings and registration will be retained.',
  'skip-backup':
    'Continuing without a matching Kobo backup increases the risk of losing books, settings or reading progress. A system backup is still required.',
  'save-system': 'Save and verify the system backup and acknowledge it on the Kobo.',
  'confirm-policy':
    'Back up your current Tailscale policy first. Incorrect changes can interrupt device access. Confirm only after Tailscale has accepted the saved policy and tests.',
};
async function execute(action, extra = {}) {
  if (!action) return;
  if (action === 'review-policy') {
    if (!validate()) return;
    extra.input = formInput();
  }
  if (consentText[action]) {
    pendingConsent = { action, extra, guardRevision: snapshot.guardRevision };
    setText(
      'consent-title',
      action === 'confirm-policy'
        ? 'Confirm the Tailscale policy'
        : 'Approve this action',
    );
    setText('consent-description', consentText[action]);
    setText(
      'consent-ack-text',
      action === 'confirm-policy'
        ? 'I saved a policy backup and Tailscale accepted the policy and tests.'
        : 'I approve this action for the selected Kobo.',
    );
    $('consent-ack').checked = false;
    $('consent-accept').disabled = true;
    $('wizard-consent').showModal();
    return;
  }
  try {
    await adapter.run(action, { guardRevision: snapshot.guardRevision, ...extra });
  } catch (e) {
    showError(e);
  }
}
function openDeviceDialog() {
  const c = snapshot.cycle;
  if (!c) return;
  shownCycle = c.id;
  $('device-ack').checked = false;
  $('device-next').disabled = true;
  setText('device-dialog-title', c.title);
  setText('device-ack-text', c.acknowledgement);
  $('device-instructions').replaceChildren(
    ...c.instructions.map((text) => {
      const li = document.createElement('li');
      li.textContent = text;
      return li;
    }),
  );
  $('device-dialog-art').src =
    `assets/images/${art(c.step)}-${art(c.step) === 'emblem' ? 320 : 640}.webp`;
  if (!$('wizard-device-dialog').open) $('wizard-device-dialog').showModal();
}
$('wizard-primary').onclick = () => {
  if (reviewStep) {
    reviewStep = null;
    render(snapshot);
  } else execute(example && !snapshot.reader ? 'review-policy' : snapshot.view.action);
};
$('get-started').onclick = () => {
  overview = false;
  reviewStep = null;
  history.replaceState(null, '', '#setup');
  render(snapshot);
};
$('edit-settings').onclick = () => {
  editing = true;
  render(snapshot);
  $('ip').focus();
};
$('network-form').onsubmit = (e) => {
  e.preventDefault();
  execute('review-policy');
};
$('network-form').addEventListener('input', () => {
  setText('copy-policy-status', '');
  adapter.editForm(formInput());
});
$('policy-ack').onchange = () => {
  if ($('policy-ack').checked) {
    $('policy-ack').checked = false;
    execute('confirm-policy');
  }
};
$('consent-ack').onchange = () => {
  $('consent-accept').disabled = !$('consent-ack').checked;
};
$('consent-cancel').onclick = () => $('wizard-consent').close();
$('consent-accept').onclick = async () => {
  if (!$('consent-ack').checked || !pendingConsent) return;
  const request = pendingConsent;
  pendingConsent = null;
  $('wizard-consent').close();
  try {
    if (request.guardRevision !== snapshot.guardRevision)
      throw Error('Setup changed. Review the action again.');
    const consent =
      request.action === 'confirm-policy' ? undefined : adapter.consent(request.action);
    await adapter.run(request.action, {
      guardRevision: snapshot.guardRevision,
      consent,
      acknowledged: true,
      ...request.extra,
    });
  } catch (e) {
    showError(e);
  }
};
$('device-ack').onchange = () => {
  $('device-next').disabled = !$('device-ack').checked;
};
$('device-next').onclick = () => {
  if (!$('device-ack').checked || !snapshot.cycle) return;
  const cycleId = snapshot.cycle.id;
  $('wizard-device-dialog').close();
  execute('return', { cycleId, acknowledged: true });
};
$('close-device-dialog').onclick = () => $('wizard-device-dialog').close();
$('show-device-instructions').onclick = openDeviceDialog;
$('cancel-operation').onclick = () => adapter.cancel();
$('another-backup').onclick = () => execute('backup');
$('skip-backup').onclick = () => execute('skip-backup');
$('read-status').onclick = () => execute('status');
$('prepare-update').onclick = () => execute('update');
$('continue-setup').onclick = () => adapter.journey('continue');
$('repair-files').onclick = () => execute('repair');
$('disable-startup').onclick = () => execute('disable');
$('remove-startup').onclick = () => execute('remove');
$('open-management').onclick = () => {
  overview = false;
  reviewStep = null;
  adapter.journey('managed');
};
$('open-recovery').onclick = () => {
  overview = false;
  reviewStep = null;
  adapter.journey('recovery');
  render(snapshot);
};
$('manage-recovery').onclick = $('open-recovery').onclick;
$('export-storage-log').onclick = () => $('download-log').click();
$('collection-files-link').onclick = () => {
  $('collection-files').textContent = snapshot.collectionFiles.join('\n');
  $('collection-files-dialog').showModal();
};
$('close-collection-files').onclick = () => $('collection-files-dialog').close();
$('show-log').onchange = () => journal.setVisible($('show-log').checked);
$('log-session').onchange = () => {
  selectedLog = $('log-session').value;
  renderLogs();
};
async function copy(text, target) {
  try {
    await navigator.clipboard.writeText(text);
    setText(target, 'Copied!');
  } catch {
    setText(target, 'Could not copy. Download the report or select and copy the text.');
  }
}
$('copy-policy').onclick = () =>
  copy(snapshot.policy?.text ?? '', 'copy-policy-status');
$('copy-log').onclick = () => copy(journal.export(selectedLog), 'log-feedback');
$('download-log').onclick = () => {
  const url = URL.createObjectURL(
    new Blob([journal.export(selectedLog)], { type: 'application/json' }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = 'kobold-bug-report.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
$('clear-logs').onclick = () => {
  if (
    window.confirm(
      'Clear all diagnostic sessions in this tab? Setup progress is retained.',
    )
  ) {
    journal.clear();
    selectedLog = journal.id;
    renderLogs();
  }
};
$('example-policy').onclick = () => {
  overview = false;
  example = true;
  reviewStep = null;
  $('ip').value = '100.101.102.103';
  $('original-policy').value = '{}';
  render({
    ...snapshot,
    view: {
      step: 'network',
      action: 'review-policy',
      label: 'Review proposed policy',
      title: 'Review an example policy',
      instruction:
        'Example settings only. Select a Kobo and backup folder before starting setup.',
    },
  });
};
async function forget() {
  try {
    await adapter.run('forget-session', { guardRevision: snapshot.guardRevision });
  } catch (e) {
    showError(e);
  }
}
window.addEventListener('hashchange', () => {
  if (location.hash === '#forgetsession') forget();
  else if (location.hash === '#overview') {
    overview = true;
    render(snapshot);
  }
});
window.addEventListener('error', () => journal.record('browser', 'uncaught-error'));
window.addEventListener('unhandledrejection', () =>
  journal.record('browser', 'unhandled-rejection'),
);
adapter.subscribe((s) => {
  if (example && s.reader) example = false;
  if (s.policy && !snapshot.policy) editing = false;
  render(s);
});
journal.subscribe(renderLogs);
render(snapshot);
await adapter.init();
if (location.hash === '#forgetsession') await forget();

setInterval(() => render(adapter.getSnapshot()), 30000);
