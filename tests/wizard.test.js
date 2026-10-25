import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnosticJournal } from '../web/lib/wizard-log.js';
import { wizardView, deviceCycle } from '../web/lib/wizard-view.js';
import { createWizardAdapter } from '../web/lib/wizard-adapter.js';
const memory = () => {
  const m = new Map();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => m.set(k, v),
    removeItem: (k) => m.delete(k),
  };
};
const scope = {
  isSecureContext: true,
  FileSystemFileHandle: { prototype: { createWritable() {} } },
  showDirectoryPicker() {},
  location: { pathname: '/', search: '', replace() {}, reload() {} },
};
test('diagnostics collect while hidden and keep session identity/history over refresh', () => {
  const storage = memory(),
    first = diagnosticJournal(storage);
  first.record('backup', 'started', {
    path: 'PRIVATE/book.epub',
    message: 'TOKEN',
    completedFiles: 2,
    totalFiles: 5,
  });
  const next = diagnosticJournal(storage);
  assert.equal(next.id, first.id);
  assert.equal(next.show, false);
  assert.equal(next.list()[0].events, 1);
  next.setVisible(true);
  assert.equal(diagnosticJournal(storage).show, true);
  const old = next.id;
  next.start();
  assert.notEqual(next.id, old);
  assert.equal(next.list().length, 2);
  assert(!next.export(old).includes('PRIVATE'));
  assert(!next.export(old).includes('TOKEN'));
  next.evidence({
    identitySha256: 'PRIVATE',
    reports: {
      secret: {
        status: { state: 'Running', healthCount: 0, rawKey: 'TOKEN' },
        receipt: { verified: true, sequence: 7, publicKey: 'SECRET' },
      },
    },
  });
  assert(!next.export().includes('TOKEN'));
  assert(!next.export().includes('SECRET'));
  assert(!next.export().includes('PRIVATE'));
  assert(next.export().includes('Running'));
});
test('diagnostic limits are explicit and clear does not rotate workflow identity', () => {
  const j = diagnosticJournal(memory());
  for (let n = 0; n < 1602; n++) j.record('backup', 'progress');
  assert(j.warning);
  assert.equal(j.list()[0].omitted, 2);
  const id = j.id;
  j.clear();
  assert.equal(j.id, id);
  assert.equal(j.list()[0].events, 0);
});
test('USB cycles require distinct identities; verified startup is separate from preparation', () => {
  const a = deviceCycle('install', 'a', 'install'),
    b = deviceCycle('status', 'b', 'connect');
  assert.notEqual(a.id, b.id);
  assert(a.acknowledgement);
  assert(b.instructions.join(' ').includes('not normally'));
  const s = {
    initialized: true,
    reader: {},
    backupFolder: 'backup',
    backupVerified: true,
    policyConfirmed: true,
    supported: true,
    releaseAllowsInstall: true,
    scan: 'ready',
    collectionReady: true,
  };
  assert.equal(wizardView(s).action, 'install');
  s.active = true;
  s.systemVerified = true;
  s.configured = true;
  s.connectionHealthy = true;
  s.endpointCorrect = true;
  s.syncConfirmed = true;
  assert.equal(wizardView(s).action, 'enable');
  s.startupVerified = true;
  assert.equal(wizardView(s).action, 'final-test');
  s.finalConfirmed = true;
  assert.equal(wizardView(s).step, 'complete');
});
test('refresh restores folder permissions without triggering backups or staging', async () => {
  const storage = memory(),
    j = diagnosticJournal(storage);
  let writes = 0,
    pickers = 0;
  storage.setItem(
    'kobold.wizard.v1',
    JSON.stringify({ sessionId: j.id, form: {}, journey: 'new' }),
  );
  const adapter = createWizardAdapter({
    journal: j,
    storage,
    scope: {
      ...scope,
      showDirectoryPicker() {
        pickers++;
      },
    },
    dependencies: {
      getRelease: async () => {
        throw Error('Unavailable');
      },
      collectionPackage: async () => null,
      folderRecord: async () => ({ reader: {}, backup: {} }),
      folderPermission: async () => false,
      backupReader: async () => writes++,
      stage: async () => writes++,
    },
  });
  await adapter.init();
  assert.equal(adapter.getSnapshot().permissionNeeded, true);
  assert.equal(writes, 0);
  assert.equal(pickers, 0);
  assert(Object.isFrozen(adapter.getSnapshot().form));
  await assert.rejects(
    adapter.run('backup', { guardRevision: adapter.getSnapshot().guardRevision }),
    /unavailable/,
  );
});
test('typed policy inputs invalidate stale action guards without exposing policy in logs', async () => {
  const storage = memory(),
    journal = diagnosticJournal(storage),
    a = createWizardAdapter({
      journal,
      storage,
      scope,
      dependencies: {
        getRelease: async () => {
          throw Error('No release');
        },
        collectionPackage: async () => null,
      },
    });
  await a.init();
  const stale = a.getSnapshot().guardRevision;
  a.editForm({ hostname: 'changed', privateKey: 'SECRET' });
  assert(!('privateKey' in a.getSnapshot().form));
  await assert.rejects(
    a.run('review-policy', { guardRevision: stale, input: {} }),
    /changed/,
  );
  await a.run('review-policy', {
    guardRevision: a.getSnapshot().guardRevision,
    input: {
      ip: '100.101.102.103',
      ports: '8083',
      hostname: 'kobo-reader',
      tag: 'tag:kobo-sync',
      owner: 'autogroup:admin',
      'original-policy': '{}',
      'extra-deny': '',
      rewrite: false,
    },
  });
  assert(a.getSnapshot().policy);
  assert(!journal.export().includes('100.101'));
  assert(!journal.export().includes('tag:kobo'));
  const rev = a.getSnapshot().guardRevision;
  await a.run('confirm-policy', { guardRevision: rev, acknowledged: true });
  assert(a.getSnapshot().policyConfirmed);
});

