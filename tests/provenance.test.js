import test from 'node:test';
import assert from 'node:assert/strict';
import { signer, signedFixture } from './signing-fixture.js';
import {
  verifyReleaseEnvelope,
  requireSignedRelease,
  beginInstallation,
  rememberRequest,
  verifyInstallationReport,
  updateEligibility,
  INSTALLER,
} from '../web/lib/provenance.js';
import { fixture, put } from './memory-fs.js';
import { backupReader, readText, fileHandle } from '../web/lib/storage.js';
import { hashFile } from '../web/lib/sha256.js';
import { stage } from '../web/lib/installer.js';
test('release signatures reject unknown keys, changed payloads and later object mutation', async () => {
  const s = signer(),
    value = {
      schema: 1,
      version: '0.1.0',
      installationDescriptorSha256: 'd'.repeat(64),
    },
    env = s.envelope(value);
  await assert.rejects(verifyReleaseEnvelope(env, {}), /not trusted/);
  await assert.rejects(
    verifyReleaseEnvelope(
      { ...env, payload: Buffer.from('{}').toString('base64') },
      s.keys,
    ),
    /Signature/,
  );
  const verified = await verifyReleaseEnvelope(env, s.keys);
  assert(requireSignedRelease(verified));
  verified.version = '2';
  assert.throws(() => requireSignedRelease(verified), /signed/);
});
test('hardware promotion alone cannot permit unsigned installation', async () => {
  const { reader, backup } = await fixture(),
    b = await backupReader(reader, backup);
  await assert.rejects(
    stage(
      reader,
      b,
      {
        profile: {
          id: 'libra-colour-390-4.46.23836',
          bootstrapAccepted: true,
          bootstrapEvidence: { fixtureOnly: true },
        },
      },
      {},
      true,
    ),
    /signed release/,
  );
  assert.deepEqual(reader.writes, []);
});
async function receiptFixture() {
  const { reader, backup } = await fixture(),
    b = await backupReader(reader, backup),
    s = signer();
  const release = await signedFixture({
      profile: { id: 'libra-colour-390-4.46.23836' },
      files: [],
    }),
    nonce = 'a'.repeat(32);
  await beginInstallation(reader, b, release, nonce);
  const identity = await hashFile(
    await (await fileHandle(reader, '.kobo/version')).getFile(),
  );
  const receipt = {
    installer: INSTALLER,
    installationId: 'b'.repeat(32),
    identity,
    profile: release.profile.id,
    version: '0.1.0',
    release: release.installationDescriptorSha256,
    publicKey: s.pub,
    sequence: 1,
    previous: '',
    nonce,
    status: 'prepared',
    files: {},
  };
  const report = { id: nonce, prefix: '.adds/kobold/reports/' + nonce };
  return { reader, backup, b, s, release, receipt, report };
}
async function exportReceipt(f, receipt = f.receipt, signer = f.s) {
  await put(
    f.reader,
    f.report.prefix + '/installation.json',
    JSON.stringify(signer.envelope(receipt, signer.pub)),
  );
}
test('pins explicit initial installation, keeps device key across new backup generations', async () => {
  const f = await receiptFixture();
  await exportReceipt(f);
  const pin = await verifyInstallationReport(f.reader, f.b, f.release, f.report);
  assert.equal(pin.status, 'prepared');
  assert.throws(() => updateEligibility(pin), /healthy/);
  const next = await backupReader(f.reader, f.backup);
  const nonce = 'c'.repeat(32);
  await rememberRequest(f.reader, next, nonce);
  f.report = { id: nonce, prefix: '.adds/kobold/reports/' + nonce };
  await exportReceipt(f, {
    ...f.receipt,
    sequence: 2,
    previous: pin.digest,
    nonce,
    status: 'healthy',
  });
  const healthy = await verifyInstallationReport(f.reader, next, f.release, f.report);
  assert(updateEligibility(healthy));
});
test('rejects wrong challenge, replacement key, foreign identity, rollback and broken chain', async () => {
  for (const kind of ['nonce', 'key', 'identity', 'rollback', 'chain']) {
    const f = await receiptFixture();
    await exportReceipt(f);
    const pin = await verifyInstallationReport(f.reader, f.b, f.release, f.report);
    const nonce = 'c'.repeat(32);
    await rememberRequest(f.reader, f.b, nonce);
    f.report = { id: nonce, prefix: '.adds/kobold/reports/' + nonce };
    let r = {
        ...f.receipt,
        sequence: 2,
        previous: pin.digest,
        nonce,
        status: 'healthy',
      },
      s = f.s;
    if (kind === 'nonce') r.nonce = 'd'.repeat(32);
    if (kind === 'key') {
      s = signer();
      r.publicKey = s.pub;
    }
    if (kind === 'identity') r.identity = '0'.repeat(64);
    if (kind === 'rollback') r.sequence = 1;
    if (kind === 'chain') r.previous = '0'.repeat(64);
    await exportReceipt(f, r, s);
    await assert.rejects(verifyInstallationReport(f.reader, f.b, f.release, f.report));
  }
});
test('missing external trust cannot silently adopt an existing installation', async () => {
  const f = await receiptFixture();
  await exportReceipt(f, { ...f.receipt, sequence: 4, status: 'healthy' });
  await assert.rejects(
    verifyInstallationReport(f.reader, f.b, f.release, f.report),
    /Initial/,
  );
});

test('signed status files cannot be added or modified after export', async () => {
  const f = await receiptFixture();
  await exportReceipt(f);
  await put(
    f.reader,
    f.report.prefix + '/status-private.json',
    '{"BackendState":"Running"}',
  );
  await assert.rejects(
    verifyInstallationReport(f.reader, f.b, f.release, f.report),
    /report was changed/,
  );
});

test('stale result reports bounded request diagnostics without accepting it or changing reader files', async () => {
  const f = await receiptFixture();
  await exportReceipt(f);
  await verifyInstallationReport(f.reader, f.b, f.release, f.report);
  const next = 'c'.repeat(32);
  await rememberRequest(f.reader, f.b, next);
  await put(
    f.reader,
    '.adds/kobold/request.txt',
    'id=' + next + '\naction=status\nsecret=do-not-display\n',
  );
  await put(
    f.reader,
    '.adds/kobold/reports/' + next + '/runtime-private.txt',
    'Already running\nprivate-token-do-not-display\n',
  );
  const before = f.reader.writes.length;
  await assert.rejects(
    verifyInstallationReport(f.reader, f.b, f.release, f.report),
    (e) => {
      assert.match(e.message, /Queued action: status/);
      assert.match(e.message, /Requested result: absent/);
      assert.match(e.message, new RegExp('Expected request: ' + next));
      assert.match(e.message, /Runtime: Already running/);
      assert.match(e.message, /status-private.json: absent/);
      assert.doesNotMatch(e.message, /do-not-display/);
      return true;
    },
  );
  assert.equal(f.reader.writes.length, before);
});
