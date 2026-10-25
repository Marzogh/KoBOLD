import { scanFixture as fixture } from './scan-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { signedFixture } from './signing-fixture.js';
import { put } from './memory-fs.js';
import { backupReader } from '../web/lib/storage.js';
import { hashFile, hashBytes } from '../web/lib/sha256.js';
import { fileHandle } from '../web/lib/storage.js';
import { trialGate, verifyTrialBackup } from '../web/lib/trial.js';
import { stage } from '../web/lib/installer.js';
const identity = { matched: true, profile: 'libra-colour-390-4.46.23836' },
  config = {
    ip: '100.101.102.103',
    ports: '8083',
    hostname: 'kobo-reader',
    tag: 'tag:kobo-sync',
    owner: 'autogroup:admin',
  };
async function trial(overrides = {}) {
  const now = Date.now(),
    data = new TextEncoder().encode('synthetic fixture; never executed'),
    entry = {
      path: 'SHA256SUMS',
      url: 'payload/SHA256SUMS',
      size: data.length,
      sha256: hashBytes(data),
    };
  const value = {
    profile: { id: identity.profile, bootstrapAccepted: false },
    files: [entry],
    updates: { 'bootstrap.tgz': { ...entry, url: 'bootstrap.tgz' } },
    channel: 'attended-trial',
    trial: {
      purpose: 'inspect-only',
      profileId: identity.profile,
      bootstrapSha256: entry.sha256,
      expires: new Date(now + 3600000).toISOString(),
      preflight: {
        observedAt: new Date(now - 1000).toISOString(),
        identitySha256: 'a'.repeat(64),
        systemBackupSha256: hashBytes(data),
        systemBackupSize: data.length,
      },
    },
    ...overrides,
  };
  return { release: await signedFixture(value), data };
}
test('inspect trial requires a trusted signature, exact profile/archive, fresh preflight and acknowledgement', async () => {
  const { release } = await trial();
  assert(trialGate(identity, release, true));
  assert.throws(() => trialGate(identity, release, false), /Acknowledge/);
  assert.throws(() => trialGate(identity, { ...release }, true), /signed/);
  assert.throws(
    () => trialGate({ ...identity, profile: 'other' }, release, true),
    /matching/,
  );
  assert.throws(
    () => trialGate(identity, release, true, Date.parse(release.trial.expires)),
    /expired/,
  );
  const wrong = await signedFixture({
    ...release,
    trial: { ...release.trial, bootstrapSha256: '0'.repeat(64) },
  });
  assert.throws(() => trialGate(identity, wrong, true), /matching/);
});
test('first trial requires a complete main backup and a verified original privileged snapshot', async () => {
  const { reader, backup } = await fixture(),
    b = await backupReader(reader, backup),
    { release, data } = await trial();
  const p = {
    ...release.trial.preflight,
    identitySha256: await hashFile(
      await (await fileHandle(reader, '.kobo/version')).getFile(),
    ),
  };
  await assert.rejects(
    verifyTrialBackup(reader, { ...b, skipped: true }, p),
    /complete/,
  );
  await assert.rejects(verifyTrialBackup(reader, b, p), /original/);
  await put(
    backup,
    'preflight/' + p.identitySha256 + '/system-before-trial.tar.gz',
    data,
  );
  await verifyTrialBackup(reader, b, p);
  await assert.rejects(
    verifyTrialBackup(reader, b, { ...p, identitySha256: '0'.repeat(64) }),
    /another reader/,
  );
  await put(
    backup,
    'preflight/' + p.identitySha256 + '/system-before-trial.tar.gz',
    'damaged',
  );
  await assert.rejects(verifyTrialBackup(reader, b, p), /does not match/);
});
test('trial staging remains opt-in and queues only inspect after both backups are checked', async () => {
  const { reader, backup } = await fixture(),
    b = await backupReader(reader, backup),
    { release, data } = await trial();
  const p = {
    ...release.trial.preflight,
    identitySha256: await hashFile(
      await (await fileHandle(reader, '.kobo/version')).getFile(),
    ),
  };
  const signed = await signedFixture({
    ...release,
    trial: { ...release.trial, preflight: p },
  });
  await put(
    backup,
    'preflight/' + p.identitySha256 + '/system-before-trial.tar.gz',
    data,
  );
  const fetcher = async () => ({
    ok: true,
    arrayBuffer: async () => data.buffer,
  });
  await assert.rejects(
    stage(reader, b, signed, config, true, { fetcher }),
    /Acknowledge/,
  );
  assert.deepEqual(reader.writes, []);
  await stage(reader, b, signed, config, true, {
    fetcher,
    trialAcknowledged: true,
  });
  const { readText } = await import('../web/lib/storage.js');
  assert.match(await readText(reader, '.adds/kobold/request.txt'), /action=inspect/);
  assert.equal(reader.writes.at(-1), '.kobo/KoboRoot.tgz');
  assert.equal(signed.profile.bootstrapAccepted, false);
});

