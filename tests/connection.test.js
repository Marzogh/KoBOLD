import { repairManagedPayload } from '../web/lib/managed-repair.js';
import { scanFixture as fixture } from './scan-fixture.js';
import { protectInstallerFolders } from '../web/lib/library-exclusion.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { signer, signedFixture } from './signing-fixture.js';
import { put, systemSnapshot } from './memory-fs.js';
import { backupReader, readText, fileHandle } from '../web/lib/storage.js';
import { hashFile, hashBytes } from '../web/lib/sha256.js';
import { beginInstallation, verifyInstallationReport } from '../web/lib/provenance.js';
import {
  previousRelease,
  readVerifiedReport,
  stageConnection,
  retryConnection,
  stageManagedUpgrade,
} from '../web/lib/connection.js';
import { updateBackup } from '../web/lib/automatic-backup.js';
async function setup(withLicense = false, previousChannel = 'attended-trial') {
  const { reader, backup } = await fixture();
  await protectInstallerFolders(reader, { root: backup });
  const b = await backupReader(reader, backup),
    s = signer(),
    data = new TextEncoder().encode('fixture'),
    entry = {
      path: 'SHA256SUMS',
      url: 'payload/SHA256SUMS',
      size: data.length,
      sha256: hashBytes(data),
    },
    profile = { id: 'libra-colour-390-4.46.23836', bootstrapAccepted: false };
  const files = withLicense
    ? [
        entry,
        {
          ...entry,
          path: 'licenses/TAILSCALE-LICENSE.txt',
          url: 'payload/licenses/TAILSCALE-LICENSE.txt',
        },
      ]
    : [entry];
  const previous = await signedFixture({
    channel: previousChannel,
    profile,
    installationDescriptorSha256: 'a'.repeat(64),
    files,
  });
  const nonce = 'a'.repeat(32);
  await beginInstallation(reader, b, previous, nonce);
  await put(reader, '.adds/kobold/releases/0.1.0/SHA256SUMS', data);
  const r = {
    installer: 'org.kobold.kobo-tailscale/v1',
    installationId: 'b'.repeat(32),
    identity: await hashFile(
      await (await fileHandle(reader, '.kobo/version')).getFile(),
    ),
    profile: profile.id,
    version: '0.1.0',
    release: previous.installationDescriptorSha256,
    publicKey: s.pub,
    sequence: 1,
    previous: '',
    nonce,
    status: 'prepared',
    files: {
      ['/mnt/onboard/.adds/kobold/releases/0.1.0/SHA256SUMS']: entry.sha256,
    },
    reportFiles: {},
  };
  async function report(value) {
    const prefix = '.adds/kobold/reports/' + value.nonce;
    await put(
      reader,
      prefix + '/installation.json',
      JSON.stringify(s.envelope(value, s.pub)),
    );
    await put(reader, prefix + '/result.txt', 'complete');
    await put(reader, '.adds/kobold/last-result.txt', value.nonce);
    return { id: value.nonce, prefix };
  }
  if (withLicense) {
    await put(
      reader,
      '.adds/kobold/releases/0.1.0/licenses/TAILSCALE-LICENSE.txt',
      data,
    );
    r.files['/mnt/onboard/.adds/kobold/releases/0.1.0/licenses/TAILSCALE-LICENSE.txt'] =
      entry.sha256;
  }
  const first = await report(r),
    pin = await verifyInstallationReport(reader, b, previous, first);
  await systemSnapshot(reader, b);
  const current = await updateBackup(reader, backup, b);
  const release = await signedFixture({
    channel: 'connection-trial',
    profile,
    installationDescriptorSha256: 'd'.repeat(64),
    files,
    continuation: {
      id: 'c'.repeat(32),
      previous,
      archive: {
        url: 'connection.tgz',
        sha256: entry.sha256,
        size: data.length,
      },
    },
  });
  return { reader, backup, b: current, s, r, pin, release, data, report };
}
test('continuation verifies previous signed reports and preserves pinned key/history across transition', async () => {
  const f = await setup();
  const old = await readVerifiedReport(f.reader, f.b, f.release);
  assert.equal(old.trust.descriptor, 'a'.repeat(64));
  await assert.rejects(stageConnection(f.reader, f.b, f.release, false), /Confirm/);
  const nonce = await stageConnection(f.reader, f.b, f.release, true, {
    fetcher: async () => ({ ok: true, arrayBuffer: async () => f.data.buffer }),
  });
  assert.equal(f.reader.writes.at(-1), '.kobo/KoboRoot.tgz');
  await f.report({
    ...f.r,
    nonce,
    sequence: 2,
    previous: f.pin.digest,
    previousRelease: f.r.release,
    release: f.release.installationDescriptorSha256,
  });
  const next = await readVerifiedReport(f.reader, f.b, f.release);
  assert.equal(next.trust.publicKey, f.pin.publicKey);
  assert.equal(next.trust.installationId, f.pin.installationId);
  assert.equal(next.trust.descriptor, 'd'.repeat(64));
});
test('a cross-release receipt without explicit continuity is refused', async () => {
  const f = await setup();
  const nonce = await stageConnection(f.reader, f.b, f.release, true, {
    fetcher: async () => ({ ok: true, arrayBuffer: async () => f.data.buffer }),
  });
  await f.report({
    ...f.r,
    nonce,
    sequence: 2,
    previous: f.pin.digest,
    release: f.release.installationDescriptorSha256,
  });
  await assert.rejects(
    readVerifiedReport(f.reader, f.b, f.release),
    /transition is not authorized/,
  );
});
test('recovery requests retain authenticated continuity when a backup pin is available', async () => {
  const f = await setup();
  const { queue } = await import('../web/lib/installer.js');
  const nonce = await queue(
    f.reader,
    'disable',
    {
      ip: '100.101.102.103',
      ports: '8083',
      hostname: 'kobo-reader',
      tag: 'tag:kobo-sync',
      owner: 'autogroup:admin',
    },
    f.b,
  );
  await f.report({
    ...f.r,
    nonce,
    sequence: 2,
    previous: f.pin.digest,
    status: 'disabled',
  });
  const result = await readVerifiedReport(f.reader, f.b, f.release);
  assert.equal(result.trust.status, 'disabled');
  assert.equal(await readText(f.reader, 'Books/keep.epub'), '\t\b\u0007');
});

