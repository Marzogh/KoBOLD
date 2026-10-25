import { identify } from './core.js';
import { hashFile, hashBytes } from './sha256.js';
import { fileHandle, readText, writeVerified, exists } from './storage.js';
import { assertBackupChoice, requireSystemBackup } from './backup-store.js';
import {
  protectInstallerFolders,
  installerExclusionPresent,
} from './library-exclusion.js';
import { managedInstallation } from './provenance.js';
import { auditPayload } from './payload-audit.js';
const cfg = '.kobo/Kobo/Kobo eReader.conf';
async function context(reader, backup) {
  if (!backup?.root || backup.skipped)
    throw Error('Select the full backup and its parent folder.');
  const version = await readText(reader, '.kobo/version');
  if (!identify(version).matched) throw Error('Unsupported reader or firmware.');
  const identity = await hashFile(
    await (await fileHandle(reader, '.kobo/version')).getFile(),
  );
  const text = await readText(reader, cfg);
  const line = text.split(/\r?\n/).filter((l) => /^ExcludeSyncFolders\s*=/.test(l));
  if (line.length > 1) throw Error('Duplicate folder exclusions require review.');
  return {
    identity,
    text,
    fingerprint: hashBytes(new TextEncoder().encode(line[0] ?? '')),
    path: 'reader-preparation/' + identity + '/scan.json',
  };
}
export async function scanPreparation(reader, backup) {
  const c = await context(reader, backup);
  if (!(await exists(backup.root, c.path)))
    return {
      state: 'needed',
      reason: 'no-record',
      message:
        'No completed folder-preparation record was found in this backup parent folder.',
    };
  const saved = JSON.parse(await readText(backup.root, c.path));
  if (saved.identity !== c.identity)
    return {
      state: 'needed',
      reason: 'reader-changed',
      message: 'The saved preparation record does not match this reader.',
    };
  if (!installerExclusionPresent(c.text))
    return {
      state: 'needed',
      reason: 'rule-missing',
      message: 'The folder exclusion is missing or has changed since preparation.',
    };
  if (saved.fingerprint !== c.fingerprint)
    return {
      state: 'needed',
      reason: 'rule-changed',
      message:
        'The exclusion setting changed after preparation. Prepare it again before confirming a restart.',
    };
  return { state: saved.state === 'confirmed' ? 'ready' : 'restart' };
}
export async function prepareScanProtection(reader, backup, release) {
  await assertBackupChoice(reader, backup, { current: true });
  let proof = null;
  if (await exists(reader, '.adds/kobold/releases/0.1.0/SHA256SUMS')) {
    await requireSystemBackup(reader, backup);
    proof = await managedInstallation(reader, backup, release);
    const audit = await auditPayload(reader, proof.release);
    if (audit.unexpected.length)
      throw Error(
        'Unexpected installer files require review before changing settings.',
      );
  }
  await protectInstallerFolders(reader, backup, proof);
  const c = await context(reader, backup);
  await writeVerified(
    backup.root,
    c.path,
    JSON.stringify({
      format: 1,
      state: 'restart',
      identity: c.identity,
      fingerprint: c.fingerprint,
      preparedAt: new Date().toISOString(),
    }),
  );
  return { state: 'restart' };
}
export async function confirmScanRestart(reader, backup, acknowledged) {
  if (!acknowledged)
    throw Error(
      'Confirm that you safely ejected, fully restarted the Kobo and reconnected USB.',
    );
  const c = await context(reader, backup);
  if ((await scanPreparation(reader, backup)).state !== 'restart')
    throw Error('Prepare folder settings again before confirming restart.');
  const saved = JSON.parse(await readText(backup.root, c.path));
  await writeVerified(
    backup.root,
    c.path,
    JSON.stringify({
      ...saved,
      state: 'confirmed',
      confirmedAt: new Date().toISOString(),
      confirmation: 'user-attested-full-restart',
    }),
  );
  return { state: 'ready' };
}
/** Require the same reader and confirmed folder-scan setting before payload writes. */
export async function requireScanReady(reader, backup) {
  if ((await scanPreparation(reader, backup)).state !== 'ready')
    throw Error(
      'Prepare library folders, safely eject, fully restart the Kobo, reconnect and confirm before preparing installer files.',
    );
}
