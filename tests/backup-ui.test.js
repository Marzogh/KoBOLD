import test from 'node:test';
import assert from 'node:assert/strict';
import { browserSupport, backupProgress, backupFailure } from '../web/lib/backup-ui.js';
import { backupReader, exists, writeVerified } from '../web/lib/storage.js';
import { resumeBackup } from '../web/lib/installer.js';
import { fixture, put } from './memory-fs.js';
test('file actions require folder picker, writable files and a secure context', () => {
  const yes = {
    isSecureContext: true,
    showDirectoryPicker() {},
    FileSystemFileHandle: { prototype: { createWritable() {} } },
  };
  assert.equal(browserSupport(yes).fileAccess, true);
  for (const no of [
    { ...yes, showDirectoryPicker: undefined },
    { ...yes, isSecureContext: false },
    { ...yes, FileSystemFileHandle: undefined },
  ])
    assert.equal(browserSupport(no).fileAccess, false);
});
test('progress covers scanning, copying, both verification passes and final completion', async () => {
  const { reader, backup } = await fixture();
  await put(reader, 'Books/large.epub', new Uint8Array(250000));
  reader.writes = [];
  const events = [];
  await backupReader(reader, backup, (e) => events.push(e));
  for (const phase of [
    'scanning',
    'copying',
    'verifying-backup',
    'verifying-reader',
    'checking-reader',
    'finishing',
    'complete',
  ])
    assert(
      events.some((x) => x.phase === phase),
      phase,
    );
  let before = 0;
  for (const e of events) {
    const p = backupProgress(e);
    if (p.fraction !== null) {
      assert(p.fraction >= before);
      if (e.phase !== 'complete') assert(p.fraction < 1);
      before = p.fraction;
    }
  }
  assert.equal(events.at(-1).fraction, 1);
  assert.equal(events.at(-1).completedFiles, 5);
  assert.deepEqual(reader.writes, []);
  const checked = events.filter(
    (e) => e.phase === 'verifying-backup' && e.path === 'Books/large.epub',
  );
  assert.equal(checked[0].fileBytes, 0);
  assert.equal(checked.at(-1).fileBytes, 250000);
});
test('write failures retain operation, filename and original browser error', async () => {
  const { reader, backup } = await fixture();
  backup.fault = (path) =>
    path.endsWith('Books/keep.epub')
      ? new DOMException(
          'Underlying filesystem cannot be modified.',
          'InvalidModificationError',
        )
      : false;
  await assert.rejects(backupReader(reader, backup), (error) => {
    assert.equal(error.operation, 'Write backup file');
    assert.equal(error.path, 'Books/keep.epub');
    const shown = backupFailure(error);
    assert.equal(shown.title, 'Backup failed');
    assert.match(shown.reason, /different writable/);
    assert.match(shown.details, /Underlying filesystem/);
    return true;
  });
  assert.deepEqual(reader.writes, []);
});
test('cancelled scanning creates no accepted backup and does not modify the reader', async () => {
  const { reader, backup } = await fixture();
  await assert.rejects(
    backupReader(reader, backup, (e) => {
      if (e.phase === 'scanning') throw new DOMException('Cancelled', 'AbortError');
    }),
    { name: 'AbortError' },
  );
  assert.equal(
    [...backup.children.values()].filter((x) => x.kind === 'directory').length,
    0,
  );
  assert.deepEqual(reader.writes, []);
});
test('completion-marker failure cannot be resumed as a successful backup', async () => {
  const { reader, backup } = await fixture();
  backup.removeFault = (name) => name === 'INCOMPLETE.json';
  let session;
  await assert.rejects(backupReader(reader, backup), (error) => {
    assert.equal(error.operation, 'Mark backup complete');
    session = error.backupName;
    return true;
  });
  const folder = await backup.getDirectoryHandle(session);
  assert.equal(await exists(folder, 'manifest.json'), true);
  await assert.rejects(resumeBackup(reader, folder), /incomplete/);
});
test('protected macOS root folders are excluded and recorded; Kobo hidden files are retained', async () => {
  const { reader, backup } = await fixture();
  for (const name of ['.Spotlight-V100', '.fseventsd', '.Trashes', '.TemporaryItems']) {
    const dir = await reader.getDirectoryHandle(name, { create: true });
    dir.listError = new DOMException(
      'Protected operating-system index.',
      'InvalidModificationError',
    );
  }
  await put(reader, '.kobo/keep-hidden', 'settings');
  await put(reader, 'Books/.Spotlight-V100/keep.epub', 'book');
  const result = await backupReader(reader, backup);
  assert.equal(result.manifest.excluded.length, 4);
  assert(result.manifest.entries.some((x) => x.path === '.kobo/keep-hidden'));
  assert(
    result.manifest.entries.some((x) => x.path === 'Books/.Spotlight-V100/keep.epub'),
  );
  assert(!result.manifest.entries.some((x) => x.path.startsWith('.Spotlight-V100/')));
  assert.deepEqual(reader.writes, [
    '.kobo/keep-hidden',
    'Books/.Spotlight-V100/keep.epub',
  ]);
});
test('access errors in an ordinary Kobo folder still fail the whole backup', async () => {
  const { reader, backup } = await fixture();
  const books = await reader.getDirectoryHandle('Books');
  books.listError = new DOMException('Cannot read books.', 'NotReadableError');
  await assert.rejects(backupReader(reader, backup), (error) => {
    assert.equal(error.operation, 'Read folder');
    assert.equal(error.path, 'Books/');
    return true;
  });
});
