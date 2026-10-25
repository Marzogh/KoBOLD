import { scanFixture as fixture } from './scan-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { signer, signedFixture } from './signing-fixture.js';
import { trialGate } from '../web/lib/trial.js';
import { put } from './memory-fs.js';
import { backupReader, readText } from '../web/lib/storage.js';
import { hashBytes } from '../web/lib/sha256.js';
import {
  collectionPackage,
  stageCollection,
  collectPreflight,
  verifiedCollection,
} from '../web/lib/collection.js';
import { packageFixture } from './collection-fixture.js';

test('collection is opt-in, requires an intact full backup and refuses a queued update', async () => {
  const { reader, backup } = await fixture(),
    b = await backupReader(reader, backup),
    { m, fetcher } = await packageFixture();
  await assert.rejects(stageCollection(reader, b, m, false), /Confirm/);
  await assert.rejects(
    stageCollection(reader, { ...b, skipped: true }, m, true),
    /full verified/,
  );
  assert.deepEqual(reader.writes, []);
  await put(reader, '.kobo/KoboRoot.tgz', 'existing');
  await assert.rejects(
    stageCollection(reader, b, m, true, { fetcher }),
    /changed|queued/,
  );
  assert.equal(await readText(reader, '.kobo/KoboRoot.tgz'), 'existing');
});
test('app-only collection saves verified system archive, preserves originals, and pins later reports', async () => {
  const { reader, backup } = await fixture(),
    b = await backupReader(reader, backup),
    { m, s, bytes, fetcher } = await packageFixture();
  const nonce = await stageCollection(reader, b, m, true, { fetcher }),
    pending = JSON.parse(
      await readText(backup, 'collection/' + m.id + '/pending.json'),
    ),
    prefix = '.adds/kobold-preflight/' + m.id + '/reports/' + nonce;
  const r = {
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
  await put(reader, prefix + '/report.json', JSON.stringify(s.envelope(r, s.pub)));
  const result = await collectPreflight(reader, { root: backup }, m);
  assert(result.ready);
  const trial = await signedFixture({
    channel: 'attended-trial',
    profile: { id: m.profileId, bootstrapAccepted: false },
    files: [],
    updates: { 'bootstrap.tgz': { size: 1, sha256: 'a'.repeat(64) } },
    trial: {
      purpose: 'inspect-only',
      profileId: m.profileId,
      bootstrapSha256: 'a'.repeat(64),
      collection: { id: m.id, descriptorSha256: m.descriptorSha256 },
    },
  });
  assert(
    trialGate({ matched: true, profile: m.profileId }, trial, true, Date.now(), result),
  );
  assert.throws(() => trialGate({ matched: true, profile: m.profileId }, trial, true));
  assert.equal(
    verifiedCollection(result, {
      id: m.id,
      descriptorSha256: m.descriptorSha256,
    }),
    result.preflight,
  );
  assert.equal(
    await readText(
      backup,
      'preflight/' +
        pending.identitySha256 +
        '/' +
        m.id +
        '/' +
        nonce +
        '/system-before-trial.tar.gz',
    ),
    'fixture archive; never execute',
  );
  assert.equal(await readText(reader, 'Books/keep.epub'), '\t\b\u0007');
  const impostor = signer();
  await put(
    reader,
    prefix + '/report.json',
    JSON.stringify(impostor.envelope(r, impostor.pub)),
  );
  await assert.rejects(collectPreflight(reader, { root: backup }, m), /trusted/);
  result.ready = false;
  assert.throws(() =>
    verifiedCollection(result, {
      id: m.id,
      descriptorSha256: m.descriptorSha256,
    }),
  );
});
