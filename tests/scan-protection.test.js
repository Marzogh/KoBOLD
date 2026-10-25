import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, put } from './memory-fs.js';
import { backupReader, readText, exists } from '../web/lib/storage.js';
import {
  prepareScanProtection,
  confirmScanRestart,
  scanPreparation,
  requireScanReady,
} from '../web/lib/scan-protection.js';
test('config-only preparation cannot stage files until explicit restart confirmation, survives refresh, and binds reader/rule', async () => {
  const { reader, backup } = await fixture(),
    b = await backupReader(reader, backup);
  await assert.rejects(requireScanReady(reader, b), /fully restart/);
  await prepareScanProtection(reader, b, null);
  assert.deepEqual(reader.writes, ['.kobo/Kobo/Kobo eReader.conf']);
  assert.equal(await exists(reader, '.kobo/KoboRoot.tgz'), false);
  assert.equal((await scanPreparation(reader, b)).state, 'restart');
  await assert.rejects(confirmScanRestart(reader, b, false), /Confirm/);
  await assert.rejects(requireScanReady(reader, b), /fully restart/);
  await confirmScanRestart(reader, b, true);
  await requireScanReady(reader, b);
  assert.equal((await scanPreparation(reader, { root: backup })).state, 'ready');
  await put(
    reader,
    '.kobo/Kobo/Kobo eReader.conf',
    '[FeatureSettings]\nExcludeSyncFolders=changed\n',
  );
  await assert.rejects(requireScanReady(reader, b), /fully restart/);
});
test('folder preparation refuses an existing unmanaged payload before changing configuration', async () => {
  const { reader, backup } = await fixture();
  await put(reader, '.adds/kobold/releases/0.1.0/SHA256SUMS', 'unknown');
  const b = await backupReader(reader, backup),
    before = await readText(reader, '.kobo/Kobo/Kobo eReader.conf');
  reader.writes = [];
  await assert.rejects(prepareScanProtection(reader, b, {}));
  assert.equal(await readText(reader, '.kobo/Kobo/Kobo eReader.conf'), before);
  assert.deepEqual(reader.writes, []);
});

test('preparation restoration explains missing records separately from changed rules', async () => {
  const { reader, backup } = await fixture(),
    b = await backupReader(reader, backup);
  assert.equal((await scanPreparation(reader, b)).reason, 'no-record');
  await prepareScanProtection(reader, b, null);
  assert.equal((await scanPreparation(reader, b)).state, 'restart');
  await put(
    reader,
    '.kobo/Kobo/Kobo eReader.conf',
    (await readText(reader, '.kobo/Kobo/Kobo eReader.conf')).replace(
      'ExcludeSyncFolders=',
      'ExcludeSyncFolders=extra|',
    ),
  );
  assert.equal((await scanPreparation(reader, b)).reason, 'rule-changed');
});
