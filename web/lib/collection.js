import { requireScanReady } from './scan-protection.js';
import { verifyEnvelope } from './provenance.js';
import { identify, PROFILE } from './core.js';
import { hashBytes, hashFile } from './sha256.js';
import { assertBackupChoice } from './backup-store.js';
import {
  readText,
  fileHandle,
  exists,
  writeVerified,
  copyVerified,
  directory,
} from './storage.js';
const authentic = new WeakMap(),
  results = new WeakMap();
export function verifiedCollection(result, expected) {
  if (
    !result ||
    results.get(result) !== JSON.stringify(result) ||
    result.preflight.id !== expected?.id ||
    result.preflight.descriptorSha256 !== expected?.descriptorSha256 ||
    !result.ready
  )
    throw Error('Collect and verify the Kobo system backup in this app first.');
  return result.preflight;
}
const home = (id) => '.adds/kobold-preflight/' + id;
export async function collectionPackage(fetcher = fetch) {
  const r = await fetcher(
    new URL('../collection/manifest.signed.json', import.meta.url),
  );
  if (!r.ok) return null;
  const trust = await fetcher(
    new URL('../trust/collection-keys.json', import.meta.url),
  );
  if (!trust.ok) throw Error('Collection signing keys unavailable.');
  const verified = await verifyEnvelope(await r.json(), await trust.json()),
    m = verified.value;
  if (
    m.schema !== 1 ||
    m.purpose !== 'collect-preflight' ||
    m.profileId !== PROFILE.id ||
    !/^[a-f0-9]{32}$/.test(m.id) ||
    m.archive?.url !== 'collection.tgz' ||
    !/^[a-f0-9]{64}$/.test(m.archive?.sha256) ||
    !Number.isSafeInteger(m.archive.size) ||
    m.archive.size < 1 ||
    m.archive.size > 16 * 1024 * 1024 ||
    !/^[a-f0-9]{64}$/.test(m.descriptorSha256) ||
    !Array.isArray(m.rootFiles) ||
    m.rootFiles.length !== 6 ||
    m.rootWritesBeforeBackup !== true
  )
    throw Error('Invalid collection package.');
  const base = '/usr/local/kobold-preflight-' + m.id,
    expected = [
      'bootstrap.sh',
      'provenance',
      'GO-LICENSE.txt',
      'release-keys.json',
      'release.json',
    ]
      .map((n) => base + '/' + n)
      .concat('/etc/udev/rules.d/98-kobold-preflight-' + m.id + '.rules')
      .sort();
  if (JSON.stringify(m.rootFiles) !== JSON.stringify(expected))
    throw Error('Unexpected collection root paths.');
  authentic.set(m, JSON.stringify(m));
  return m;
}
function trusted(m) {
  if (!m || authentic.get(m) !== JSON.stringify(m))
    throw Error('A verified signed collection package is required.');
}
/** Queue the signed collector after backup and folder-scan preparation checks. */
export async function stageCollection(
  reader,
  backup,
  m,
  acknowledged,
  { fetcher = fetch } = {},
) {
  trusted(m);
  if (!acknowledged)
    throw Error('Confirm the collection package changes before continuing.');
  if (backup?.skipped || !backup?.root)
    throw Error(
      'Collection requires a full verified Kobo backup and its parent folder.',
    );
  const identity = identify(await readText(reader, '.kobo/version'));
  if (!identity.matched || identity.profile !== m.profileId)
    throw Error('Unsupported Kobo.');
  await assertBackupChoice(reader, backup, { current: true });
  if (await exists(reader, '.kobo/KoboRoot.tgz'))
    throw Error(
      'Another Kobo update is queued. Keep USB connected; do not overwrite it.',
    );
  const base = home(m.id);
  try {
    await reader
      .getDirectoryHandle('.adds')
      .then((d) => d.getDirectoryHandle('kobold-preflight'))
      .then((d) => d.getDirectoryHandle(m.id));
    throw Error(
      'This collection was already prepared. Read its result rather than repeating it.',
    );
  } catch (e) {
    if (e.name !== 'NotFoundError') throw e;
  }
  const response = await fetcher(
    new URL('../collection/collection.tgz', import.meta.url),
  );
  if (!response.ok) throw Error('Collection archive unavailable.');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length !== m.archive.size || hashBytes(bytes) !== m.archive.sha256)
    throw Error('Collection archive verification failed.');
  await requireScanReady(reader, backup);
  const id = crypto.randomUUID().replaceAll('-', ''),
    identityHash = await hashFile(
      await (await fileHandle(reader, '.kobo/version')).getFile(),
    );
  const store = 'collection/' + m.id;
  await writeVerified(
    backup.root,
    store + '/pending.json',
    JSON.stringify({
      id,
      identitySha256: identityHash,
      archiveSha256: m.archive.sha256,
    }),
    { exclusive: true },
  );
  await writeVerified(
    reader,
    base + '/INCOMPLETE.txt',
    'Keep USB connected until preparation completes.\n',
    { exclusive: true },
  );
  await writeVerified(
    reader,
    base + '/request.json',
    JSON.stringify({ id, identitySha256: identityHash }),
    { exclusive: true },
  );
  await writeVerified(reader, base + '/verified.tgz', bytes, {
    exclusive: true,
  });
  try {
    await writeVerified(reader, '.kobo/KoboRoot.tgz', bytes, {
      exclusive: true,
    });
  } catch (e) {
    try {
      await (await reader.getDirectoryHandle('.kobo')).removeEntry('KoboRoot.tgz');
    } catch {
      throw Error(
        'Queue cleanup failed. Keep USB connected and follow recovery instructions.',
      );
    }
    throw e;
  }
  await (
    await (
      await reader.getDirectoryHandle('.adds')
    ).getDirectoryHandle('kobold-preflight')
  )
    .getDirectoryHandle(m.id)
    .then((d) => d.removeEntry('INCOMPLETE.txt'));
  return id;
}
/** Authenticate collection output and copy its recovery archive before use. */
export async function collectPreflight(reader, backup, m, onProgress = () => {}) {
  trusted(m);
  if (!backup?.root) throw Error('Select your original backup parent folder.');
  const pending = JSON.parse(
    await readText(backup.root, 'collection/' + m.id + '/pending.json'),
  );
  if (!/^[a-f0-9]{32}$/.test(pending.id) || pending.archiveSha256 !== m.archive.sha256)
    throw Error('Collection request does not match this package.');
  const current = await hashFile(
    await (await fileHandle(reader, '.kobo/version')).getFile(),
  );
  if (current !== pending.identitySha256) throw Error('This is a different reader.');
  const prefix = home(m.id) + '/reports/' + pending.id;
  let env;
  try {
    env = JSON.parse(await readText(reader, prefix + '/report.json'));
  } catch {
    let error = '';
    try {
      error = (await readText(reader, home(m.id) + '/collector-error.txt')).slice(
        0,
        500,
      );
    } catch {}
    throw Error(
      'Collection has not completed. Reconnect after the reader finishes.' +
        (error ? ' Details: ' + error : ''),
    );
  }
  const previous = (await exists(backup.root, 'collection/' + m.id + '/report.json'))
    ? JSON.parse(await readText(backup.root, 'collection/' + m.id + '/report.json'))
    : null;
  const key = previous?.keyId ?? env.keyId;
  const { value: r } = await verifyEnvelope(env, { [key]: key });
  if (
    r.purpose !== 'collect-preflight' ||
    r.id !== m.id ||
    r.nonce !== pending.id ||
    r.identitySha256 !== current ||
    r.descriptorSha256 !== m.descriptorSha256 ||
    r.profileId !== m.profileId ||
    r.collectorRuleRemoved !== true ||
    !/^[a-f0-9]{64}$/.test(r.systemBackupSha256) ||
    !Number.isSafeInteger(r.systemBackupSize) ||
    r.systemBackupSize <= 0
  )
    throw Error('Collection report does not match the requested check.');
  const destination = 'preflight/' + current + '/' + m.id + '/' + pending.id;
  const out = await directory(backup.root, destination, true);
  let copied;
  if (await exists(out, 'system-before-trial.tar.gz')) {
    const existing = await (
      await fileHandle(out, 'system-before-trial.tar.gz')
    ).getFile();
    copied = { size: existing.size, sha256: await hashFile(existing) };
  } else
    copied = await copyVerified(
      reader,
      out,
      prefix + '/system-before-trial.tar.gz',
      onProgress,
      { destination: 'system-before-trial.tar.gz' },
    );
  if (copied.sha256 !== r.systemBackupSha256 || copied.size !== r.systemBackupSize)
    throw Error(
      'Existing system backup differs; it has been preserved. Choose a separate backup folder.',
    );
  await writeVerified(
    backup.root,
    'collection/' + m.id + '/report.json',
    JSON.stringify(env),
  );
  await writeVerified(
    backup.root,
    destination + '/preflight.json',
    JSON.stringify(r, null, 2) + '\n',
  );
  const ready =
    Number.isSafeInteger(r.rootFreeBytes) &&
    r.rootFreeBytes >= 32 * 1024 * 1024 &&
    Number.isSafeInteger(r.onboardFreeBytes) &&
    r.onboardFreeBytes >= 64 * 1024 * 1024 &&
    r.architecture === 'armv7l' &&
    r.kernel?.startsWith('4.9.77') &&
    r.parentsAreRealDirectories === true &&
    JSON.stringify(r.absentRootPaths) ===
      JSON.stringify([
        '/usr/local/kobold-0.1.0',
        '/usr/local/kobold-state',
        '/etc/udev/rules.d/98-kobold-0.1.0.rules',
      ]);
  const result = { preflight: r, ready };
  results.set(result, JSON.stringify(result));
  return result;
}