test('managed status reads never run backups; consent and serial execution protect queued jobs', async () => {
  const { fixture, put } = await import('./memory-fs.js');
  const { backupReader } = await import('../web/lib/storage.js');
  const { reader, backup: root } = await fixture();
  await put(reader, '.adds/kobold/releases/0.1.0/SHA256SUMS', 'fixture');
  await backupReader(reader, root);
  const storage = memory(),
    journal = diagnosticJournal(storage);
  let backups = 0,
    jobs = 0,
    reads = 0,
    pickerSync = false;
  const release = {
    profile: { id: 'fixture' },
    continuation: {
      purpose: 'upgrade-managed-install',
      previous: { installationDescriptorSha256: 'old' },
    },
  };
  const status = {
    BackendState: 'Running',
    Health: [],
    Self: { Tags: ['tag:kobo-sync'] },
  };
  const a = createWizardAdapter({
    journal,
    storage,
    scope: {
      ...scope,
      showDirectoryPicker: () => {
        pickerSync = true;
        return Promise.resolve(reader);
      },
    },
    dependencies: {
      getRelease: async () => release,
      collectionPackage: async () => null,
      folderRecord: async () => null,
      scanPreparation: async () => ({ state: 'ready' }),
      collectDiagnostics: async () => ({ reports: {} }),
      readVerifiedReport: async () => {
        reads++;
        return {
          report: { id: 'a'.repeat(32), status },
          trust: { status: 'installed', descriptor: 'old', sequence: 2 },
          active: release,
        };
      },
      connectionInstallation: () => true,
      requireSystemBackup: async () => 'hash',
      updateBackup: async () => {
        backups++;
        throw Error('Do not back up on read');
      },
      endpointMatches: async () => true,
    },
  });
  await a.init();
  const selected = a.run('select-reader', {
    guardRevision: a.getSnapshot().guardRevision,
  });
  assert(pickerSync, 'Picker must open synchronously');
  await selected;
  // Reuse the reader picker callback for the selected backup destination.
  // The adapter receives handles only through its browser boundary.
  const original = scope.showDirectoryPicker;
  void original;
  // Dedicated scope reference for a second adapter reproduces actual two picks.
  const picks = [reader, root];
  const b = createWizardAdapter({
    journal: diagnosticJournal(memory()),
    storage: memory(),
    scope: { ...scope, showDirectoryPicker: () => Promise.resolve(picks.shift()) },
    dependencies: {
      getRelease: async () => release,
      collectionPackage: async () => null,
      folderRecord: async () => null,
      scanPreparation: async () => ({ state: 'ready' }),
      collectDiagnostics: async () => ({ reports: {} }),
      readVerifiedReport: async () => {
        reads++;
        return {
          report: { id: 'a'.repeat(32), status },
          trust: { status: 'installed', descriptor: 'old', sequence: 2 },
          active: release,
        };
      },
      connectionInstallation: () => true,
      requireSystemBackup: async () => 'hash',
      updateBackup: async () => {
        backups++;
        throw Error('No scan on status');
      },
      endpointMatches: async () => true,
      queue: async () => {
        jobs++;
        return 'a'.repeat(32);
      },
    },
  });
  await b.init();
  await b.run('select-reader', { guardRevision: b.getSnapshot().guardRevision });
  await b.run('select-backup', { guardRevision: b.getSnapshot().guardRevision });
  await b.run('status', { guardRevision: b.getSnapshot().guardRevision });
  assert.equal(backups, 0);
  assert(reads >= 2);
  assert(b.getSnapshot().trust);
  await assert.rejects(
    b.run('disable', { guardRevision: b.getSnapshot().guardRevision }),
    /Approve/,
  );
  const token = b.consent('disable');
  await b.run('disable', {
    guardRevision: b.getSnapshot().guardRevision,
    consent: token,
  });
  assert.equal(jobs, 1);
  const cycle = b.getSnapshot().cycle;
  await assert.rejects(
    b.run('return', {
      guardRevision: b.getSnapshot().guardRevision,
      cycleId: cycle.id,
      acknowledged: false,
    }),
    /Confirm/,
  );
  await assert.rejects(
    b.run('return', {
      guardRevision: b.getSnapshot().guardRevision,
      cycleId: 'wrong',
      acknowledged: true,
    }),
    /Confirm/,
  );
  assert.equal(jobs, 1);
});

