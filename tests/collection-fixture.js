import { signer } from './signing-fixture.js';
import { put } from './memory-fs.js';
import { hashBytes } from '../web/lib/sha256.js';
import { backupReader, readText } from '../web/lib/storage.js';
import {
  collectionPackage,
  stageCollection,
  collectPreflight,
} from '../web/lib/collection.js';
import {
  prepareScanProtection,
  confirmScanRestart,
} from '../web/lib/scan-protection.js';
export async function packageFixture() {
  const s = signer(),
    id = 'c'.repeat(32),
    bytes = new TextEncoder().encode('fixture archive; never execute');
  const m = {
    schema: 1,
    purpose: 'collect-preflight',
    profileId: 'libra-colour-390-4.46.23836',
    id,
    descriptorSha256: 'd'.repeat(64),
    archive: {
      url: 'collection.tgz',
      size: bytes.length,
      sha256: hashBytes(bytes),
    },
    rootWritesBeforeBackup: true,
    rootFiles: [
      'bootstrap.sh',
      'provenance',
      'GO-LICENSE.txt',
      'release-keys.json',
      'release.json',
    ]
      .map((n) => '/usr/local/kobold-preflight-' + id + '/' + n)
      .concat('/etc/udev/rules.d/98-kobold-preflight-' + id + '.rules')
      .sort(),
  };
  const fetcher = async (url) => ({
    ok: true,
    json: async () => (String(url).includes('keys.json') ? s.keys : s.envelope(m)),
    arrayBuffer: async () => bytes.buffer,
  });
  return { m: await collectionPackage(fetcher), s, bytes, fetcher };
}
// Host fixture follows the actual collection verification API, including its
// in-memory authenticity proof. No hardware execution or gate bypass occurs.
export async function verifiedCollectionFixture(reader, backup) {
  let b = await backupReader(reader, backup);
  await prepareScanProtection(reader, b, null);
  await confirmScanRestart(reader, b, true);
  b = await backupReader(reader, backup);
  const { m, s, bytes, fetcher } = await packageFixture();
  const nonce = await stageCollection(reader, b, m, true, { fetcher });
  const pending = JSON.parse(
    await readText(backup, 'collection/' + m.id + '/pending.json'),
  );
  const prefix = '.adds/kobold-preflight/' + m.id + '/reports/' + nonce;
  const report = {
    purpose: 'collect-preflight',
    id: m.id,
    nonce,
    descriptorSha256: m.descriptorSha256,
    identitySha256: pending.identitySha256,
    profileId: m.profileId,
    observedAt: new Date().toISOString(),
    architecture: 'armv7l',
    kernel: '4.9.77',
    rootFreeBytes: 1e9,
    onboardFreeBytes: 1e9,
    absentRootPaths: [
      '/usr/local/kobold-0.1.0',
      '/usr/local/kobold-state',
      '/etc/udev/rules.d/98-kobold-0.1.0.rules',
    ],
    parentsAreRealDirectories: true,
    systemBackupSha256: hashBytes(bytes),
    systemBackupSize: bytes.length,
    collectorRuleRemoved: true,
  };
  await put(reader, prefix + '/system-before-trial.tar.gz', bytes);
  await put(reader, prefix + '/report.json', JSON.stringify(s.envelope(report, s.pub)));
  await (await reader.getDirectoryHandle('.kobo')).removeEntry('KoboRoot.tgz');
  const result = await collectPreflight(reader, { root: backup }, m);
  b = await backupReader(reader, backup);
  return {
    backup: b,
    collectionResult: result,
    preflight: { collection: { id: m.id, descriptorSha256: m.descriptorSha256 } },
  };
}
