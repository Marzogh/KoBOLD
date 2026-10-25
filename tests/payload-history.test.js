import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, put } from './memory-fs.js';
import { signedFixture, signer } from './signing-fixture.js';
import { backupReader, fileHandle, readText } from '../web/lib/storage.js';
import { hashFile, hashBytes } from '../web/lib/sha256.js';
import { payloadHistory } from '../web/lib/payload-history.js';
import { excludeInstallerFolders } from '../web/lib/library-exclusion.js';
test('file history narrows the loss window using scoped snapshots and a pinned signed receipt, without writes', async () => {
  const { reader, backup } = await fixture(),
    path = 'licenses/TAILSCALE-LICENSE.txt',
    home = '.adds/kobold/releases/0.1.0/',
    bytes = new TextEncoder().encode('license');
  await put(reader, home + path, bytes);
  await put(reader, 'Books/PRIVATE-BOOK-CANARY.epub', 'private');
  await put(
    reader,
    '.kobo/Kobo/Kobo eReader.conf',
    '[Other]\nsecret=PRIVATE-TOKEN-CANARY\n',
  );
  const release = await signedFixture({
      files: [{ path, sha256: hashBytes(bytes) }],
    }),
    identity = await hashFile(
      await (await fileHandle(reader, '.kobo/version')).getFile(),
    ),
    s = signer(),
    id = 'a'.repeat(32);
  const receipt = {
    identity,
    installationId: 'b'.repeat(32),
    release: release.installationDescriptorSha256,
    status: 'prepared',
    files: { ['/mnt/onboard/' + home + path]: hashBytes(bytes) },
  };
  const env = s.envelope(receipt, s.pub),
    digest = hashBytes(Uint8Array.from(Buffer.from(env.payload, 'base64')));
  await put(reader, '.adds/kobold/last-result.txt', id);
  await put(
    reader,
    '.adds/kobold/reports/' + id + '/installation.json',
    JSON.stringify(env),
  );
  await put(
    backup,
    'kobold-installations/' + identity + '/trust.json',
    JSON.stringify({
      digest,
      identity,
      installationId: receipt.installationId,
      publicKey: s.pub,
    }),
  );
  const first = await backupReader(reader, backup);
  const licenseDir = await (
    await (
      await (
        await (await reader.getDirectoryHandle('.adds')).getDirectoryHandle('kobold')
      ).getDirectoryHandle('releases')
    ).getDirectoryHandle('0.1.0')
  ).getDirectoryHandle('licenses');
  await licenseDir.removeEntry('TAILSCALE-LICENSE.txt');
  await put(
    reader,
    '.kobo/Kobo/Kobo eReader.conf',
    excludeInstallerFolders(await readText(reader, '.kobo/Kobo/Kobo eReader.conf')),
  );
  await backupReader(reader, backup, () => {}, { previous: first });
  await put(
    backup,
    'installation-checks/' + id + '/before-eject.json',
    JSON.stringify({
      phase: 'browser-before-eject',
      observedAt: '2026-10-25T00:00:00.000Z',
      descriptor: release.installationDescriptorSha256,
      files: [{ path, sha256: hashBytes(bytes) }],
      private: 'PRIVATE-TOKEN-CANARY',
    }),
  );
  reader.writes = [];
  backup.writes = [];
  const report = await payloadHistory(reader, backup, release, [path]);
  assert.equal(report.snapshots.length, 2);
  assert.equal(report.snapshots[0].files[0].present, true);
  assert.equal(report.snapshots[1].files[0].present, false);
  assert.equal(report.snapshots[0].scanExclusion.ownedRulePresent, false);
  assert.equal(report.current.scanExclusion.ownedRulePresent, true);
  assert.equal(report.checkpoints[0].source, 'unsigned-browser-readback');
  assert.equal(report.checkpoints[0].files[0].sha256, hashBytes(bytes));
  assert.equal(report.inspection.verified, true);
  assert.equal(report.inspection.files[0].checkedSignedHash, true);
  assert.equal(report.current.files[0].present, false);
  assert.doesNotMatch(
    JSON.stringify(report),
    /PRIVATE-BOOK|PRIVATE-TOKEN|installationId|publicKey/,
  );
  assert.deepEqual(reader.writes, []);
  assert.deepEqual(backup.writes, []);
  await assert.rejects(
    payloadHistory(reader, backup, release, ['Books/PRIVATE-BOOK-CANARY.epub']),
    /signed installer/,
  );
});