test('forget starts a distinct log session without resurrecting old workflow form', async () => {
  const storage = memory(),
    j = diagnosticJournal(storage),
    old = j.id;
  const a = createWizardAdapter({
    journal: j,
    storage,
    scope,
    dependencies: {
      getRelease: async () => {
        throw Error('No release');
      },
      collectionPackage: async () => null,
      folderRecord: async () => null,
    },
  });
  await a.init();
  a.editForm({ hostname: 'private-old-name' });
  await a.run('forget-session', { guardRevision: a.getSnapshot().guardRevision });
  assert.equal(storage.getItem('kobold.wizard.v1'), null);
  assert.notEqual(j.id, old);
  assert(j.list().some((x) => x.id === old));
});
test('pending USB cycle does not hide permission recovery or allow unchecked advancement', () => {
  const s = {
    initialized: true,
    reader: {},
    backupFolder: 'backup',
    permissionNeeded: true,
    cycle: deviceCycle('install', 'cycle1', 'install'),
  };
  assert.equal(wizardView(s).action, 'resume-access');
  s.permissionNeeded = false;
  assert.equal(wizardView(s).action, 'return');
  s.journey = 'recovery';
  assert.equal(wizardView(s).step, 'recovery');
});

test('managed-update retained enrolment checks status first, but NeedsLogin permits enrol', async () => {
  const { nextConnectionJob } = await import('../web/lib/wizard-view.js');
  assert.equal(
    nextConnectionJob({
      existingEnrollment: true,
      status: null,
      signin: null,
      opened: false,
    }),
    'status',
  );
  assert.equal(
    nextConnectionJob({
      existingEnrollment: true,
      status: { BackendState: 'NeedsLogin' },
      signin: null,
      opened: false,
    }),
    'enrol',
  );
  assert.equal(
    nextConnectionJob({
      existingEnrollment: true,
      status: { BackendState: 'Running' },
      signin: null,
      opened: false,
    }),
    'status',
  );
  assert.equal(
    nextConnectionJob({
      existingEnrollment: true,
      status: { BackendState: 'NeedsLogin' },
      signin: 'verified-link',
      opened: true,
    }),
    'status',
  );
});

