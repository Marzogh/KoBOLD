import { verifiedCollection } from './collection.js';
import { checkStagedPayload, savePayloadCheck } from './payload-check.js';
import { requireScanReady } from './scan-protection.js';
import { trialGate, verifyTrialBackup } from './trial.js';
import {
  verifyReleaseEnvelope,
  requireSignedRelease,
  beginInstallation,
  rememberRequest,
} from './provenance.js';
import { assertBackupChoice, requireSystemBackup, openBackup } from './backup-store.js';
import { hashBytes, hashFile } from './sha256.js';
import {
  fileHandle,
  readText,
  writeVerified,
  exists,
  verifyBackup,
  unchanged,
  copyVerified,
} from './storage.js';
import {
  identify,
  PROFILE,
  request,
  settings,
  redactStatus,
  updateEndpoint,
  safePath,
} from './core.js';
export const HOME = '.adds/kobold';
/** Load release metadata and accept install permissions only from its signature. */
export async function getRelease(fetcher = fetch) {
  const url = new URL('../releases/0.1.0/manifest.json', import.meta.url);
  const response = await fetcher(url);
  if (!response.ok)
    throw Error('Installation files are unavailable. Try loading the page again.');
  const m = await response.json();
  if (
    m.schema !== 1 ||
    m.version !== '0.1.0' ||
    m.profile?.id !== PROFILE.id ||
    !Array.isArray(m.files) ||
    !m.files.length
  )
    throw Error('Release metadata is incompatible');
  const seen = new Set();
  for (const f of m.files) {
    safePath(f.path);
    safePath(f.url);
    if (
      !/^[a-f0-9]{64}$/.test(f.sha256) ||
      !Number.isSafeInteger(f.size) ||
      f.size < 0 ||
      seen.has(f.path)
    )
      throw Error('Invalid release manifest');
    seen.add(f.path);
  }
  for (const n of ['bootstrap.tgz', 'recovery.tgz']) {
    const f = m.updates?.[n];
    if (!f || f.url !== n || !/^[a-f0-9]{64}$/.test(f.sha256))
      throw Error('Invalid update manifest');
  }
  // Candidates remain viewable but can never stage an unsigned root update.
  const signedResponse = await fetcher(
    new URL('../releases/0.1.0/manifest.signed.json', import.meta.url),
  );
  if (signedResponse.ok) {
    const envelope = await signedResponse.json();
    if (!envelope.unsigned) {
      const trustResponse = await fetcher(
        new URL('../trust/release-keys.json', import.meta.url),
      );
      if (!trustResponse.ok) throw Error('Release trust configuration unavailable');
      const authenticated = await verifyReleaseEnvelope(
        envelope,
        await trustResponse.json(),
      );
      if (JSON.stringify(authenticated) !== JSON.stringify(m))
        throw Error('Signed release differs from downloaded metadata');
      return authenticated;
    }
  }
  return m;
}
/** Check the exact device profile and required installation evidence. */
export function installationGate(
  reader,
  release,
  { trialAcknowledged = false, collectionResult = null } = {},
) {
  if (!reader.matched || release.profile.id !== reader.profile)
    throw Error('This hardware and firmware combination is unsupported');
  if (release.channel === 'connection-trial')
    throw Error(
      'Use the verified existing-installation continuation, not a fresh installation.',
    );
  if (release.channel === 'attended-trial')
    return trialGate(reader, release, trialAcknowledged, Date.now(), collectionResult);
  if (!release.profile.bootstrapAccepted || !release.profile.bootstrapEvidence)
    throw Error('Installation is not yet available in this version.');
  const preflight = verifiedCollection(collectionResult, release.preflight?.collection),
    age = Date.now() - Date.parse(preflight.observedAt);
  if (!Number.isFinite(age) || age < 0 || age >= 2 * 60 * 60 * 1000)
    throw Error('Repeat system collection before installing.');
  return preflight;
}
/** Download an asset only after validating its path, size and signed digest. */
export async function asset(entry, fetcher = fetch) {
  safePath(entry.url);
  const response = await fetcher(
    new URL('../releases/0.1.0/' + entry.url, import.meta.url),
  );
  if (!response.ok) throw Error('Release asset unavailable');
  const b = new Uint8Array(await response.arrayBuffer());
  if (b.length !== entry.size || hashBytes(b) !== entry.sha256)
    throw Error('Release download failed integrity verification');
  return b;
}
/** Verify backups and all inputs before writing payloads; queue the root update last. */
export async function stage(
  reader,
  backup,
  release,
  config,
  policyAcknowledged,
  {
    fetcher = fetch,
    progress = () => {},
    trialAcknowledged = false,
    collectionResult = null,
  } = {},
) {
  requireSignedRelease(release);
  const identity = identify(await readText(reader, '.kobo/version')),
    preflight = installationGate(identity, release, {
      trialAcknowledged,
      collectionResult,
    });
  settings(config);
  if (!policyAcknowledged)
    throw Error('Validate and save the restricted policy in Tailscale first');
  const backupReceipt = await assertBackupChoice(reader, backup, {
    current: true,
  });
  if (preflight) await verifyTrialBackup(reader, backup, preflight);
  if (await exists(reader, '.kobo/KoboRoot.tgz'))
    throw Error('A Kobo update is already queued; do not overwrite it');
  // Fresh installation only. Upgrade support must preserve and inspect existing state.
  try {
    await reader
      .getDirectoryHandle('.adds')
      .then((x) => x.getDirectoryHandle('kobold'));
    throw Error(
      'KoBOLD is already installed. Use the Recovery page if you need to disable it.',
    );
  } catch (e) {
    if (e.name !== 'NotFoundError') throw e;
  }
  // Fetch and hash all inputs before writing anything on the reader.
  const blobs = [];
  for (const entry of release.files) {
    blobs.push([entry, await asset(entry, fetcher)]);
    progress('Verified ' + entry.path);
  }
  const bootstrap = await asset(release.updates['bootstrap.tgz'], fetcher);
  const id = crypto.randomUUID().replaceAll('-', '');
  await requireScanReady(reader, backup);
  await beginInstallation(reader, backup, release, id, {
    freshRootVerified:
      preflight?.parentsAreRealDirectories === true &&
      JSON.stringify(preflight.absentRootPaths) ===
        JSON.stringify([
          '/usr/local/kobold-0.1.0',
          '/usr/local/kobold-state',
          '/etc/udev/rules.d/98-kobold-0.1.0.rules',
        ]),
  });
  await writeVerified(
    reader,
    HOME + '/INSTALL-INCOMPLETE.txt',
    'Preparation incomplete. No firmware update should be queued until verification finishes.\n',
    { exclusive: true },
  );
  for (const [entry, bytes] of blobs)
    await writeVerified(reader, HOME + '/releases/0.1.0/' + entry.path, bytes, {
      exclusive: true,
    });
  await writeVerified(reader, HOME + '/request.txt', request('inspect', config, id), {
    exclusive: true,
  });
  await writeVerified(
    reader,
    HOME + '/usb-backup-receipt.json',
    JSON.stringify(backupReceipt),
    { exclusive: true },
  );
  // Write and verify the inert archive first. KoboRoot is queued last.
  // Browser close/readback is not a filesystem fsync or power-loss guarantee;
  // the hardware gate includes interruption and safe-eject acceptance.
  await writeVerified(reader, HOME + '/bootstrap-verified.tgz', bootstrap, {
    exclusive: true,
  });
  progress('Checking all installer files before preparing eject');
  const checkpoint = await checkStagedPayload(reader, release, progress);
  await savePayloadCheck(backup, id, checkpoint);
  try {
    await writeVerified(reader, '.kobo/KoboRoot.tgz', bootstrap, {
      exclusive: true,
    });
  } catch (error) {
    // This path was absent at preflight. Remove only this job's failed queue
    // file; retain all payload/backup evidence. Keep USB connected on failure.
    try {
      const kobo = await reader.getDirectoryHandle('.kobo');
      await kobo.removeEntry('KoboRoot.tgz');
    } catch {
      throw Error(
        'Firmware queue cleanup failed. Keep USB connected; inspect .kobo/KoboRoot.tgz before ejecting.',
      );
    }
    throw error;
  }
  const home = await reader
    .getDirectoryHandle('.adds')
    .then((x) => x.getDirectoryHandle('kobold'));
  await home.removeEntry('INSTALL-INCOMPLETE.txt');
  return id;
}
/** Read one requested result. A successful earlier job cannot satisfy a new request. */
export async function latestReport(reader, expected = null) {
  const id = expected ?? (await readText(reader, HOME + '/last-result.txt')).trim();
  if (!/^[a-f0-9]{32}$/.test(id)) throw Error('Invalid device result identifier');
  const prefix = HOME + '/reports/' + id;
  if (expected && !(await exists(reader, prefix + '/result.txt')))
    throw Error(
      'The requested Kobo job has not finished. Keep its pending request. Safely eject, let the Kobo finish its work, then reconnect to recover the result. Do not prepare another job.',
    );
  const result = (await readText(reader, prefix + '/result.txt')).trim();
  if (result !== 'complete')
    throw Error(
      'The Kobo could not finish this step. Keep your backup and open the recovery guide.',
    );
  let status = null,
    signin = null;
  if (await exists(reader, prefix + '/status-private.json'))
    status = JSON.parse(await readText(reader, prefix + '/status-private.json'));
  if (await exists(reader, prefix + '/sign-in.txt')) {
    const value = (await readText(reader, prefix + '/sign-in.txt')).trim();
    if (value && !/^https:\/\/login\.tailscale\.com\/a\/[a-zA-Z0-9]+$/.test(value))
      throw Error('Unexpected sign-in destination');
    signin = value || null;
  }
  return {
    id,
    prefix,
    status,
    summary: status ? redactStatus(status) : null,
    signin,
  };
}
/** Copy the privileged archive off-device before acknowledging its checksum. */
export async function collectSystemBackup(
  reader,
  backup,
  report,
  onProgress = () => {},
) {
  await assertBackupChoice(reader, backup);
  const expected = (
    await readText(reader, report.prefix + '/system-backup.sha256')
  ).trim();
  if (!/^[a-f0-9]{64}$/.test(expected))
    throw Error('Invalid privileged backup checksum');
  const path = HOME + '/system-backup.tar.gz';
  const out = await backup.directory.getDirectoryHandle('privileged', {
    create: true,
  });
  const record = await copyVerified(reader, out, path, onProgress);
  if (record.sha256 !== expected)
    throw Error('Privileged backup checksum does not match device receipt');
  await writeVerified(
    out,
    'receipt.json',
    JSON.stringify({
      status: 'verified',
      sha256: expected,
      source: 'on-device root snapshot; copied over USB',
      scope: '/etc including startup rules; original USB snapshot is separate',
    }),
  );
  await writeVerified(reader, HOME + '/backup-ack.txt', expected + '\n');
  return expected;
}
/** Bind a fixed device action to a fresh saved challenge before queuing it. */
export async function queue(reader, action, config, backup = null) {
  if (await exists(reader, HOME + '/request.txt'))
    throw Error('A device job is already queued. Eject and let it complete first.');
  const id = crypto.randomUUID().replaceAll('-', '');
  const recovery = ['disable', 'uninstall'].includes(action);
  if (!recovery) await rememberRequest(reader, backup, id);
  else if (backup)
    try {
      await rememberRequest(reader, backup, id);
    } catch {
      /* Emergency recovery remains available without a usable pin; its result cannot be claimed authenticated. */
    }
  await writeVerified(reader, HOME + '/request.txt', request(action, config, id), {
    exclusive: true,
  });
  return id;
}
/** Require a running client, no health warnings and the configured device tag. */
export function healthy(status, config) {
  if (
    status?.BackendState !== 'Running' ||
    (status.Health ?? []).length ||
    !(status.Self?.Tags ?? []).includes(settings(config).tag)
  )
    throw Error(
      'Check the Tailscale connection, device tag and connection errors before continuing.',
    );
  return true;
}
/** Recognise the exact existing service address without changing reader settings. */
export async function endpointMatches(reader, config, status) {
  healthy(status, config);
  const s = settings(config);
  if (s.ports.length !== 1) return false;
  const text = await readText(reader, '.kobo/Kobo/Kobo eReader.conf');
  try {
    return updateEndpoint(text, s.ip, s.ports[0]) === text;
  } catch {
    return false;
  }
}
/** Save the original configuration before replacing only its service address. */
export async function configureEndpoint(reader, backup, config, status) {
  healthy(status, config);
  await assertBackupChoice(reader, backup);
  await requireSystemBackup(reader, backup);
  const s = settings(config);
  if (s.ports.length !== 1)
    throw Error('Choose exactly one sync port before updating the Kobo endpoint');
  const path = '.kobo/Kobo/Kobo eReader.conf',
    text = await readText(reader, path),
    updated = updateEndpoint(text, s.ip, s.ports[0]);
  const tokenBackup = 'before-endpoint-' + crypto.randomUUID() + '.conf';
  await writeVerified(backup.directory, tokenBackup, text, { exclusive: true });
  // Fail if anything changed between the private snapshot and commit.
  if ((await readText(reader, path)) !== text)
    throw Error('Configuration changed; reconnect and retry');
  await writeVerified(reader, path, updated);
  return true;
}
/** Require verified health and recovery evidence before requesting persistent startup. */
export async function enableStartup(reader, backup, config, status) {
  healthy(status, config);
  await assertBackupChoice(reader, backup);
  await requireSystemBackup(reader, backup);
  const expected = (await readText(reader, HOME + '/backup-ack.txt')).trim();
  if (!/^[a-f0-9]{64}$/.test(expected))
    throw Error('Save and check the system backup before continuing.');
  await writeVerified(reader, HOME + '/health-ack.txt', expected + '\n');
  return queue(reader, 'enable', config, backup);
}
export async function verifyInstalled(reader, release) {
  for (const f of release.files)
    if (
      (await hashFile(
        await (await fileHandle(reader, HOME + '/releases/0.1.0/' + f.path)).getFile(),
      )) !== f.sha256
    )
      throw Error('Installed file differs: ' + f.path);
  return true;
}

export async function resumeBackup(
  reader,
  chosen,
  { root = null, onProgress = () => {} } = {},
) {
  const { separateLocations } = await import('./storage.js');
  await separateLocations(reader, chosen);
  const backup = await openBackup(reader, chosen, { root, onProgress });
  if (await exists(reader, HOME + '/backup-ack.txt')) {
    try {
      backup.systemHash = await requireSystemBackup(reader, backup);
    } catch {
      /* System snapshot must be collected again before mutation. */
    }
  }
  return backup;
}