test('metadata retry preserves nonce, signed identity and sidecars', async () => {
  const f = await setup();
  const nonce = await stageConnection(f.reader, f.b, f.release, true, {
    fetcher: async () => ({ ok: true, arrayBuffer: async () => f.data.buffer }),
  });
  await (await f.reader.getDirectoryHandle('.kobo')).removeEntry('KoboRoot.tgz');
  const base = '.adds/kobold-connect/' + f.release.continuation.id;
  await put(f.reader, base + '/error.txt', 'unlisted payload file refused');
  await put(f.reader, '.adds/kobold/releases/0.1.0/._SHA256SUMS', 'metadata');
  const release = await signedFixture({
    ...f.release,
    installationDescriptorSha256: 'e'.repeat(64),
    continuation: {
      ...f.release.continuation,
      retry: {
        reason: 'host-metadata',
        descriptor: f.release.installationDescriptorSha256,
      },
    },
  });
  const b = await updateBackup(f.reader, f.backup, f.b);
  const id = await retryConnection(f.reader, b, release, {
    fetcher: async () => ({ ok: true, arrayBuffer: async () => f.data.buffer }),
  });
  assert.equal(id, nonce);
  assert.equal(
    await readText(f.reader, '.adds/kobold/releases/0.1.0/._SHA256SUMS'),
    'metadata',
  );
  await f.report({
    ...f.r,
    nonce,
    sequence: 2,
    previous: f.pin.digest,
    previousRelease: f.r.release,
    release: release.installationDescriptorSha256,
  });
  await (
    await (
      await f.reader.getDirectoryHandle('.adds')
    ).getDirectoryHandle('kobold-connect')
  )
    .getDirectoryHandle(f.release.continuation.id)
    .then((d) => d.removeEntry('request.json'));
  assert.equal(
    (await readVerifiedReport(f.reader, b, release)).trust.descriptor,
    'e'.repeat(64),
  );
});