test('folder checks emit descriptive progress immediately and hold the current screen', async () => {
  const storage = memory(),
    journal = diagnosticJournal(storage),
    states = [];
  const a = createWizardAdapter({
    journal,
    storage,
    scope: { ...scope, showDirectoryPicker: () => Promise.resolve({ name: 'KOBO' }) },
    dependencies: {
      getRelease: async () => {
        throw Error('No release');
      },
      collectionPackage: async () => null,
      readText: async () => 'fixture',
      identify: () => ({ matched: true, model: 'Kobo', firmware: 'fixture' }),
      fileHandle: async () => ({ getFile: async () => new Blob(['fixture']) }),
      hashFile: async () => 'f'.repeat(64),
      exists: async () => false,
    },
  });
  await a.init();
  a.subscribe((s) => states.push(s));
  await a.run('select-reader', { guardRevision: a.getSnapshot().guardRevision });
  assert(
    states.some((s) => s.busy && s.progress?.phase.includes('Reading the Kobo model')),
  );
  assert(
    states.some(
      (s) => s.busy && s.progress?.phase.includes('Checking installed setup files'),
    ),
  );
  assert(states.filter((s) => s.busy).every((s) => s.operation.view.step === 'reader'));
  assert(states.filter((s) => s.busy).every((s) => s.progress?.step === 'reader'));
});
test('known verification totals advance and unknown scans remain indeterminate', async () => {
  const { fixture } = await import('./memory-fs.js');
  const { reader, backup } = await fixture();
  const picks = [reader, backup];
  const storage = memory(),
    journal = diagnosticJournal(storage),
    seen = [];
  const a = createWizardAdapter({
    journal,
    storage,
    scope: { ...scope, showDirectoryPicker: () => Promise.resolve(picks.shift()) },
    dependencies: {
      getRelease: async () => {
        throw Error('No package');
      },
      collectionPackage: async () => null,
      folderRecord: async () => null,
      scanPreparation: async () => ({ state: 'needed' }),
      discoverBackups: async () => ({ matches: [] }),
      collectDiagnostics: async () => ({ reports: {} }),
      updateBackup: async (r, b, old, paint) => {
        await paint({ phase: 'scanning', scannedFiles: 3, fraction: null });
        await paint({
          phase: 'verifying-backup',
          totalFiles: 2,
          completedFiles: 0,
          fileBytes: 50,
          fileSize: 100,
          fraction: null,
        });
        await new Promise((r) => setTimeout(r, 55));
        await paint({
          phase: 'verifying-backup',
          totalFiles: 2,
          completedFiles: 1,
          fileBytes: 50,
          fileSize: 100,
          fraction: null,
        });
        return { name: 'fixture' };
      },
    },
  });
  await a.init();
  a.subscribe((s) => {
    if (s.busy && s.progress) seen.push(s.progress);
  });
  await a.run('select-reader', { guardRevision: a.getSnapshot().guardRevision });
  await a.run('select-backup', { guardRevision: a.getSnapshot().guardRevision });
  assert(seen.some((p) => p.scannedFiles === 3 && p.fraction === null));
  assert(seen.some((p) => p.fraction === 0.25));
  assert(seen.some((p) => p.fraction === 0.75));
});
test('matching-backup recheck reports inventory progress before reader hashes', async () => {
  const { fixture } = await import('./memory-fs.js');
  const { backupReader, unchanged } = await import('../web/lib/storage.js');
  const { reader, backup } = await fixture();
  const b = await backupReader(reader, backup),
    events = [];
  await unchanged(reader, b.manifest, (e) => events.push(e));
  const scan = events.filter((e) => e.phase === 'scanning');
  assert.equal(scan[0].scannedFiles, 0);
  assert.equal(scan.at(-1).scannedFiles, b.manifest.entries.length);
  assert(
    events.findIndex((e) => e.phase === 'scanning') <
      events.findIndex((e) => e.phase === 'verifying-reader'),
  );
});