test('normal staging uses previously prepared folders without editing exclusions, then saves a final checkpoint', async () => {
  const { reader, backup } = await fixture(),
    b = await backupReader(reader, backup),
    { release, data } = await trial();
  const p = {
    ...release.trial.preflight,
    identitySha256: await hashFile(
      await (await fileHandle(reader, '.kobo/version')).getFile(),
    ),
  };
  const signed = await signedFixture({
    ...release,
    trial: { ...release.trial, preflight: p },
  });
  await put(
    backup,
    'preflight/' + p.identitySha256 + '/system-before-trial.tar.gz',
    data,
  );
  const nonce = await stage(reader, b, signed, config, true, {
    fetcher: async () => ({ ok: true, arrayBuffer: async () => data.buffer }),
    trialAcknowledged: true,
  });
  const exclusion = reader.writes.indexOf('.kobo/Kobo/Kobo eReader.conf'),
    payload = reader.writes.indexOf('.adds/kobold/releases/0.1.0/SHA256SUMS');
  assert.equal(exclusion, -1);
  assert.ok(payload >= 0);
  const { readText } = await import('../web/lib/storage.js');
  const check = JSON.parse(
    await readText(backup, 'installation-checks/' + nonce + '/before-eject.json'),
  );
  assert.equal(check.phase, 'browser-before-eject');
  assert.deepEqual(check.files, [{ path: 'SHA256SUMS', sha256: hashBytes(data) }]);
  assert.equal(reader.writes.at(-1), '.kobo/KoboRoot.tgz');
});
test('normal installation refuses to queue when an earlier payload file disappears during later writes', async () => {
  const { reader, backup } = await fixture(),
    b = await backupReader(reader, backup),
    base = await trial();
  const files = ['licenses/TAILSCALE-LICENSE.txt', 'runtime.sh'].map((path) => ({
    path,
    url: 'payload/' + path,
    size: base.data.length,
    sha256: hashBytes(base.data),
  }));
  const p = {
    ...base.release.trial.preflight,
    identitySha256: await hashFile(
      await (await fileHandle(reader, '.kobo/version')).getFile(),
    ),
  };
  const signed = await signedFixture({
    ...base.release,
    files,
    trial: { ...base.release.trial, preflight: p },
  });
  await put(
    backup,
    'preflight/' + p.identitySha256 + '/system-before-trial.tar.gz',
    base.data,
  );
  reader.fault = (path) => {
    if (path.endsWith('/runtime.sh'))
      reader.children
        .get('.adds')
        .children.get('kobold')
        .children.get('releases')
        .children.get('0.1.0')
        .children.get('licenses')
        .children.delete('TAILSCALE-LICENSE.txt');
  };
  await assert.rejects(
    stage(reader, b, signed, config, true, {
      fetcher: async () => ({
        ok: true,
        arrayBuffer: async () => base.data.buffer,
      }),
      trialAcknowledged: true,
    }),
    /missing before eject/,
  );
  const { exists } = await import('../web/lib/storage.js');
  assert.equal(await exists(reader, '.kobo/KoboRoot.tgz'), false);
  assert.equal(await exists(reader, '.adds/kobold/INSTALL-INCOMPLETE.txt'), true);
});