test('metadata retry refuses mismatched failure, transaction and unknown executable without queuing', async () => {
  for (const scenario of ['failure', 'descriptor', 'unknown']) {
    const f = await setup();
    await stageConnection(f.reader, f.b, f.release, true, {
      fetcher: async () => ({
        ok: true,
        arrayBuffer: async () => f.data.buffer,
      }),
    });
    await (await f.reader.getDirectoryHandle('.kobo')).removeEntry('KoboRoot.tgz');
    const base = '.adds/kobold-connect/' + f.release.continuation.id;
    await put(
      f.reader,
      base + '/error.txt',
      scenario === 'failure' ? 'other failure' : 'unlisted payload file refused',
    );
    if (scenario === 'unknown')
      await put(f.reader, '.adds/kobold/releases/0.1.0/bin/uname', 'unknown');
    const release = await signedFixture({
      ...f.release,
      installationDescriptorSha256: 'e'.repeat(64),
      continuation: {
        ...f.release.continuation,
        retry: {
          reason: 'host-metadata',
          descriptor:
            scenario === 'descriptor'
              ? 'f'.repeat(64)
              : f.release.installationDescriptorSha256,
        },
      },
    });
    const b = await updateBackup(f.reader, f.backup, f.b);
    await assert.rejects(
      retryConnection(f.reader, b, release),
      /only handles|does not match|Unexpected payload/,
    );
    await assert.rejects(readText(f.reader, '.kobo/KoboRoot.tgz'));
  }
});