test('verified healthy managed resume bypasses fresh backup, policy, enrolment and startup steps', () => {
  const base = {
    initialized: true,
    reader: {},
    backupFolder: 'Backups',
    backupPresent: true,
    managedDetected: true,
    trust: { status: 'healthy' },
    startupVerified: true,
    active: true,
    systemVerified: true,
    backupVerified: false,
    backupPreviouslyVerified: false,
    policyConfirmed: false,
    configured: false,
    connectionHealthy: false,
    endpointCorrect: false,
    finalConfirmed: false,
  };
  for (const journey of ['managed', 'continue', 'new']) {
    const v = wizardView({ ...base, journey });
    assert.equal(v.step, 'complete');
    assert.equal(v.action, null);
    assert.equal(v.existingSummary, true);
  }
  assert.equal(wizardView({ ...base, journey: 'recovery' }).step, 'recovery');
  assert.equal(
    wizardView({ ...base, cycle: deviceCycle('status', 'pending', 'connect') }).action,
    'return',
  );
  assert.notEqual(
    wizardView({ ...base, startupVerified: false, journey: 'managed' }).step,
    'complete',
  );
});

test('healthy installed reader with no saved form opens summary without backup scans or queued work', async () => {
  const { fixture, put } = await import('./memory-fs.js');
  const { backupReader } = await import('../web/lib/storage.js');
  const { reader, backup: root } = await fixture();
  await put(reader, '.adds/kobold/releases/0.1.0/SHA256SUMS', 'fixture');
  await backupReader(reader, root);
  reader.writes = [];
  const picks = [reader, root],
    storage = memory(),
    journal = diagnosticJournal(storage);
  let backups = 0,
    queues = 0,
    policies = 0;
  const release = { profile: { id: 'fixture' } },
    a = createWizardAdapter({
      journal,
      storage,
      scope: { ...scope, showDirectoryPicker: () => Promise.resolve(picks.shift()) },
      dependencies: {
        getRelease: async () => release,
        collectionPackage: async () => null,
        folderRecord: async () => null,
        scanPreparation: async () => ({ state: 'ready' }),
        collectDiagnostics: async () => ({ reports: {} }),
        readVerifiedReport: async () => ({
          report: {
            id: 'a'.repeat(32),
            status: {
              BackendState: 'Running',
              Health: [],
              Self: { Tags: ['tag:kobo-sync'] },
            },
          },
          trust: { status: 'healthy', descriptor: 'fixture', sequence: 4 },
          active: release,
        }),
        connectionInstallation: () => true,
        requireSystemBackup: async () => 'hash',
        updateBackup: async () => {
          backups++;
          throw Error('No backup scan expected');
        },
        queue: async () => {
          queues++;
          throw Error('No queue expected');
        },
        policyProposal: () => {
          policies++;
          throw Error('No policy generation expected');
        },
      },
    });
  await a.init();
  await a.run('select-reader', { guardRevision: a.getSnapshot().guardRevision });
  await a.run('select-backup', { guardRevision: a.getSnapshot().guardRevision });
  const s = a.getSnapshot();
  assert.equal(s.view.existingSummary, true);
  assert.equal(s.view.action, null);
  assert.equal(s.startupVerified, true);
  assert.equal(s.connectionHealthy, false);
  assert.equal(s.finalConfirmed, false);
  assert.equal(backups, 0);
  assert.equal(queues, 0);
  assert.equal(policies, 0);
  assert.deepEqual(reader.writes, []);
});

