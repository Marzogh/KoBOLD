import { verifiedCollection } from './collection.js';
import { requireSignedRelease } from './provenance.js';
import { hashFile } from './sha256.js';
import { fileHandle } from './storage.js';
export function trialGate(
  identity,
  release,
  acknowledged,
  now = Date.now(),
  collectionResult = null,
) {
  requireSignedRelease(release);
  const t = release.trial,
    p = t?.collection
      ? verifiedCollection(collectionResult, t.collection)
      : t?.preflight;
  if (
    release.channel !== 'attended-trial' ||
    !['inspect-only', 'install-and-connect'].includes(t?.purpose) ||
    t.profileId !== identity.profile ||
    !identity.matched ||
    !p ||
    t.bootstrapSha256 !== release.updates?.['bootstrap.tgz']?.sha256
  )
    throw Error('No matching signed installation trial is available.');
  const observed = Date.parse(p.observedAt),
    expires = t.collection ? observed + 2 * 60 * 60 * 1000 : Date.parse(t.expires);
  if (
    !Number.isFinite(observed) ||
    !Number.isFinite(expires) ||
    observed > now ||
    expires <= now ||
    expires - observed > 2 * 60 * 60 * 1000 ||
    expires <= observed
  )
    throw Error(
      'The trial preflight has expired. Repeat its checks before preparing the Kobo.',
    );
  if (
    !/^[a-f0-9]{64}$/.test(p.identitySha256) ||
    !/^[a-f0-9]{64}$/.test(p.systemBackupSha256) ||
    !Number.isSafeInteger(p.systemBackupSize) ||
    p.systemBackupSize <= 0
  )
    throw Error('The trial preflight or original system backup is incomplete.');
  if (
    t.collection &&
    p.onboardFreeBytes <
      release.files.reduce((n, f) => n + f.size, 0) +
        2 * release.updates['bootstrap.tgz'].size +
        32 * 1024 * 1024
  )
    throw Error('Insufficient reader space for the next trial phase.');
  if (!acknowledged)
    throw Error('Acknowledge the installation trial before preparing files.');
  return p;
}
export async function verifyTrialBackup(reader, backup, preflight) {
  if (backup?.skipped || !backup?.root)
    throw Error(
      'This first trial requires a complete Kobo backup and its parent folder.',
    );
  if (
    (await hashFile(await (await fileHandle(reader, '.kobo/version')).getFile())) !==
    preflight.identitySha256
  )
    throw Error('The trial preflight belongs to another reader.');
  const scope =
    /^[a-f0-9]{32}$/.test(preflight.id ?? '') &&
    /^[a-f0-9]{32}$/.test(preflight.nonce ?? '')
      ? preflight.id + '/' + preflight.nonce + '/'
      : '';
  const path =
    'preflight/' +
    preflight.identitySha256 +
    '/' +
    scope +
    'system-before-trial.tar.gz';
  let file;
  try {
    file = await (await fileHandle(backup.root, path)).getFile();
  } catch {
    throw Error(
      'Select the backup parent containing the original system-settings archive from preflight.',
    );
  }
  if (
    file.size !== preflight.systemBackupSize ||
    (await hashFile(file)) !== preflight.systemBackupSha256
  )
    throw Error(
      'The original system-settings backup does not match the trial preflight.',
    );
}
