import test from 'node:test';
import assert from 'node:assert/strict';
import { hostMetadata } from '../web/lib/host-metadata.js';
import {
  excludeInstallerFolders,
  protectInstallerFolders,
} from '../web/lib/library-exclusion.js';
import { fixture, put } from './memory-fs.js';
import { readText } from '../web/lib/storage.js';
test('recognises only reserved OS names or sidecars with known companions', () => {
  const known = new Set(['bin/tailscale', 'runtime.sh']);
  for (const path of [
    '._bin',
    'bin/._tailscale',
    '._runtime.sh',
    '.DS_Store',
    'desktop.ini',
    'lib/Thumbs.db',
    '.directory',
  ])
    assert.equal(hostMetadata(path, known), true, path);
  for (const path of [
    'bin/uname',
    'lib/injected.so',
    '._unknown',
    'notes~',
    'desktop.ini.sh',
  ])
    assert.equal(hostMetadata(path, known), false, path);
});
test('exclusion preserves other settings, CRLF, existing rules and is idempotent', () => {
  const source =
    '[FeatureSettings]\r\nExcludeSyncFolders=private-books\r\n[Other]\r\nfoo=bar\r\n';
  const updated = excludeInstallerFolders(source);
  assert.ok(updated.includes('(?:private-books)|'));
  for (const name of ['kobold', 'kobold-preflight', 'kobold-connect'])
    assert.ok(updated.includes(name));
  assert.ok(updated.endsWith('[Other]\r\nfoo=bar\r\n'));
  assert.equal(excludeInstallerFolders(updated), updated);
  const encoded = updated.split('ExcludeSyncFolders=')[1].split('\r\n')[0];
  const regex = new RegExp(encoded.replaceAll('\\\\', '\\'));
  for (const path of [
    '.adds/kobold/releases/0.1.0/licenses/file.txt',
    '.adds/kobold-preflight/id',
    '.adds/kobold-connect/id',
  ])
    assert.ok(regex.test(path));
  for (const path of [
    'Books/novel.epub',
    '.kobo/anything',
    '.adobe-digital-editions/anything',
    '.adds/other-app',
  ])
    assert.equal(regex.test(path), false);
});
test('folder exclusion saves original configuration before updating and leaves books alone', async () => {
  const { reader, backup } = await fixture();
  const before = await readText(reader, '.kobo/Kobo/Kobo eReader.conf');
  await protectInstallerFolders(reader, { root: backup });
  const dir = await backup.getDirectoryHandle('settings-before-exclusion');
  for await (const [, h] of dir.entries())
    assert.equal(await (await h.getFile()).text(), before);
  assert.equal(await readText(reader, 'Books/keep.epub'), '\t\b\u0007');
  const writes = reader.writes.length;
  await protectInstallerFolders(reader, { root: backup });
  assert.equal(reader.writes.length, writes);
  await put(
    reader,
    '.kobo/Kobo/Kobo eReader.conf',
    '[FeatureSettings]\nExcludeSyncFolders="custom"\n',
  );
  await assert.rejects(
    protectInstallerFolders(reader, { root: backup }),
    /needs review/,
  );
});

test('normal exclusion setup refuses to change scan rules over existing installer files', async () => {
  for (const name of ['kobold', 'kobold-preflight', 'kobold-connect']) {
    const { reader, backup } = await fixture();
    await put(reader, '.adds/' + name + '/keep.txt', 'keep');
    const before = await readText(reader, '.kobo/Kobo/Kobo eReader.conf');
    reader.writes = [];
    backup.writes = [];
    await assert.rejects(
      protectInstallerFolders(reader, { root: backup }),
      /safe migration/,
    );
    assert.equal(await readText(reader, '.kobo/Kobo/Kobo eReader.conf'), before);
    assert.equal(await readText(reader, '.adds/' + name + '/keep.txt'), 'keep');
    assert.deepEqual(reader.writes, []);
    assert.deepEqual(backup.writes, []);
  }
});
