import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, put } from './memory-fs.js';
import { signedFixture } from './signing-fixture.js';
import { auditPayload, auditMessage } from '../web/lib/payload-audit.js';
test('read-only payload audit identifies extra names without deleting metadata or executables', async () => {
  const { reader } = await fixture();
  await put(reader, '.adds/kobold/releases/0.1.0/bin/tailscale', 'known');
  await put(reader, '.adds/kobold/releases/0.1.0/bin/uname', 'untrusted');
  await put(reader, '.adds/kobold/releases/0.1.0/._SHA256SUMS', 'metadata-like');
  const release = await signedFixture({ files: [{ path: 'bin/tailscale' }] });
  reader.writes = [];
  const audit = await auditPayload(reader, release);
  assert.deepEqual(audit.unexpected, ['._SHA256SUMS', 'bin/uname']);
  assert.match(auditMessage(audit), /bin\/uname/);
  assert.deepEqual(reader.writes, []);
  assert.equal(audit.paths.length, 3);
});
test('expected files from both authenticated transition versions are recognised', async () => {
  const { reader } = await fixture();
  await put(reader, '.adds/kobold/releases/0.1.0/runtime.sh', 'script');
  const release = await signedFixture({
    files: [],
    continuation: { previous: { files: [{ path: 'runtime.sh' }] } },
  });
  assert.deepEqual((await auditPayload(reader, release)).unexpected, []);
  await assert.rejects(auditPayload(reader, { ...release }), /signed release/);
});

test('diagnostic distinguishes missing files from filename casing without modifying the reader', async () => {
  const { reader } = await fixture();
  await put(
    reader,
    '.adds/kobold/releases/0.1.0/licenses/TAILSCALE-LICENSE.TXT',
    'license',
  );
  const release = await signedFixture({
    files: [{ path: 'licenses/TAILSCALE-LICENSE.txt' }, { path: 'runtime.sh' }],
  });
  reader.writes = [];
  const audit = await auditPayload(reader, release);
  assert.deepEqual(audit.missing, ['licenses/TAILSCALE-LICENSE.txt', 'runtime.sh']);
  assert.deepEqual(audit.caseDifferences, [
    {
      expected: 'licenses/TAILSCALE-LICENSE.txt',
      actual: 'licenses/TAILSCALE-LICENSE.TXT',
    },
  ]);
  assert.match(auditMessage(audit), /Filename casing differences/);
  assert.deepEqual(reader.writes, []);
});
