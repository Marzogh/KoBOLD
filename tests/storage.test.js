import { verifiedCollectionFixture } from './collection-fixture.js';
import { signedFixture } from './signing-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, put, MemoryDirectory, systemSnapshot } from './memory-fs.js';
import {
  backupReader,
  verifyBackup,
  readText,
  separateLocations,
  unchanged,
  writeVerified,
  exists,
  fileHandle,
} from '../web/lib/storage.js';
import {
  stage,
  getRelease,
  latestReport,
  healthy,
  endpointMatches,
  configureEndpoint,
  HOME,
} from '../web/lib/installer.js';
const config = {
  ip: '100.101.102.103',
  ports: '8083',
  tag: 'tag:kobo-sync',
  hostname: 'kobo-reader',
  owner: 'autogroup:admin',
};
test('complete USB backup includes books/config/database and verifies without reader writes', async () => {
  const { reader, backup } = await fixture();
  const b = await backupReader(reader, backup);
  assert.equal(b.manifest.status, 'verified');
  assert.equal(b.manifest.entries.length, 4);
  assert(await verifyBackup(b.snapshot, b.manifest));
  assert.deepEqual(reader.writes, []);
  assert.equal(await exists(b.directory, 'INCOMPLETE.json'), false);
});
test('backup destination cannot be the reader, its descendant or its ancestor', async () => {
  const root = new MemoryDirectory(),
    reader = await root.getDirectoryHandle('reader', { create: true }),
    child = await reader.getDirectoryHandle('backups', { create: true });
  for (const dest of [root, reader, child])
    await assert.rejects(separateLocations(reader, dest), /separate/);
});
test('interrupted backup remains incomplete, cannot be accepted', async () => {
  const { reader, backup } = await fixture();
  await assert.rejects(
    backupReader(reader, backup, (event) => {
      if (event.phase === 'copying') throw new DOMException('Cancelled', 'AbortError');
    }),
    /Cancelled/,
  );
  const dirs = [...backup.children.values()];
  assert.equal(dirs.length, 1);
  assert.equal(await exists(dirs[0], 'INCOMPLETE.json'), true);
  assert.equal(await exists(dirs[0], 'manifest.json'), false);
  assert.deepEqual(reader.writes, []);
});
test('corruption and reader changes invalidate a backup', async () => {
  const { reader, backup } = await fixture();
  const b = await backupReader(reader, backup);
  await put(b.snapshot, 'Books/keep.epub', 'corrupt');
  await assert.rejects(verifyBackup(b.snapshot, b.manifest), /manifest/);
  await put(reader, 'Books/keep.epub', 'changed');
  await assert.rejects(unchanged(reader, b.manifest), /changed/);
});
test('untested bootstrap is locked before fetch or reader mutation', async () => {
  const { reader, backup } = await fixture();
  const b = await backupReader(reader, backup);
  await assert.rejects(
    stage(
      reader,
      b,
      await signedFixture({
        profile: {
          id: 'libra-colour-390-4.46.23836',
          bootstrapAccepted: false,
        },
      }),
      config,
      true,
      {
        fetcher: () => {
          throw Error('must not fetch');
        },
      },
    ),
    /not yet available/,
  );
  assert.deepEqual(reader.writes, []);
});
test('manifest rejects traversal and forged sign-in URLs', async () => {
  await assert.rejects(
    getRelease(async () => ({
      ok: true,
      json: async () => ({
        schema: 1,
        version: '0.1.0',
        profile: { id: 'libra-colour-390-4.46.23836' },
        files: [{ path: '../escape', url: 'x', sha256: 'a'.repeat(64), size: 1 }],
      }),
    })),
    /Unsafe/,
  );
  const { reader } = await fixture(),
    id = 'a'.repeat(32);
  await put(reader, HOME + '/last-result.txt', id);
  await put(reader, HOME + '/reports/' + id + '/result.txt', 'complete');
  await put(
    reader,
    HOME + '/reports/' + id + '/sign-in.txt',
    'https://evil.test/a/token',
  );
  await assert.rejects(latestReport(reader), /Unexpected/);
});
test('endpoint update requires tag and healthy state, keeps fresh private copy', async () => {
  const { reader, backup } = await fixture(),
    b = await backupReader(reader, backup);
  const status = {
    BackendState: 'Running',
    Health: [],
    Self: { Tags: ['tag:kobo-sync'] },
  };
  assert.throws(() => healthy({ ...status, Health: ['firewall failed'] }, config));
  assert.throws(() => healthy({ ...status, Self: { Tags: [] } }, config));
  const before = await readText(reader, '.kobo/Kobo/Kobo eReader.conf');
  await systemSnapshot(reader, b);
  await configureEndpoint(reader, b, config, status);
  assert.equal(
    await readText(reader, '.kobo/Kobo/Kobo eReader.conf'),
    before.replace('192.168.0.10', config.ip),
  );
  const saved = [...b.directory.children.keys()].find((n) =>
    n.startsWith('before-endpoint-'),
  );
  assert.equal(await readText(b.directory, saved), before);
  assert.equal(await readText(reader, 'Books/keep.epub'), '\t\b\u0007');
});
test('exclusive writes preserve existing files', async () => {
  const { reader } = await fixture();
  await assert.rejects(
    writeVerified(reader, 'Books/keep.epub', 'erase', { exclusive: true }),
    /overwrite/,
  );
  const f = await (await fileHandle(reader, 'Books/keep.epub')).getFile();
  assert.deepEqual(new Uint8Array(await f.arrayBuffer()), new Uint8Array([9, 8, 7]));
});
test('resume verifies backup and reader identity without relying on browser storage', async () => {
  const { resumeBackup } = await import('../web/lib/installer.js');
  const { reader, backup } = await fixture(),
    b = await backupReader(reader, backup);
  const resumed = await resumeBackup(reader, b.directory);
  assert.equal(resumed.name, b.name);
  await put(reader, '.kobo/version', 'N428-OTHER,4.9.77,4.46.23836,x,y,000000000390');
  await assert.rejects(resumeBackup(reader, b.directory), /different/);
});
test('promoted fixture stages only package paths and queues root archive last', async () => {
  const { hashBytes } = await import('../web/lib/sha256.js');
  const { reader, backup } = await fixture(),
    collected = await verifiedCollectionFixture(reader, backup),
    b = collected.backup;
  const bytes = new TextEncoder().encode('synthetic fixture, never executed'),
    entry = {
      path: 'SHA256SUMS',
      url: 'payload/SHA256SUMS',
      size: bytes.length,
      sha256: hashBytes(bytes),
    },
    update = {
      url: 'bootstrap.tgz',
      size: bytes.length,
      sha256: hashBytes(bytes),
    };
  const release = await signedFixture({
    preflight: collected.preflight,
    profile: {
      id: 'libra-colour-390-4.46.23836',
      bootstrapAccepted: true,
      bootstrapEvidence: { fixtureOnly: true },
    },
    files: [entry],
    updates: { 'bootstrap.tgz': update },
  });
  const fetcher = async () => ({
    ok: true,
    arrayBuffer: async () => bytes.buffer,
  });
  await stage(reader, b, release, config, true, {
    fetcher,
    collectionResult: collected.collectionResult,
  });
  assert.equal(reader.writes.at(-1), '.kobo/KoboRoot.tgz');
  assert.equal(await exists(reader, HOME + '/INSTALL-INCOMPLETE.txt'), false);
  assert.equal(await exists(reader, HOME + '/request.txt'), true);
  assert(!reader.writes.includes('Books/keep.epub'));
});
test('failed root queue write is cleaned up without deleting books or backup evidence', async () => {
  const { hashBytes } = await import('../web/lib/sha256.js');
  const { reader, backup } = await fixture(),
    collected = await verifiedCollectionFixture(reader, backup),
    b = collected.backup;
  const bytes = new TextEncoder().encode('fixture'),
    entry = {
      path: 'SHA256SUMS',
      url: 'payload/SHA256SUMS',
      size: bytes.length,
      sha256: hashBytes(bytes),
    };
  const release = await signedFixture({
    preflight: collected.preflight,
    profile: {
      id: 'libra-colour-390-4.46.23836',
      bootstrapAccepted: true,
      bootstrapEvidence: { fixtureOnly: true },
    },
    files: [entry],
    updates: { 'bootstrap.tgz': { ...entry, url: 'bootstrap.tgz' } },
  });
  reader.fault = (path) => path === '.kobo/KoboRoot.tgz';
  await assert.rejects(
    stage(reader, b, release, config, true, {
      collectionResult: collected.collectionResult,
      fetcher: async () => ({
        ok: true,
        arrayBuffer: async () => bytes.buffer,
      }),
    }),
    /Injected/,
  );
  assert.equal(await exists(reader, '.kobo/KoboRoot.tgz'), false);
  assert.equal(await exists(reader, HOME + '/INSTALL-INCOMPLETE.txt'), true);
  assert.equal(await exists(reader, 'Books/keep.epub'), true);
  assert(await verifyBackup(b.snapshot, b.manifest));
});

test('existing sync endpoint is recognised without writes only for the exact service and healthy tag', async () => {
  const { reader } = await fixture(),
    path = '.kobo/Kobo/Kobo eReader.conf',
    good = {
      BackendState: 'Running',
      Health: [],
      Self: { Tags: ['tag:kobo-sync'] },
    };
  assert.equal(await endpointMatches(reader, config, good), false);
  const old = await readText(reader, path);
  await put(reader, path, old.replace('192.168.0.10', config.ip));
  const writes = reader.writes.length;
  assert.equal(await endpointMatches(reader, config, good), true);
  assert.equal(
    await endpointMatches(reader, { ...config, ports: '8084' }, good),
    false,
  );
  assert.equal(
    await endpointMatches(reader, { ...config, ports: '8083,8084' }, good),
    false,
  );
  await assert.rejects(
    endpointMatches(reader, config, { ...good, Health: ['warning'] }),
  );
  assert.equal(reader.writes.length, writes);
});
