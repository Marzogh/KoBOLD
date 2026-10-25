import { auditPayload } from './payload-audit.js';
import { requireScanReady } from './scan-protection.js';
import {
  requireSignedRelease,
  inheritedRelease,
  verifyInstallationReport,
  beginTransition,
  verifyMetadataRetry,
  requestedReportId,
  managedInstallation,
} from './provenance.js';
import { assertBackupChoice, requireSystemBackup } from './backup-store.js';
import { latestReport, asset, HOME } from './installer.js';
import { readText, writeVerified, exists } from './storage.js';
export function previousRelease(release) {
  requireSignedRelease(release);
  const c = release.continuation;
  if (
    release.channel !== 'connection-trial' ||
    !c?.previous ||
    !/^[a-f0-9]{32}$/.test(c.id) ||
    ![
      'attended-trial',
      ...(c.purpose === 'upgrade-managed-install'
        ? ['connection-trial', 'tested']
        : []),
    ].includes(c.previous.channel) ||
    c.previous.profile.id !== release.profile.id ||
    c.previous.installationDescriptorSha256 === release.installationDescriptorSha256
  )
    throw Error('No authorized continuation is available.');
  return inheritedRelease(release, c.previous);
}
/** Ignore unrelated helper errors and authenticate the requested installation result. */
export async function readVerifiedReport(reader, backup, release) {
  const expected = await requestedReportId(reader, backup);
  if (release.continuation) {
    const base = '.adds/kobold-connect/' + release.continuation.id;
    if (
      (await exists(reader, base + '/request.json')) &&
      (await exists(reader, base + '/error.txt'))
    ) {
      const request = JSON.parse(await readText(reader, base + '/request.json'));
      const result = HOME + '/reports/' + expected + '/result.txt';
      const complete =
        (await exists(reader, result)) &&
        (await readText(reader, result)).trim() === 'complete';
      if (request.id === expected && !complete) {
        const detail = (await readText(reader, base + '/error.txt')).trim();
        if (detail)
          throw Error('Connection setup did not finish: ' + detail.slice(0, 700));
      }
    }
  }
  const report = await latestReport(
    reader,
    release.jobProtocol === 2 ? expected : null,
  );
  let active = release;
  if (release.channel === 'connection-trial') {
    const envelope = JSON.parse(
      await readText(reader, report.prefix + '/installation.json'),
    );
    let descriptor;
    try {
      descriptor = JSON.parse(atob(envelope.payload)).release;
    } catch {
      throw Error('Invalid installation receipt');
    }
    const previous = previousRelease(release);
    if (descriptor === previous.installationDescriptorSha256) active = previous;
    else if (descriptor !== release.installationDescriptorSha256)
      throw Error('Unknown installed release');
  }
  const trust = await verifyInstallationReport(reader, backup, active, report);
  return { report, trust, active };
}
/** Stage a signed continuation only from the exact verified previous installation. */
export async function stageConnection(
  reader,
  backup,
  release,
  acknowledged,
  { fetcher = fetch, progress = () => {} } = {},
) {
  const previous = previousRelease(release);
  if (!acknowledged)
    throw Error('Confirm the connection setup changes before continuing.');
  await assertBackupChoice(reader, backup, { current: true });
  await requireSystemBackup(reader, backup);
  const { trust } = await readVerifiedReport(reader, backup, release);
  if (
    trust.descriptor !== previous.installationDescriptorSha256 ||
    trust.status !== 'prepared'
  )
    throw Error('This continuation requires the verified inspected installation.');
  if (
    (await exists(reader, '.kobo/KoboRoot.tgz')) ||
    (await exists(reader, HOME + '/request.txt'))
  )
    throw Error(
      'A reader update or job is already queued. Finish it before continuing.',
    );
  const c = release.continuation;
  if (c.archive?.url !== 'connection.tgz' || !/^[a-f0-9]{64}$/.test(c.archive.sha256))
    throw Error('Invalid connection archive metadata');
  progress('Downloading and verifying connection files');
  const data = await asset(c.archive, fetcher),
    id = crypto.randomUUID().replaceAll('-', ''),
    base = '.adds/kobold-connect/' + c.id;
  if (await exists(reader, base + '/request.json'))
    throw Error('Connection setup is already queued.');
  await requireScanReady(reader, backup);
  await beginTransition(
    reader,
    backup,
    release,
    id,
    previous.installationDescriptorSha256,
  );
  await writeVerified(
    reader,
    base + '/INCOMPLETE.txt',
    'Keep USB connected until preparation completes.\n',
    { exclusive: true },
  );
  await writeVerified(
    reader,
    base + '/request.json',
    JSON.stringify({ id, identitySha256: trust.identity }),
    { exclusive: true },
  );
  progress('Writing and checking connection package');
  await writeVerified(reader, base + '/verified.tgz', data, {
    exclusive: true,
  });
  try {
    await writeVerified(reader, '.kobo/KoboRoot.tgz', data, {
      exclusive: true,
    });
  } catch (e) {
    try {
      await (await reader.getDirectoryHandle('.kobo')).removeEntry('KoboRoot.tgz');
    } catch {
      throw Error(
        'Queue cleanup failed. Keep USB connected and follow recovery instructions.',
      );
    }
    throw e;
  }
  const d = await (
    await (
      await reader.getDirectoryHandle('.adds')
    ).getDirectoryHandle('kobold-connect')
  ).getDirectoryHandle(c.id);
  await d.removeEntry('INCOMPLETE.txt');
  return id;
}
export async function retryConnection(
  reader,
  backup,
  release,
  { fetcher = fetch, progress = () => {} } = {},
) {
  requireSignedRelease(release);
  await assertBackupChoice(reader, backup, { current: true });
  await requireSystemBackup(reader, backup);
  if (
    (await exists(reader, '.kobo/KoboRoot.tgz')) ||
    (await exists(reader, HOME + '/request.txt'))
  )
    throw Error('Another reader update or job is queued.');
  const c = release.continuation,
    base = '.adds/kobold-connect/' + c.id;
  const failure = (await readText(reader, base + '/error.txt')).trim();
  if (
    ![
      'unlisted payload file refused',
      'lstat /mnt/onboard/' +
        HOME +
        '/releases/0.1.0/licenses/TAILSCALE-LICENSE.txt: no such file or directory',
    ].includes(failure)
  )
    throw Error(
      'This retry only handles the metadata refusal or missing installer licence.',
    );
  const request = JSON.parse(await readText(reader, base + '/request.json'));
  const verified = await verifyMetadataRetry(reader, backup, release, request);
  const audit = await auditPayload(reader, release);
  if (audit.unexpected.length)
    throw Error('Unexpected payload files remain: ' + audit.unexpected.join(', '));
  progress('Downloading and verifying the corrected connection package');
  const data = await asset(c.archive, fetcher);
  await writeVerified(
    backup.root,
    'connection-retries/' + request.id + '/original-error.txt',
    await readText(reader, base + '/error.txt'),
  );
  await requireScanReady(reader, backup);
  await beginTransition(
    reader,
    backup,
    release,
    verified.id,
    c.previous.installationDescriptorSha256,
  );
  progress('Writing and verifying the retry package');
  await writeVerified(reader, base + '/verified.tgz', data);
  await writeVerified(reader, '.kobo/KoboRoot.tgz', data, { exclusive: true });
  return verified.id;
}