test('explicit public preview backs up and reviews policy without native artifact fetches or actions', async () => {
  const { fixture } = await import('./memory-fs.js');
  const { reader, backup } = await fixture();
  reader.writes = [];
  const storage = memory(),
    journal = diagnosticJournal(storage),
    picks = [reader, backup];
  let nativeCalls = 0;
  const forbidden = async () => {
    nativeCalls++;
    throw Error('Native work must not run in preview');
  };
  const a = createWizardAdapter({
    journal,
    storage,
    preview: true,
    scope: { ...scope, showDirectoryPicker: () => Promise.resolve(picks.shift()) },
    dependencies: {
      getRelease: forbidden,
      collectionPackage: forbidden,
      scanPreparation: forbidden,
      collectDiagnostics: forbidden,
      readVerifiedReport: forbidden,
      queue: forbidden,
      stage: forbidden,
      folderRecord: async () => null,
    },
  });
  await a.init();
  assert.equal(a.getSnapshot().preview, true);
  assert.equal(a.getSnapshot().error, null);
  for (const action of ['select-reader', 'select-backup']) {
    await a.run(action, { guardRevision: a.getSnapshot().guardRevision });
    assert.equal(a.getSnapshot().error, null);
  }
  assert.equal(a.getSnapshot().backupVerified, true);
  assert.equal(a.getSnapshot().view.step, 'network');
  await a.run('review-policy', {
    guardRevision: a.getSnapshot().guardRevision,
    input: { ip: '100.101.102.103', 'original-policy': '{}' },
  });
  assert(a.getSnapshot().policy);
  await a.run('confirm-policy', {
    guardRevision: a.getSnapshot().guardRevision,
    consent: a.consent('confirm-policy'),
    acknowledged: true,
  });
  assert.equal(a.getSnapshot().view.title, 'Policy review complete');
  assert.equal(a.getSnapshot().view.action, null);
  assert.equal(a.getSnapshot().releaseAllowsInstall, false);
  for (const action of [
    'status',
    'return',
    'install',
    'update',
    'repair',
    'authorise',
    'endpoint',
    'enable',
    'disable',
    'remove',
    'prepare-folders',
    'prepare-collection',
    'open-signin',
    'manage',
  ]) {
    assert.equal(a.allowed(action), false, action);
    assert.throws(() => a.consent(action), /not available/);
    await assert.rejects(
      a.run(action, { guardRevision: a.getSnapshot().guardRevision }),
      /unavailable/,
    );
  }
  assert.equal(nativeCalls, 0);
  assert.deepEqual(reader.writes, []);
});

test('unmarked signed sites retain normal release discovery and missing-release errors', async () => {
  const storage = memory();
  let releases = 0,
    collections = 0;
  const a = createWizardAdapter({
    journal: diagnosticJournal(storage),
    storage,
    scope,
    dependencies: {
      getRelease: async () => {
        releases++;
        throw Error('Missing signed release');
      },
      collectionPackage: async () => {
        collections++;
        return null;
      },
    },
  });
  await a.init();
  assert.equal(a.getSnapshot().preview, false);
  assert.equal(releases, 1);
  assert.equal(collections, 1);
  assert.equal(a.getSnapshot().error.code, 'release-unavailable');
});

test('failed and cancelled backups settle progress immediately and retain measured work', async () => {
  const { fixture } = await import('./memory-fs.js');
  for (const cancelled of [false, true]) {
    const { reader, backup: root } = await fixture();
    const storage = memory(),
      journal = diagnosticJournal(storage),
      picks = [reader, root],
      seen = [];
    const a = createWizardAdapter({
      journal,
      storage,
      scope: { ...scope, showDirectoryPicker: () => Promise.resolve(picks.shift()) },
      dependencies: {
        getRelease: async () => null,
        collectionPackage: async () => null,
        folderRecord: async () => null,
        updateBackup: async (r, b, previous, onProgress) => {
          await onProgress({
            phase: 'copying',
            fraction: 0.4,
            path: 'Books/example.epub',
            completedFiles: 2,
            totalFiles: 5,
          });
          throw cancelled
            ? new DOMException('Backup stopped', 'AbortError')
            : Error('Backup file could not be read');
        },
        collectDiagnostics: async () => ({ reports: {} }),
      },
    });
    a.subscribe((s) => seen.push(s));
    await a.init();
    for (const action of ['select-reader', 'select-backup'])
      await a.run(action, { guardRevision: a.getSnapshot().guardRevision });
    const s = a.getSnapshot(),
      phase = cancelled ? 'Cancelled' : 'Failed';
    assert.equal(s.busy, false);
    assert.equal(s.progress.phase, phase);
    assert.equal(s.progress.fraction, 0.4);
    assert.equal(s.progress.completedFiles, 2);
    assert.equal(s.progress.currentFile, 'Books/example.epub');
    assert(
      seen.some(
        (s) => s.busy && s.progress?.phase === phase && s.progress.fraction === 0.4,
      ),
      'terminal feedback must publish before diagnostic capture finishes',
    );
    assert.equal(s.error === null, cancelled);
  }
});

