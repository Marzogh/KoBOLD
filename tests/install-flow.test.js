import test from 'node:test';
import assert from 'node:assert/strict';
import { signedFixture, signer } from './signing-fixture.js';
import { scanFixture } from './scan-fixture.js';
import { put, systemSnapshot } from './memory-fs.js';
import { backupReader, readText, fileHandle, exists } from '../web/lib/storage.js';
import { hashFile, hashBytes } from '../web/lib/sha256.js';
import { beginInstallation, verifyInstallationReport } from '../web/lib/provenance.js';
import {
  connectionInstallation,
  connectionCapable,
  inspectOnly,
} from '../web/lib/install-flow.js';
import {
  stage,
  queue,
  collectSystemBackup,
  configureEndpoint,
  enableStartup,
  latestReport,
} from '../web/lib/installer.js';
import { authorisationStep } from '../web/lib/authorisation-ui.js';
import { updateBackup } from '../web/lib/automatic-backup.js';
const config = {
  ip: '100.101.102.103',
  ports: '8083',
  hostname: 'sample-kobo',
  tag: 'tag:kobo-sync',
  owner: 'autogroup:admin',
};
test('connection capability requires a signed matching install, preserves inspect-only restrictions and never promotes hardware', async () => {
  const full = await signedFixture({
    channel: 'attended-trial',
    trial: { purpose: 'install-and-connect' },
    profile: { bootstrapAccepted: false },
  });
  assert(connectionCapable(full));
  assert(!inspectOnly(full));
  assert(
    connectionInstallation(full, {
      descriptor: full.installationDescriptorSha256,
      status: 'prepared',
    }),
  );
  assert(
    !connectionInstallation(
      { ...full },
      { descriptor: full.installationDescriptorSha256, status: 'prepared' },
    ),
  );
  assert(!connectionInstallation(full, { descriptor: 'wrong', status: 'prepared' }));
  assert(
    !connectionInstallation(full, {
      descriptor: full.installationDescriptorSha256,
      status: 'removed',
    }),
  );
  const old = await signedFixture({
    ...full,
    trial: { purpose: 'inspect-only' },
  });
  assert(inspectOnly(old));
  assert(!connectionCapable(old));
  assert.equal(full.profile.bootstrapAccepted, false);
});
test('fresh install goes directly through signed installation, authorisation, endpoint and startup without a continuation package', async () => {
  const { reader, backup } = await scanFixture();
  let b = await backupReader(reader, backup);
  const s = signer(),
    data = new TextEncoder().encode('fixture'),
    entry = {
      path: 'SHA256SUMS',
      url: 'payload/SHA256SUMS',
      size: data.length,
      sha256: hashBytes(data),
    },
    identity = await hashFile(
      await (await fileHandle(reader, '.kobo/version')).getFile(),
    );
  const preflight = {
    observedAt: new Date().toISOString(),
    identitySha256: identity,
    systemBackupSha256: hashBytes(data),
    systemBackupSize: data.length,
  };
  await put(backup, 'preflight/' + identity + '/system-before-trial.tar.gz', data);
  const release = await signedFixture({
    channel: 'attended-trial',
    profile: { id: 'libra-colour-390-4.46.23836', bootstrapAccepted: false },
    files: [entry],
    updates: { 'bootstrap.tgz': { ...entry, url: 'bootstrap.tgz' } },
    trial: {
      purpose: 'install-and-connect',
      profileId: 'libra-colour-390-4.46.23836',
      bootstrapSha256: entry.sha256,
      preflight,
      expires: new Date(Date.now() + 3600000).toISOString(),
    },
  });
  const nonce = await stage(reader, b, release, config, true, {
    trialAcknowledged: true,
    fetcher: async () => ({ ok: true, arrayBuffer: async () => data.buffer }),
  });
  assert.match(await readText(reader, '.adds/kobold/request.txt'), /action=inspect/);
  await (await reader.getDirectoryHandle('.kobo')).removeEntry('KoboRoot.tgz');
  await (
    await (await reader.getDirectoryHandle('.adds')).getDirectoryHandle('kobold')
  ).removeEntry('request.txt');
  let seq = 0,
    previous = '',
    report;
  const inst = 'a'.repeat(32);
  async function native(id, status, backend = null) {
    const prefix = '.adds/kobold/reports/' + id,
      value = {
        installer: 'org.kobold.kobo-tailscale/v1',
        installationId: inst,
        identity,
        profile: release.profile.id,
        version: '0.1.0',
        release: release.installationDescriptorSha256,
        publicKey: s.pub,
        sequence: ++seq,
        previous,
        nonce: id,
        status,
        files: {
          ['/mnt/onboard/.adds/kobold/releases/0.1.0/SHA256SUMS']: entry.sha256,
        },
        reportFiles: {},
      };
    if (backend) {
      const text = JSON.stringify(backend);
      await put(reader, prefix + '/status-private.json', text);
      value.reportFiles['status-private.json'] = hashBytes(
        new TextEncoder().encode(text),
      );
    }
    if (seq === 1) {
      await put(reader, '.adds/kobold/system-backup.tar.gz', data);
      const checksum = hashBytes(data) + '\n';
      await put(reader, prefix + '/system-backup.sha256', checksum);
      value.reportFiles['system-backup.sha256'] = hashBytes(
        new TextEncoder().encode(checksum),
      );
    }
    const env = s.envelope(value, s.pub);
    await put(reader, prefix + '/installation.json', JSON.stringify(env));
    await put(reader, prefix + '/result.txt', 'complete');
    await put(reader, '.adds/kobold/last-result.txt', id);
    report = await latestReport(reader);
    const trust = await verifyInstallationReport(reader, b, release, report);
    previous = trust.digest;
    return trust;
  }
  const installed = await native(nonce, 'prepared');
  assert(connectionInstallation(release, installed));
  assert.equal(
    authorisationStep({ active: true, systemBackup: false, configured: true }).disabled,
    true,
  );
  await collectSystemBackup(reader, b, report);
  b = await updateBackup(reader, backup, b);
  let id = await queue(reader, 'enrol', config, b);
  let trust = await native(id, 'installed', {
    BackendState: 'NeedsLogin',
    Health: [],
    Self: { Tags: [] },
  });
  assert(connectionInstallation(release, trust));
  assert.equal(
    authorisationStep({
      active: true,
      systemBackup: true,
      configured: true,
      status: report.status,
      signin: 'https://login.tailscale.com/a/test',
    }).action,
    'open',
  );
  await (
    await (await reader.getDirectoryHandle('.adds')).getDirectoryHandle('kobold')
  ).removeEntry('request.txt');
  id = await queue(reader, 'status', config, b);
  const running = {
    BackendState: 'Running',
    Health: [],
    Self: { Tags: ['tag:kobo-sync'] },
  };
  trust = await native(id, 'installed', running);
  await (
    await (await reader.getDirectoryHandle('.adds')).getDirectoryHandle('kobold')
  ).removeEntry('request.txt');
  b = await updateBackup(reader, backup, b);
  await configureEndpoint(reader, b, config, running);
  assert.match(
    await readText(reader, '.kobo/Kobo/Kobo eReader.conf'),
    /api_endpoint=http:\/\/100.101.102.103:8083\/kobo\//,
  );
  b = await updateBackup(reader, backup, b);
  id = await enableStartup(reader, b, config, running);
  trust = await native(id, 'healthy', running);
  assert.equal(trust.status, 'healthy');
  assert.equal(trust.sequence, 4);
  assert.equal(await exists(reader, '.adds/kobold-connect/request.json'), false);
  assert.equal(await readText(reader, 'Books/keep.epub'), '\t\b\u0007');
  assert.equal(release.profile.bootstrapAccepted, false);
});
test('a verified fresh reinstall archives prior records instead of overwriting them', async () => {
  const { reader, backup } = await scanFixture(),
    b = await backupReader(reader, backup),
    release = await signedFixture({});
  await beginInstallation(reader, b, release, 'a'.repeat(32));
  await assert.rejects(
    beginInstallation(reader, b, release, 'b'.repeat(32)),
    /fresh system collection/,
  );
  await beginInstallation(reader, b, release, 'b'.repeat(32), {
    freshRootVerified: true,
  });
  const old = JSON.parse(
    await readText(backup, 'retired-installations/' + 'b'.repeat(32) + '/pending.json'),
  );
  assert.equal(old.nonce, 'a'.repeat(32));
});
