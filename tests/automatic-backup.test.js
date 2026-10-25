import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, put, systemSnapshot } from './memory-fs.js';
import { backupReader, readText, verifyBackup } from '../web/lib/storage.js';
import { requireSystemBackup } from '../web/lib/backup-store.js';
import { updateBackup } from '../web/lib/automatic-backup.js';
test('automatic incremental update preserves old versions and carries verified system recovery data', async () => {
  const { reader, backup } = await fixture(),
    old = await backupReader(reader, backup);
  await systemSnapshot(reader, old);
  await put(reader, 'Books/new.epub', 'new book');
  const events = [];
  const next = await updateBackup(reader, backup, old, (e) => events.push(e));
  assert.notEqual(next.name, old.name);
  assert.equal(await readText(old.snapshot, 'Books/keep.epub'), '\t\b\u0007');
  assert(await verifyBackup(next.snapshot, next.manifest));
  assert(await requireSystemBackup(reader, next));
  assert(events.some((e) => e.phase === 'copying'));
  assert(events.some((e) => e.phase === 'complete'));
  assert.equal(await updateBackup(reader, backup, next), next);
});
test('a failed automatic backup keeps prior recovery data and never marks completion', async () => {
  const { reader, backup } = await fixture(),
    old = await backupReader(reader, backup);
  await put(reader, 'new.epub', 'new');
  backup.fault = (path) => path.endsWith('new.epub');
  await assert.rejects(updateBackup(reader, backup, old));
  assert(await verifyBackup(old.snapshot, old.manifest));
});
