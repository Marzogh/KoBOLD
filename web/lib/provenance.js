import { hostMetadata } from './host-metadata.js';
import { hashBytes, hashFile } from './sha256.js';
import {
  readText,
  writeVerified,
  fileHandle,
  exists,
  inventory,
  directory,
} from './storage.js';
export const INSTALLER = 'org.kobold.kobo-tailscale/v1';
const verified = new WeakMap(),
  encoder = new TextEncoder();
const HOME = '.adds/kobold',
  TRUST = 'trust.json',
  PENDING = 'pending.json';
async function records(reader, backup) {
  if (!backup?.root)
    throw Error('Select the parent backup folder to access installation records.');
  const id = await hashFile(
    await (await fileHandle(reader, '.kobo/version')).getFile(),
  );
  const parent = await backup.root.getDirectoryHandle('kobold-installations', {
    create: true,
  });
  return parent.getDirectoryHandle(id, { create: true });
}
function bytes(value) {
  if (typeof value !== 'string' || value.length > 8 * 1024 * 1024)
    throw Error('Invalid signature data');
  try {
    return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
  } catch {
    throw Error('Invalid signature encoding');
  }
}
/** Verify the signed bytes before decoding their JSON payload. */
export async function verifyEnvelope(envelope, keys) {
  const publicKey = keys?.[envelope?.keyId];
  if (!publicKey) throw Error('Release signing key is not trusted');
  const raw = bytes(publicKey);
  if (raw.length !== 32) throw Error('Invalid signing key');
  const key = await crypto.subtle.importKey('raw', raw, { name: 'Ed25519' }, false, [
    'verify',
  ]);
  const payload = bytes(envelope.payload);
  if (!(await crypto.subtle.verify('Ed25519', key, bytes(envelope.signature), payload)))
    throw Error('Signature verification failed');
  return {
    value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload)),
    digest: hashBytes(payload),
  };
}
/** Authenticate a release and retain its digest for later mutation checks. */
export async function verifyReleaseEnvelope(envelope, keys) {
  const { value, digest } = await verifyEnvelope(envelope, keys);
  if (
    value.schema !== 1 ||
    value.version !== '0.1.0' ||
    !/^[a-f0-9]{64}$/.test(value.installationDescriptorSha256)
  )
    throw Error('Signed release metadata is incompatible');
  verified.set(value, { digest, content: JSON.stringify(value) });
  return value;
}
export function requireSignedRelease(release) {
  const trust = verified.get(release);
  if (!trust || trust.content !== JSON.stringify(release))
    throw Error('Installation requires a trusted signed release.');
  return trust;
}
export function inheritedRelease(parent, value) {
  requireSignedRelease(parent);
  if (parent.continuation?.previous !== value)
    throw Error('Previous release is not authorized');
  verified.set(value, {
    digest: hashBytes(encoder.encode(JSON.stringify(value))),
    content: JSON.stringify(value),
  });
  return value;
}
/** Preserve previous continuity records before authorising a descriptor change. */
export async function beginTransition(reader, backup, release, nonce, fromDescriptor) {
  const { digest } = requireSignedRelease(release),
    store = await records(reader, backup),
    trust = JSON.parse(await readText(store, TRUST));
  if (
    trust.descriptor !== fromDescriptor ||
    !(
      trust.status === 'prepared' ||
      (release.continuation?.purpose === 'upgrade-managed-install' &&
        ['installed', 'healthy', 'disabled'].includes(trust.status))
    )
  )
    throw Error('The verified inspected installation is required.');
  const previous = JSON.parse(await readText(store, PENDING));
  if (release.continuation?.purpose === 'upgrade-managed-install')
    for (const path of [TRUST, PENDING, 'receipts/' + trust.sequence + '.json'])
      await writeVerified(
        backup.root,
        'managed-upgrades/' + nonce + '/' + path,
        await readText(store, path),
        { exclusive: true },
      );
  await writeVerified(
    store,
    PENDING,
    JSON.stringify({
      kind: 'transition',
      nonce,
      previousNonce: previous.nonce,
      fromDescriptor,
      descriptor: release.installationDescriptorSha256,
      identity: trust.identity,
      release: digest,
    }),
  );
}
/** Start a fresh trust record only when existing records can be safely preserved. */
export async function beginInstallation(
  reader,
  backup,
  release,
  nonce,
  { freshRootVerified = false } = {},
) {
  const { digest } = requireSignedRelease(release);
  const store = await records(reader, backup);
  if ((await exists(store, TRUST)) || (await exists(store, PENDING))) {
    if (!freshRootVerified)
      throw Error(
        'Previous installation records exist. A fresh system collection is required before reinstalling.',
      );
    const files = await inventory(store),
      known = new Set(
        files
          .filter(
            (f) =>
              ['trust.json', 'pending.json'].includes(f.path) ||
              /^receipts\/[0-9]+\.json$/.test(f.path),
          )
          .map((f) => f.path),
      );
    for (const f of files)
      if (!known.has(f.path) && !(f.size <= 1024 * 1024 && hostMetadata(f.path, known)))
        throw Error('Unknown installation record requires review before reinstalling.');
    // Retain and verify every old record before clearing its active slot.
    const archive = await directory(
      backup.root,
      'retired-installations/' + nonce,
      true,
    );
    for (const f of files) {
      const data = await (await fileHandle(store, f.path)).getFile();
      await writeVerified(archive, f.path, new Uint8Array(await data.arrayBuffer()), {
        exclusive: true,
      });
    }
    for (const f of files) {
      const parts = f.path.split('/'),
        name = parts.pop();
      const parent = parts.length ? await directory(store, parts.join('/')) : store;
      await parent.removeEntry(name);
    }
  }
  // Saved off-device before any root update is queued. No private key is copied.
  await writeVerified(
    store,
    PENDING,
    JSON.stringify({
      kind: 'fresh-install',
      nonce,
      release: digest,
      descriptor: release.installationDescriptorSha256,
      identity: await hashFile(
        await (await fileHandle(reader, '.kobo/version')).getFile(),
      ),
    }),
    { exclusive: true },
  );
}
/** Select the saved challenge only when it belongs to the connected reader. */
export async function requestedReportId(reader, backup) {
  const store = await records(reader, backup),
    pending = JSON.parse(await readText(store, PENDING));
  if (
    !/^[a-f0-9]{32}$/.test(pending.nonce) ||
    pending.identity !==
      (await hashFile(await (await fileHandle(reader, '.kobo/version')).getFile()))
  )
    throw Error('Saved request does not match this Kobo.');
  return pending.nonce;
}
/** Record the next challenge against the already-pinned device identity. */
export async function rememberRequest(reader, backup, nonce) {
  if (!backup)
    throw Error(
      'Select the installation backup folder before requesting device status.',
    );
  const store = await records(reader, backup);
  const trust = JSON.parse(await readText(store, TRUST));
  await writeVerified(
    store,
    PENDING,
    JSON.stringify({
      kind: 'existing-install',
      nonce,
      identity: trust.identity,
      descriptor: trust.descriptor,
      release: trust.release,
    }),
  );
}
/** Check challenge, identity, history and actual files before advancing the trust pin. */
export async function verifyInstallationReport(reader, backup, release, report) {
  requireSignedRelease(release);
  if (!backup)
    throw Error('Select the installation backup folder to verify this Kobo.');
  const store = await records(reader, backup);
  const pending = JSON.parse(await readText(store, PENDING));
  if (pending.nonce !== report.id) {
    const details = [
      'Expected request: ' + pending.nonce,
      'Latest result: ' + report.id,
    ];
    try {
      if (await exists(reader, HOME + '/request.txt')) {
        const text = await readText(reader, HOME + '/request.txt');
        details.push(
          'Queued request: ' +
            (text.match(/^id=([a-f0-9]{32})$/m)?.[1] ?? 'unrecognised'),
        );
        details.push(
          'Queued action: ' +
            (text.match(
              /^action=(enrol|status|enable|disable|uninstall|inspect)$/m,
            )?.[1] ?? 'unrecognised'),
        );
      } else details.push('Queued request: absent');
      const path = HOME + '/reports/' + pending.nonce + '/result.txt';
      const result = (await exists(reader, path))
        ? (await readText(reader, path)).trim()
        : 'absent';
      details.push(
        'Requested result: ' +
          (['complete', 'failed', 'absent'].includes(result) ? result : 'unrecognised'),
      );
      const prefix = HOME + '/reports/' + pending.nonce;
      const knownMessages = new Set([
        'Already running',
        'Daemon answers; enrollment/connection still require inspection',
        'Daemon did not become ready; use stop and inspect compatibility',
        'Stale supervisor record; reboot or inspect before restarting',
        'Another tailscaled process exists; inspect before starting',
        'Insufficient RAM for the client',
        'Runtime changed; restart the Kobo before retrying',
      ]);
      for (const name of [
        'request.txt',
        'probes-private.txt',
        'runtime-private.txt',
        'status-private.json',
        'installation.json',
        'result.txt',
      ]) {
        if (!(await exists(reader, prefix + '/' + name))) {
          details.push(name + ': absent');
          continue;
        }
        const file = await (await fileHandle(reader, prefix + '/' + name)).getFile();
        details.push(name + ': ' + file.size + ' bytes');
        if (name === 'runtime-private.txt' && file.size <= 65536) {
          for (const line of (await file.text()).split(/\r?\n/))
            if (knownMessages.has(line)) details.push('Runtime: ' + line);
        }
      }
    } catch {
      details.push('Request details could not be read.');
    }
    throw Error(
      'This Kobo report does not match the requested check.\n' + details.join('\n'),
    );
  }
  const env = JSON.parse(await readText(reader, report.prefix + '/installation.json'));
  const pinned = (await exists(store, TRUST))
    ? JSON.parse(await readText(store, TRUST))
    : null;
  if (!pinned && pending.kind !== 'fresh-install')
    throw Error('Installation trust record is missing; explicit recovery is required.');
  const pub = pinned?.publicKey ?? env.keyId;
  const { value: r, digest } = await verifyEnvelope(env, { [pub]: pub });
  const identity = await hashFile(
    await (await fileHandle(reader, '.kobo/version')).getFile(),
  );
  if (
    r.installer !== INSTALLER ||
    r.publicKey !== pub ||
    r.nonce !== report.id ||
    r.identity !== identity ||
    r.identity !== pending.identity ||
    r.release !== pending.descriptor ||
    r.release !== release.installationDescriptorSha256 ||
    r.profile !== release.profile.id ||
    r.version !== release.version ||
    !Number.isSafeInteger(r.sequence) ||
    r.sequence < 1 ||
    !/^[a-f0-9]{32}$/.test(r.installationId) ||
    !['prepared', 'installed', 'healthy', 'disabled', 'removed'].includes(r.status)
  )
    throw Error('Installation receipt does not match this reader and release.');
  let predecessor = pinned;
  if (
    pinned &&
    pinned.descriptor !== r.release &&
    pending.kind === 'transition' &&
    release.continuation?.purpose === 'upgrade-managed-install'
  ) {
    const priorEnv = JSON.parse(
      await readText(reader, report.prefix + '/prior-installation.json'),
    );
    const { value: prior, digest: priorDigest } = await verifyEnvelope(priorEnv, {
      [pub]: pub,
    });
    if (
      prior.publicKey !== pub ||
      prior.installationId !== pinned.installationId ||
      prior.identity !== identity ||
      prior.release !== pending.fromDescriptor ||
      prior.profile !== r.profile ||
      prior.version !== r.version ||
      prior.installer !== INSTALLER
    )
      throw Error('Prior installation receipt differs from this managed installation.');
    const anchored =
      prior.sequence === pinned.sequence && priorDigest === pinned.digest;
    const interrupted =
      prior.sequence === pinned.sequence + 1 &&
      prior.previous === pinned.digest &&
      prior.nonce === pending.previousNonce;
    if (!anchored && !interrupted)
      throw Error('Prior installation receipt has an unverified history gap.');
    predecessor = { ...pinned, sequence: prior.sequence, digest: priorDigest };
    if (r.sequence !== prior.sequence + 1 || r.previous !== priorDigest)
      throw Error('Upgrade receipt does not continue the prior installation.');
    await writeVerified(
      store,
      'receipts/' + prior.sequence + '.json',
      JSON.stringify(priorEnv),
    );
  }
  if (pinned) {
    if (
      pinned.descriptor !== r.release &&
      (pending.kind !== 'transition' ||
        pending.fromDescriptor !== pinned.descriptor ||
        r.previousRelease !== pinned.descriptor ||
        r.sequence !== predecessor.sequence + 1 ||
        r.previous !== predecessor.digest)
    )
      throw Error(
        'Installation transition is not authorized by the previous trust record.',
      );
    if (
      pinned.installationId !== r.installationId ||
      r.sequence < pinned.sequence ||
      (r.sequence === pinned.sequence && digest !== pinned.digest)
    )
      throw Error('Installation receipt was replaced or rolled back.');
    if (r.sequence === predecessor.sequence + 1 && r.previous !== predecessor.digest)
      throw Error('Installation receipt history does not match.');
  } else if (r.status !== 'prepared' || r.sequence !== 1)
    throw Error('Initial installation receipt is incomplete.');
  for (const f of release.files) {
    const path = '/mnt/onboard/' + HOME + '/releases/0.1.0/' + f.path;
    if (
      r.files?.[path] !== f.sha256 ||
      (await hashFile(
        await (await fileHandle(reader, HOME + '/releases/0.1.0/' + f.path)).getFile(),
      )) !== f.sha256
    )
      throw Error('Installed file does not match the signed release: ' + f.path);
  }
  for (const name of ['status-private.json', 'sign-in.txt', 'system-backup.sha256']) {
    const present = await exists(reader, report.prefix + '/' + name),
      expected = r.reportFiles?.[name];
    if (
      present !== !!expected ||
      (present &&
        (await hashFile(
          await (await fileHandle(reader, report.prefix + '/' + name)).getFile(),
        )) !== expected)
    )
      throw Error('Device report was changed: ' + name);
  }
  const trust = {
    installer: INSTALLER,
    publicKey: pub,
    installationId: r.installationId,
    identity: r.identity,
    descriptor: r.release,
    release: pending.release,
    sequence: r.sequence,
    digest,
    status: r.status,
  };
  await writeVerified(store, TRUST, JSON.stringify(trust));
  await writeVerified(store, 'receipts/' + r.sequence + '.json', JSON.stringify(env));
  return trust;
}
// This establishes managed provenance only. An updater must issue a fresh device
// challenge, verify root hashes and compatibility, then stage and accept health.
export function updateEligibility(trust) {
  if (trust?.installer !== INSTALLER || trust.status !== 'healthy')
    throw Error('A verified healthy managed installation is required');
  return true;
}
// A retry rebinds only the exact failed, still-inspected transaction to a newly signed target.
export async function verifyMetadataRetry(reader, backup, release, request) {
  requireSignedRelease(release);
  const retry = release.continuation?.retry;
  if (
    !retry ||
    retry.reason !== 'host-metadata' ||
    !/^[a-f0-9]{64}$/.test(retry.descriptor)
  )
    throw Error('No signed metadata retry is available.');
  const store = await records(reader, backup),
    pin = JSON.parse(await readText(store, TRUST)),
    pending = JSON.parse(await readText(store, PENDING));
  const identity = await hashFile(
    await (await fileHandle(reader, '.kobo/version')).getFile(),
  );
  if (
    pin.status !== 'prepared' ||
    pin.descriptor !== release.continuation.previous.installationDescriptorSha256 ||
    pin.identity !== identity ||
    pending.kind !== 'transition' ||
    pending.nonce !== request.id ||
    !(
      pending.descriptor === retry.descriptor ||
      (pending.descriptor === release.installationDescriptorSha256 &&
        pending.release === requireSignedRelease(release).digest)
    ) ||
    pending.fromDescriptor !== pin.descriptor ||
    request.identitySha256 !== identity
  )
    throw Error('Failed transaction does not match the saved inspected installation.');
  const proof = await managedInstallation(reader, backup, release);
  if (proof.missing.length)
    throw Error(
      'Repair missing installer files before continuing: ' + proof.missing.join(', '),
    );
  return { id: request.id, identity };
}
const managedProofs = new WeakMap();
export function requireManagedProof(proof, reader) {
  if (managedProofs.get(proof) !== reader)
    throw Error(
      'Verify the saved managed installation before changing its folder exclusions.',
    );
  return proof;
}
// Off-device pinned native receipt authorises only restoration of its own immutable files.
// It is not a fresh native health/challenge attestation.
/** Verify saved provenance and present payload files without adopting an unknown device. */
export async function managedInstallation(reader, backup, release) {
  requireSignedRelease(release);
  const store = await records(reader, backup),
    pin = JSON.parse(await readText(store, TRUST));
  const candidates = [release];
  if (release.continuation?.previous)
    candidates.push(inheritedRelease(release, release.continuation.previous));
  const installed = candidates.find(
    (m) => m.installationDescriptorSha256 === pin.descriptor,
  );
  if (!installed) throw Error('The installed signed release is unavailable.');
  const identity = await hashFile(
    await (await fileHandle(reader, '.kobo/version')).getFile(),
  );
  if (
    identity !== pin.identity ||
    !Number.isSafeInteger(pin.sequence) ||
    pin.sequence < 1
  )
    throw Error('Saved installation does not match this reader.');
  const { value: r, digest } = await verifyEnvelope(
    JSON.parse(await readText(store, 'receipts/' + pin.sequence + '.json')),
    { [pin.publicKey]: pin.publicKey },
  );
  if (
    digest !== pin.digest ||
    r.identity !== identity ||
    r.release !== pin.descriptor ||
    r.installationId !== pin.installationId ||
    r.sequence !== pin.sequence ||
    r.status === 'removed'
  )
    throw Error('Saved installation receipt is invalid.');
  const missing = [];
  for (const f of installed.files) {
    const base = HOME;
    const path = base + '/releases/0.1.0/' + f.path;
    if (r.files?.['/mnt/onboard/' + path] !== f.sha256)
      throw Error('Receipt file inventory differs from its signed release.');
    if (!(await exists(reader, path))) {
      missing.push(f.path);
      continue;
    }
    if ((await hashFile(await (await fileHandle(reader, path)).getFile())) !== f.sha256)
      throw Error('Installed file changed: ' + f.path);
  }
  const proof = {
    release: installed,
    identity,
    missing,
    trust: Object.freeze({ ...pin }),
  };
  managedProofs.set(proof, reader);
  return proof;
}