test('repeat retry restores only the signed missing licence and preserves sidecar and backup', async () => {
  for (const corrupt of [false, true]) {
    const f = await setup(true);
    const fetcher = async () => ({
      ok: true,
      arrayBuffer: async () => f.data.buffer,
    });
    const nonce = await stageConnection(f.reader, f.b, f.release, true, {
      fetcher,
    });
    const kobo = await f.reader.getDirectoryHandle('.kobo');
    await kobo.removeEntry('KoboRoot.tgz');
    const base = '.adds/kobold-connect/' + f.release.continuation.id;
    await put(f.reader, base + '/error.txt', 'unlisted payload file refused');
    const release = await signedFixture({
      ...f.release,
      installationDescriptorSha256: 'e'.repeat(64),
      continuation: {
        ...f.release.continuation,
        retry: {
          reason: 'host-metadata',
          descriptor: f.release.installationDescriptorSha256,
        },
      },
    });
    let b = await updateBackup(f.reader, f.backup, f.b);
    await retryConnection(f.reader, b, release, { fetcher });
    await kobo.removeEntry('KoboRoot.tgz');
    const licenses = await (
      await (
        await (
          await (
            await f.reader.getDirectoryHandle('.adds')
          ).getDirectoryHandle('kobold')
        ).getDirectoryHandle('releases')
      ).getDirectoryHandle('0.1.0')
    ).getDirectoryHandle('licenses');
    await licenses.removeEntry('TAILSCALE-LICENSE.txt');
    await put(
      f.reader,
      '.adds/kobold/releases/0.1.0/licenses/._TAILSCALE-LICENSE.txt',
      'metadata',
    );
    await put(
      f.reader,
      base + '/error.txt',
      'lstat /mnt/onboard/.adds/kobold/releases/0.1.0/licenses/TAILSCALE-LICENSE.txt: no such file or directory',
    );
    b = await updateBackup(f.reader, f.backup, b);
    if (corrupt) {
      await assert.rejects(
        repairManagedPayload(f.reader, b, release, {
          fetcher: async () => ({
            ok: true,
            arrayBuffer: async () => new Uint8Array([0]).buffer,
          }),
        }),
        /integrity/,
      );
      await assert.rejects(readText(f.reader, '.kobo/KoboRoot.tgz'));
    } else {
      await repairManagedPayload(f.reader, b, release, { fetcher });
      b = await updateBackup(f.reader, f.backup, b);
      assert.equal(await retryConnection(f.reader, b, release, { fetcher }), nonce);
      assert.equal(
        await readText(
          f.reader,
          '.adds/kobold/releases/0.1.0/licenses/TAILSCALE-LICENSE.txt',
        ),
        'fixture',
      );
      assert.equal(
        await readText(
          f.reader,
          '.adds/kobold/releases/0.1.0/licenses/._TAILSCALE-LICENSE.txt',
        ),
        'metadata',
      );
      assert.equal(await readText(f.reader, 'Books/keep.epub'), '\t\b\u0007');
    }
  }
});
test('managed recovery uses the pinned saved receipt after a scan cycle and repairs any missing signed file, not only licences', async () => {
  const f = await setup();
  const { prepareScanProtection, confirmScanRestart, requireScanReady } = await import(
    '../web/lib/scan-protection.js'
  );
  await put(
    f.reader,
    '.kobo/Kobo/Kobo eReader.conf',
    '[OneStoreServices]\napi_endpoint=http://100.101.102.103:8083/kobo/0123456789abcdef0123456789abcdef\n',
  );
  let b = await updateBackup(f.reader, f.backup, f.b);
  await prepareScanProtection(f.reader, b, f.release);
  await assert.rejects(requireScanReady(f.reader, b));
  await confirmScanRestart(f.reader, b, true);
  const payload = await (
    await (
      await (await f.reader.getDirectoryHandle('.adds')).getDirectoryHandle('kobold')
    ).getDirectoryHandle('releases')
  ).getDirectoryHandle('0.1.0');
  await payload.removeEntry('SHA256SUMS');
  b = await updateBackup(f.reader, f.backup, b);
  const result = await repairManagedPayload(f.reader, b, f.release, {
    fetcher: async () => ({ ok: true, arrayBuffer: async () => f.data.buffer }),
  });
  assert.deepEqual(result.restored, ['SHA256SUMS']);
  assert.equal(
    await readText(f.reader, '.adds/kobold/releases/0.1.0/SHA256SUMS'),
    'fixture',
  );
  assert.equal(await readText(f.reader, 'Books/keep.epub'), '\t\b\u0007');
});

test('managed upgrade stages from saved receipt and verifies an interrupted prior commit without skipping history', async () => {
  for (const gap of [false, true]) {
    const f = await setup();
    const release = await signedFixture({
      ...f.release,
      jobProtocol: 2,
      continuation: {
        ...f.release.continuation,
        purpose: 'upgrade-managed-install',
      },
    });
    const { queue } = await import('../web/lib/installer.js');
    const oldNonce = await queue(
      f.reader,
      'status',
      {
        ip: '100.101.102.103',
        ports: '8083',
        hostname: 'kobo-reader',
        tag: 'tag:kobo-sync',
        owner: 'autogroup:admin',
      },
      f.b,
    );
    await (
      await (await f.reader.getDirectoryHandle('.adds')).getDirectoryHandle('kobold')
    ).removeEntry('request.txt');
    const b = await updateBackup(f.reader, f.backup, f.b);
    const nonce = await stageManagedUpgrade(f.reader, b, release, true, {
      fetcher: async () => ({
        ok: true,
        arrayBuffer: async () => f.data.buffer,
      }),
    });
    const prior = {
      ...f.r,
      nonce: oldNonce,
      sequence: 2,
      previous: gap ? '0'.repeat(64) : f.pin.digest,
      status: 'installed',
    };
    const env = f.s.envelope(prior, f.s.pub),
      payload = Uint8Array.from(Buffer.from(env.payload, 'base64')),
      digest = hashBytes(payload);
    await put(
      f.reader,
      '.adds/kobold/reports/' + nonce + '/prior-installation.json',
      JSON.stringify(env),
    );
    await f.report({
      ...f.r,
      nonce,
      sequence: 3,
      previous: digest,
      previousRelease: f.r.release,
      release: release.installationDescriptorSha256,
      status: 'installed',
    });
    await (
      await (
        await (
          await f.reader.getDirectoryHandle('.adds')
        ).getDirectoryHandle('kobold-connect')
      ).getDirectoryHandle(release.continuation.id)
    ).removeEntry('request.json');
    if (gap)
      await assert.rejects(readVerifiedReport(f.reader, b, release), /history gap/);
    else {
      assert.equal((await readVerifiedReport(f.reader, b, release)).trust.sequence, 3);
      assert.equal((await readVerifiedReport(f.reader, b, release)).trust.sequence, 3);
    }
  }
});

