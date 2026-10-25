import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, put } from './memory-fs.js';
import { fileHandle } from '../web/lib/storage.js';
import { hashFile } from '../web/lib/sha256.js';
import { collectDiagnostics } from '../web/lib/diagnostics.js';
test('one read-only capture includes queued and historical stages without private log or status data', async () => {
  const { reader, backup } = await fixture(),
    identity = await hashFile(
      await (await fileHandle(reader, '.kobo/version')).getFile(),
    ),
    n = 'a'.repeat(32),
    old = 'b'.repeat(32);
  await put(
    backup,
    'kobold-installations/' + identity + '/pending.json',
    JSON.stringify({ nonce: n, kind: 'existing-install', identity }),
  );
  await put(reader, '.adds/kobold/last-result.txt', old);
  await put(
    reader,
    '.adds/kobold/reports/' + n + '/request.txt',
    'id=' + n + '\naction=status\nsecret=SECRET',
  );
  await put(
    reader,
    '.adds/kobold/reports/' + n + '/runtime-private.txt',
    'Already running\nSECRET https://login.tailscale.com/a/PRIVATE',
  );
  await put(
    reader,
    '.adds/kobold/reports/' + old + '/status-private.json',
    JSON.stringify({
      BackendState: 'Running',
      Self: { HostName: 'SECRET', Tags: ['PRIVATE'] },
      Health: [],
    }),
  );
  const writes = reader.writes.length,
    bwrites = backup.writes.length;
  const r = await collectDiagnostics(reader, backup),
    text = JSON.stringify(r);
  assert.equal(r.backupContentsScanned, false);
  assert.equal(r.reports[n].request.action, 'status');
  assert.equal(r.reports[n].result.present, false);
  assert.equal(r.reports[old].status.state, 'Running');
  assert.deepEqual(r.reports[n]['runtime-private.txt'].messages, ['Already running']);
  assert.doesNotMatch(text, /SECRET|PRIVATE|login.tailscale/);
  assert.equal(reader.writes.length, writes);
  assert.equal(backup.writes.length, bwrites);
});

import { latestReport } from '../web/lib/installer.js';
test('requested report never accepts an older latest pointer and recovers complete expected export', async () => {
  const { reader } = await fixture(),
    n = 'a'.repeat(32),
    old = 'b'.repeat(32);
  await put(reader, '.adds/kobold/last-result.txt', old);
  await put(reader, '.adds/kobold/reports/' + old + '/result.txt', 'complete');
  await assert.rejects(latestReport(reader, n), /has not finished/);
  await put(reader, '.adds/kobold/reports/' + n + '/result.txt', 'complete');
  assert.equal((await latestReport(reader, n)).id, n);
});
