import { verifiedCollectionFixture } from './collection-fixture.js';
import { signedFixture } from './signing-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, put, systemSnapshot } from './memory-fs.js';
import {
  backupReader,
  readText,
  verifyBackup,
  fileHandle,
  unchanged,
  exists,
} from '../web/lib/storage.js';
import {
  skipAcknowledgementFreshness,
  MAX_SKIP_ACK_AGE_MS,
  discoverBackups,
  openBackup,
  checkBackup,
  skipMainBackup,
  assertBackupChoice,
  requireSystemBackup,
} from '../web/lib/backup-store.js';
import { stage } from '../web/lib/installer.js';
test('skip-consent two-hour limit includes the boundary and rejects future/invalid dates', () => {
  const now = Date.now();
  assert(
    skipAcknowledgementFreshness(
      { created: new Date(now - MAX_SKIP_ACK_AGE_MS).toISOString() },
      now,
    ).fresh,
  );
  for (const created of [
    new Date(now - MAX_SKIP_ACK_AGE_MS - 1).toISOString(),
    new Date(now + 1).toISOString(),
    'bad',
  ])
    assert(!skipAcknowledgementFreshness({ created }, now).fresh);
});
test('incremental copies only changed/new files and preserves prior versions', async () => {
  const { reader, backup } = await fixture();
  const first = await backupReader(reader, backup);
  await put(reader, 'Books/keep.epub', 'new book');
  await put(reader, 'Books/another.epub', 'additional');
  const second = await backupReader(reader, backup);
  assert.equal(second.manifest.copiedFiles, 2);
  assert.equal(second.manifest.reusedFiles, 3);
  assert.equal(await readText(first.snapshot, 'Books/keep.epub'), '\t\b\u0007');
  assert.equal(await readText(second.snapshot, 'Books/keep.epub'), 'new book');
  assert(await verifyBackup(second.snapshot, second.manifest));
  const third = await backupReader(reader, backup);
  assert.equal(third.manifest.copiedFiles, 0);
  assert.equal(third.manifest.reusedFiles, 5);
  const seen = (await discoverBackups(reader, backup)).matches;
  const reopened = await openBackup(reader, third.directory, { root: backup });
  assert(await verifyBackup(reopened.snapshot, reopened.manifest));
  assert.equal(seen.length, 3);
  assert(third.manifest.entries.every((e) => e.storedIn !== third.name));
});
test('corrupt earlier file is copied again without overwriting the old backup', async () => {
  const { reader, backup } = await fixture();
  const first = await backupReader(reader, backup);
  await put(first.snapshot, 'Books/keep.epub', 'corrupt');
  const second = await backupReader(reader, backup);
  assert.equal(second.manifest.copiedFiles, 1);
  assert.equal(await readText(first.snapshot, 'Books/keep.epub'), 'corrupt');
  assert.equal(await readText(second.snapshot, 'Books/keep.epub'), '\t\b\u0007');
  assert(await verifyBackup(second.snapshot, second.manifest));
});
test('source is hashed even if size and timestamp are unchanged', async () => {
  const { reader, backup } = await fixture();
  await backupReader(reader, backup);
  const f = await fileHandle(reader, 'Books/keep.epub'),
    stamp = f.modified;
  await put(reader, 'Books/keep.epub', new Uint8Array([1, 2, 3]));
  f.modified = stamp;
  const second = await backupReader(reader, backup);
  assert.equal(second.manifest.copiedFiles, 1);
});
test('missing base prevents acceptance; a new backup repairs missing referenced files', async () => {
  const { reader, backup } = await fixture();
  const first = await backupReader(reader, backup);
  const second = await backupReader(reader, backup);
  const books = await first.snapshot.getDirectoryHandle('Books');
  await books.removeEntry('keep.epub');
  await assert.rejects(verifyBackup(second.snapshot, second.manifest));
  const third = await backupReader(reader, backup);
  assert.equal(third.manifest.copiedFiles, 1);
  assert(await verifyBackup(third.snapshot, third.manifest));
});
test('old matching backups remain valid, while recent changed backups fail', async () => {
  const { reader, backup } = await fixture();
  const first = await backupReader(reader, backup);
  first.manifest.created = new Date(Date.now() - 365 * 24 * 3600000).toISOString();
  assert.equal(
    (await assertBackupChoice(reader, first, { current: true })).status,
    'verified',
  );
  assert.equal((await checkBackup(reader, first)).usable, true);
  first.manifest.created = new Date().toISOString();
  await put(reader, 'Books/keep.epub', 'changed');
  assert.equal((await checkBackup(reader, first)).usable, false);
  await assert.rejects(assertBackupChoice(reader, first, { current: true }), /changed/);
});
test('new and deleted reader files invalidate currentness', async () => {
  const { reader, backup } = await fixture();
  const b = await backupReader(reader, backup);
  await put(reader, 'new.epub', 'added');
  await assert.rejects(unchanged(reader, b.manifest), /changed/);
  assert(!(await checkBackup(reader, b)).usable);
});
test('skip requires acknowledgement, is recorded separately, and does not bypass system backup', async () => {
  const { reader, backup } = await fixture();
  await assert.rejects(skipMainBackup(reader, backup, false), /Acknowledge/);
  const skipped = await skipMainBackup(reader, backup, true);
  assert.equal(await exists(skipped.directory, 'manifest.json'), false);
  assert.equal((await assertBackupChoice(reader, skipped)).status, 'skipped');
  await assert.rejects(requireSystemBackup(reader, skipped));
  await systemSnapshot(reader, skipped);
  assert(await requireSystemBackup(reader, skipped));
  await assert.rejects(
    assertBackupChoice(reader, skipped, {
      now: Date.parse(skipped.receipt.created) + MAX_SKIP_ACK_AGE_MS + 1,
    }),
    /expired/,
  );
  assert.equal((await discoverBackups(reader, backup)).matches.length, 0);
});
test('references cannot escape the selected backup folder', async () => {
  const { reader, backup } = await fixture(),
    b = await backupReader(reader, backup);
  b.manifest.entries[0].storedIn = '../../private';
  await put(b.directory, 'manifest.json', JSON.stringify(b.manifest));
  await assert.rejects(openBackup(reader, b.directory, { root: backup }), /reference/);
});
test('cancelling an incremental backup leaves all prior generations valid', async () => {
  const { reader, backup } = await fixture();
  const b = await backupReader(reader, backup);
  await assert.rejects(
    backupReader(reader, backup, (e) => {
      if (e.phase === 'checking-existing')
        throw new DOMException('Cancelled', 'AbortError');
    }),
    /Cancelled/,
  );
  assert(await verifyBackup(b.snapshot, b.manifest));
  const found = await discoverBackups(reader, backup);
  assert.equal(found.matches.length, 1);
  assert(found.issues.some((e) => /Incomplete/.test(e.message)));
});
test('legacy full manifests are discovered and reused without rewriting them', async () => {
  const { reader, backup } = await fixture();
  const first = await backupReader(reader, backup);
  const legacy = {
    format: 1,
    status: 'verified',
    created: first.manifest.created,
    entries: first.manifest.entries,
  };
  await put(first.directory, 'manifest.json', JSON.stringify(legacy));
  const second = await backupReader(reader, backup);
  assert.equal(second.manifest.reusedFiles, 4);
  assert.equal(JSON.parse(await readText(first.directory, 'manifest.json')).format, 1);
  assert(await verifyBackup(second.snapshot, second.manifest));
});
test('Windows and Linux volume metadata is excluded only at the root', async () => {
  const { reader, backup } = await fixture();
  for (const name of [
    '$RECYCLE.BIN',
    'System Volume Information',
    '.Trash',
    '.Trash-1000',
  ]) {
    const d = await reader.getDirectoryHandle(name, { create: true });
    d.listError = new DOMException('Protected metadata', 'NotAllowedError');
  }
  await put(reader, 'Books/.Trash/keep.epub', 'keep');
  const b = await backupReader(reader, backup);
  assert.equal(b.manifest.excluded.length, 4);
  assert(b.manifest.entries.some((e) => e.path === 'Books/.Trash/keep.epub'));
});
test('a skip receipt remains truthful and cannot bypass fresh-install full-backup requirements', async () => {
  const { hashBytes } = await import('../web/lib/sha256.js');
  const { reader, backup } = await fixture(),
    collected = await verifiedCollectionFixture(reader, backup),
    skipped = await skipMainBackup(reader, backup, true),
    data = new TextEncoder().encode('fixture'),
    entry = {
      path: 'SHA256SUMS',
      url: 'payload/SHA256SUMS',
      size: data.length,
      sha256: hashBytes(data),
    };
  const release = await signedFixture({
    profile: { id: 'libra-colour-390-4.46.23836', bootstrapAccepted: false },
    files: [entry],
    updates: { 'bootstrap.tgz': { ...entry, url: 'bootstrap.tgz' } },
  });
  await assert.rejects(
    stage(reader, skipped, release, { ip: '100.101.102.103', ports: '8083' }, true),
    /not yet available/,
  );
  const accepted = await signedFixture({
    ...release,
    preflight: collected.preflight,
    profile: {
      ...release.profile,
      bootstrapAccepted: true,
      bootstrapEvidence: { fixtureOnly: true },
    },
  });
  await assert.rejects(
    stage(reader, skipped, accepted, { ip: '100.101.102.103', ports: '8083' }, true, {
      collectionResult: collected.collectionResult,
      fetcher: async () => ({ ok: true, arrayBuffer: async () => data.buffer }),
    }),
    /complete Kobo backup/,
  );
  const receipt = JSON.parse(await readText(skipped.directory, 'SKIPPED.json'));
  assert.equal(receipt.status, 'skipped');
  assert.equal(receipt.riskAcknowledged, true);
  assert.equal(await exists(reader, '.kobo/KoboRoot.tgz'), false);
  await assert.rejects(requireSystemBackup(reader, skipped));
});