/** Back up continuity records and queue a scoped, signed existing-install update. */
export async function stageManagedUpgrade(
  reader,
  backup,
  release,
  acknowledged,
  { fetcher = fetch, progress = () => {} } = {},
) {
  const previous = previousRelease(release),
    c = release.continuation;
  if (c.purpose !== 'upgrade-managed-install' || !acknowledged)
    throw Error('Confirm this managed installation update before continuing.');
  await assertBackupChoice(reader, backup, { current: true });
  await requireSystemBackup(reader, backup);
  await requireScanReady(reader, backup);
  const proof = await managedInstallation(reader, backup, release);
  if (
    proof.release.installationDescriptorSha256 !==
      previous.installationDescriptorSha256 ||
    proof.missing.length
  )
    throw Error('The complete previous managed installation is required.');
  if (
    (await exists(reader, '.kobo/KoboRoot.tgz')) ||
    (await exists(reader, HOME + '/request.txt'))
  )
    throw Error('Another update or reader job is queued. Do not overwrite it.');
  const data = await asset(c.archive, fetcher),
    id = crypto.randomUUID().replaceAll('-', ''),
    base = '.adds/kobold-connect/' + c.id;
  if (await exists(reader, base + '/request.json'))
    throw Error('This managed update is already prepared.');
  progress('Saving the previous request and installation records…');
  // The ordinary matching incremental backup already contains the complete USB
  // evidence. Keep the off-device active transaction separately before rebinding.
  const old = await requestedReportId(reader, backup);
  await writeVerified(
    backup.root,
    'managed-upgrades/' + id + '/previous-request.json',
    JSON.stringify({
      nonce: old,
      fromDescriptor: previous.installationDescriptorSha256,
    }),
    { exclusive: true },
  );
  await beginTransition(
    reader,
    backup,
    release,
    id,
    previous.installationDescriptorSha256,
  );
  await writeVerified(
    reader,
    base + '/INCOMPLETE.txt',
    'Keep USB connected until preparation completes.\n',
    { exclusive: true },
  );
  await writeVerified(
    reader,
    base + '/request.json',
    JSON.stringify({ id, identitySha256: proof.identity }),
    { exclusive: true },
  );
  progress('Writing and checking the signed update…');
  await writeVerified(reader, base + '/verified.tgz', data, {
    exclusive: true,
  });
  try {
    await writeVerified(reader, '.kobo/KoboRoot.tgz', data, {
      exclusive: true,
    });
  } catch (error) {
    try {
      await (await reader.getDirectoryHandle('.kobo')).removeEntry('KoboRoot.tgz');
    } catch {
      throw Error(
        'Could not clear an incomplete update. Keep USB connected and use recovery.',
      );
    }
    throw error;
  }
  const d = await (
    await (
      await reader.getDirectoryHandle('.adds')
    ).getDirectoryHandle('kobold-connect')
  ).getDirectoryHandle(c.id);
  await d.removeEntry('INCOMPLETE.txt');
  return id;
}
