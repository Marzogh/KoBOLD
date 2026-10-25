import { hashFile } from './sha256.js';
import {
  directory,
  fileHandle,
  readText,
  exists,
  writeVerified,
  verifyBackup,
  unchanged,
  separateLocations,
} from './storage.js';
import { safePath } from './core.js';
export const MAX_SKIP_ACK_AGE_MS = 2 * 60 * 60 * 1000;
const SESSION = /^kobold-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function skipAcknowledgementFreshness(manifest, now = Date.now()) {
  const timestamp = Date.parse(manifest?.created),
    age = now - timestamp;
  return {
    fresh: Number.isFinite(timestamp) && age >= 0 && age <= MAX_SKIP_ACK_AGE_MS,
    ageMs: Number.isFinite(age) ? age : null,
  };
}
function validateManifest(manifest) {
  if (
    ![1, 2].includes(manifest.format ?? 1) ||
    manifest.status !== 'verified' ||
    !Array.isArray(manifest.entries) ||
    !manifest.entries.length
  )
    throw Error('No complete backup manifest');
  const seen = new Set();
  for (const entry of manifest.entries) {
    safePath(entry.path);
    if (
      seen.has(entry.path) ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      !/^[a-f0-9]{64}$/.test(entry.sha256)
    )
      throw Error('Invalid backup manifest entry');
    seen.add(entry.path);
    if (entry.storedIn && !SESSION.test(entry.storedIn))
      throw Error('Invalid incremental backup reference');
  }
}
/** Resolve an incremental snapshot through its original immutable storage locations. */
export async function backupSnapshot(session, manifest, root = null) {
  validateManifest(manifest);
  if (!manifest.entries.some((e) => e.storedIn)) return directory(session, 'reader');
  if (!root)
    throw Error(
      'Select the parent backup folder so earlier incremental files can be found.',
    );
  const entries = new Map(manifest.entries.map((e) => [e.path, e]));
  function view(prefix = '') {
    return {
      kind: 'directory',
      name: prefix || 'reader',
      async getDirectoryHandle(name, { create = false } = {}) {
        if (create) throw Error('Backup snapshots are read-only');
        const path = prefix + safePath(name) + '/';
        if (![...entries.keys()].some((x) => x.startsWith(path)))
          throw new DOMException('Missing backup folder', 'NotFoundError');
        return view(path);
      },
      async getFileHandle(name, { create = false } = {}) {
        if (create) throw Error('Backup snapshots are read-only');
        const path = prefix + safePath(name),
          entry = entries.get(path);
        if (!entry) throw new DOMException('Missing backup file', 'NotFoundError');
        let source = session;
        if (entry.storedIn) {
          source = await root.getDirectoryHandle(entry.storedIn);
          if (await exists(source, 'INCOMPLETE.json'))
            throw Error('Referenced backup is incomplete: ' + entry.storedIn);
        }
        return fileHandle(await directory(source, 'reader'), path);
      },
    };
  }
  return view();
}
export async function openBackup(
  reader,
  session,
  { root = null, verify = true, onProgress = () => {} } = {},
) {
  if (await exists(session, 'INCOMPLETE.json'))
    throw Error('This backup is incomplete. Create a new backup before continuing.');
  const manifest = JSON.parse(await readText(session, 'manifest.json'));
  validateManifest(manifest);
  const identity = manifest.entries.find((e) => e.path === '.kobo/version');
  if (
    !identity ||
    (await hashFile(await (await fileHandle(reader, '.kobo/version')).getFile())) !==
      identity.sha256
  )
    throw Error('Backup belongs to a different reader or firmware version');
  const snapshot = await backupSnapshot(session, manifest, root);
  if (verify) await verifyBackup(snapshot, manifest, onProgress);
  return {
    directory: session,
    snapshot,
    manifest,
    name: session.name,
    root,
    systemHash: null,
  };
}
/** Find matching manifests without reading the complete library contents. */
export async function discoverBackups(reader, root) {
  await separateLocations(reader, root);
  const matches = [],
    issues = [];
  // Selecting a session folder directly remains supported for full backups.
  if (await exists(root, 'manifest.json')) {
    try {
      matches.push(await openBackup(reader, root, { verify: false }));
    } catch (error) {
      issues.push({ name: root.name, message: error.message });
    }
  } else {
    for await (const [name, handle] of root.entries()) {
      if (handle.kind !== 'directory' || !SESSION.test(name)) continue;
      try {
        if (await exists(handle, 'INCOMPLETE.json')) {
          issues.push({ name, message: 'Incomplete backup' });
          continue;
        }
        if (!(await exists(handle, 'manifest.json'))) continue;
        matches.push(await openBackup(reader, handle, { root, verify: false }));
      } catch (error) {
        if (!error.message.includes('different reader'))
          issues.push({ name, message: error.message });
      }
    }
  }
  matches.sort(
    (a, b) =>
      (Date.parse(b.manifest.created) || 0) - (Date.parse(a.manifest.created) || 0) ||
      (b.manifest.generation ?? 0) - (a.manifest.generation ?? 0),
  );
  return { matches, issues };
}
/** Verify stored bytes and compare them with the current reader snapshot. */
export async function checkBackup(
  reader,
  backup,
  { now = Date.now(), onProgress = () => {} } = {},
) {
  await verifyBackup(backup.snapshot, backup.manifest, onProgress);
  try {
    await unchanged(reader, backup.manifest, onProgress);
  } catch (error) {
    return {
      usable: false,
      reason: 'Kobo files have changed. Create an incremental backup.',
      details: error.message,
    };
  }
  return { usable: true, reason: 'Backup checked. Its files match this Kobo.' };
}
export async function skipMainBackup(reader, root, acknowledged) {
  if (!acknowledged)
    throw Error('Acknowledge the risk before continuing without a Kobo backup.');
  await separateLocations(reader, root);
  const identity = await hashFile(
    await (await fileHandle(reader, '.kobo/version')).getFile(),
  );
  const name = 'kobold-skipped-' + crypto.randomUUID(),
    session = await root.getDirectoryHandle(name, { create: true });
  const receipt = {
    format: 1,
    status: 'skipped',
    riskAcknowledged: true,
    created: new Date().toISOString(),
    identity,
  };
  await writeVerified(
    session,
    'SKIPPED.json',
    JSON.stringify(receipt, null, 2) + '\n',
    { exclusive: true },
  );
  return {
    directory: session,
    name,
    root,
    skipped: true,
    riskAcknowledged: true,
    receipt,
    systemHash: null,
  };
}
/** Validate the backup or explicit skip receipt required by the calling action. */
export async function assertBackupChoice(
  reader,
  backup,
  { current = false, now = Date.now() } = {},
) {
  if (!backup)
    throw Error('Create a matching Kobo backup or explicitly acknowledge skipping it.');
  if (backup.skipped) {
    const receipt = JSON.parse(await readText(backup.directory, 'SKIPPED.json'));
    if (
      !backup.riskAcknowledged ||
      receipt.status !== 'skipped' ||
      receipt.riskAcknowledged !== true ||
      receipt.identity !==
        (await hashFile(await (await fileHandle(reader, '.kobo/version')).getFile()))
    )
      throw Error(
        'The backup-skip acknowledgement is missing or belongs to another reader.',
      );
    if (!skipAcknowledgementFreshness(receipt, now).fresh)
      throw Error(
        'The backup-skip acknowledgement has expired. Confirm again or create a backup.',
      );
    return {
      status: 'skipped',
      riskAcknowledged: true,
      created: receipt.created,
    };
  }
  if (await exists(backup.directory, 'INCOMPLETE.json'))
    throw Error('This backup is incomplete. Create a new backup.');
  await verifyBackup(backup.snapshot, backup.manifest);
  if (current) await unchanged(reader, backup.manifest);
  return {
    status: 'verified',
    files: backup.manifest.entries.length,
    created: backup.manifest.created,
  };
}
/** Require a copied privileged archive with the reader-acknowledged checksum. */
export async function systemBackupPath(reader) {
  const base = '.adds/kobold';
  return base + '/system-backup.tar.gz';
}
export async function requireSystemBackup(reader, backup) {
  const path = await systemBackupPath(reader);
  const base = path.slice(0, path.lastIndexOf('/'));
  const expected = (await readText(reader, base + '/backup-ack.txt')).trim();
  if (!/^[a-f0-9]{64}$/.test(expected))
    throw Error('Save and verify the system-settings backup before continuing.');
  const saved = await fileHandle(backup.directory, 'privileged/' + path),
    source = await fileHandle(reader, path);
  if (
    (await hashFile(await saved.getFile())) !== expected ||
    (await hashFile(await source.getFile())) !== expected
  )
    throw Error(
      'The system-settings backup is missing or does not match. Save it again before continuing.',
    );
  return expected;
}