test('fresh and update flows restore signed status after stale USB handle reselection without writes', async () => {
  const { fixture, put } = await import('./memory-fs.js');
  const { backupReader, fileHandle } = await import('../web/lib/storage.js');
  for (const journey of ['continue', 'managed']) {
    for (const valid of [true, false]) {
      const { reader, backup: root } = await fixture();
      await put(reader, '.adds/kobold/releases/0.1.0/SHA256SUMS', 'fixture');
      await backupReader(reader, root);
      reader.writes = [];
      const storage = memory(),
        journal = diagnosticJournal(storage),
        nonce = 'a'.repeat(32);
      storage.setItem(
        'kobold.wizard.v1',
        JSON.stringify({
          sessionId: journal.id,
          journey,
          cycle: {
            ...deviceCycle('status', 'usb-cycle', 'connect'),
            requestId: nonce,
            action: 'enable',
          },
        }),
      );
      const picks = [reader, root, reader];
      let disconnected = false,
        healthy = false,
        reads = 0,
        writes = 0;
      const release = { profile: { id: 'fixture' } };
      const a = createWizardAdapter({
        journal,
        storage,
        scope: { ...scope, showDirectoryPicker: () => Promise.resolve(picks.shift()) },
        dependencies: {
          getRelease: async () => release,
          collectionPackage: async () => null,
          folderRecord: async () => null,
          scanPreparation: async () => ({ state: 'ready' }),
          collectDiagnostics: async () => ({ reports: {} }),
          fileHandle: async (r, p) => {
            if (disconnected)
              throw new DOMException('Stale USB handle', 'NotFoundError');
            return fileHandle(r, p);
          },
          readVerifiedReport: async () => {
            reads++;
            if (healthy && !valid) throw Error('Signature verification failed');
            return {
              report: {
                id: nonce,
                status: {
                  BackendState: 'Running',
                  Health: [],
                  Self: { Tags: ['tag:kobo-sync'] },
                },
              },
              trust: {
                status: healthy ? 'healthy' : 'installed',
                descriptor: 'fixture',
                sequence: healthy ? 3 : 2,
              },
              active: release,
            };
          },
          connectionInstallation: () => true,
          requireSystemBackup: async () => 'hash',
          updateBackup: async () => {
            writes++;
            throw Error('Unexpected backup');
          },
          queue: async () => {
            writes++;
            throw Error('Unexpected queue');
          },
        },
      });
      const run = (action, extra = {}) =>
        a.run(action, { guardRevision: a.getSnapshot().guardRevision, ...extra });
      await a.init();
      await run('select-reader');
      await run('select-backup');
      disconnected = true;
      healthy = true;
      await run('return', { acknowledged: true, cycleId: a.getSnapshot().cycle.id });
      assert.equal(a.getSnapshot().reader, null);
      disconnected = false;
      await run('select-reader');
      const s = a.getSnapshot();
      assert.equal(reads, 2, journey);
      assert.equal(writes, 0, journey);
      assert.equal(s.active, valid, journey);
      assert.equal(s.startupVerified, valid, journey);
      assert.equal(s.finalConfirmed, false);
      assert.equal(s.syncConfirmed, false);
      if (valid) assert.equal(s.view.existingSummary, true);
      else {
        assert.equal(s.view.action, 'status');
        assert.match(s.error.message, /Signature/);
      }
      assert.deepEqual(reader.writes, []);
    }
  }
});