test('an old bridge busy error cannot mask completed transition or later signed status', async () => {
  const f = await setup(),
    nonce = await stageConnection(f.reader, f.b, f.release, true, {
      fetcher: async () => ({
        ok: true,
        arrayBuffer: async () => f.data.buffer,
      }),
    });
  const base = '.adds/kobold-connect/' + f.release.continuation.id;
  await put(f.reader, base + '/error.txt', 'reader is busy; reconnect and retry');
  await assert.rejects(readVerifiedReport(f.reader, f.b, f.release), /reader is busy/);
  await f.report({
    ...f.r,
    nonce,
    sequence: 2,
    previous: f.pin.digest,
    previousRelease: f.r.release,
    release: f.release.installationDescriptorSha256,
  });
  const next = await readVerifiedReport(f.reader, f.b, f.release);
  const { queue } = await import('../web/lib/installer.js');
  const check = await queue(
    f.reader,
    'status',
    {
      ip: '100.101.102.103',
      ports: '8083',
      hostname: 'kobo-reader',
      tag: 'tag:kobo-sync',
      owner: 'autogroup:admin',
    },
    f.b,
  );
  await f.report({
    ...f.r,
    nonce: check,
    sequence: 3,
    previous: next.trust.digest,
    release: f.release.installationDescriptorSha256,
    status: 'healthy',
  });
  assert.equal(
    (await readVerifiedReport(f.reader, f.b, f.release)).trust.status,
    'healthy',
  );
});

test('managed updates accept signed healthy and disabled reader states', async () => {
  for (const status of ['healthy', 'disabled']) {
    const f = await setup(false, 'tested');
    const release = await signedFixture({
      ...f.release,
      continuation: {
        ...f.release.continuation,
        purpose: 'upgrade-managed-install',
      },
    });
    const { queue } = await import('../web/lib/installer.js');
    const nonce = await queue(
      f.reader,
      'status',
      {
        ip: '100.101.102.103',
        ports: '8083',
        hostname: 'sample-kobo',
        tag: 'tag:kobo-sync',
        owner: 'autogroup:admin',
      },
      f.b,
    );
    const report = await f.report({
      ...f.r,
      nonce,
      sequence: 2,
      previous: f.pin.digest,
      status,
    });
    await verifyInstallationReport(f.reader, f.b, previousRelease(release), report);
    await (
      await (await f.reader.getDirectoryHandle('.adds')).getDirectoryHandle('kobold')
    ).removeEntry('request.txt');
    const backup = await updateBackup(f.reader, f.backup, f.b);
    await stageManagedUpgrade(f.reader, backup, release, true, {
      fetcher: async () => ({ ok: true, arrayBuffer: async () => f.data.buffer }),
    });
    assert.equal(f.reader.writes.at(-1), '.kobo/KoboRoot.tgz');
  }
});
