import { fileHandle, directory } from './storage.js';
import { hashFile, hashBytes } from './sha256.js';
import { verifyEnvelope } from './provenance.js';
const HOME = '.adds/kobold',
  id = (v) => (typeof v === 'string' && /^[a-f0-9]{32}$/.test(v) ? v : null);
const actions = new Set([
  'inspect',
  'enrol',
  'status',
  'enable',
  'disable',
  'uninstall',
]);
const messages = new Set([
  'Already running',
  'Daemon answers; enrollment/connection still require inspection',
  'Daemon did not become ready; use stop and inspect compatibility',
  'Stale supervisor record; reboot or inspect before restarting',
  'Another tailscaled process exists; inspect before starting',
  'Insufficient RAM for the client',
  'Runtime changed; restart the Kobo before retrying',
  'Unsupported kernel',
]);
async function inspect(root, path, parse) {
  try {
    const f = await (await fileHandle(root, path)).getFile();
    const out = { present: true, bytes: f.size };
    if (f.size > 2 * 1024 * 1024) return { ...out, omitted: 'size limit' };
    const text = await f.text();
    out.sha256 = hashBytes(new TextEncoder().encode(text));
    if (parse)
      try {
        Object.assign(out, await parse(text));
      } catch {
        out.parse = 'invalid';
      }
    return out;
  } catch (e) {
    return e.name === 'NotFoundError'
      ? { present: false }
      : {
          error: ['NotAllowedError', 'NotReadableError', 'TypeMismatchError'].includes(
            e.name,
          )
            ? e.name
            : 'read failed',
        };
  }
}
function request(text) {
  return {
    id: id(text.match(/^id=(.+)$/m)?.[1]),
    action: actions.has(text.match(/^action=(.+)$/m)?.[1])
      ? text.match(/^action=(.+)$/m)[1]
      : 'unrecognised',
  };
}
function log(text) {
  const lines = text.split(/\r?\n/);
  return {
    lines: lines.length,
    messages: [...new Set(lines.filter((x) => messages.has(x)))],
    signals: {
      notFound: lines.some((x) => /not found|No such file or directory/.test(x)),
      permissionDenied: lines.some((x) => /Permission denied/.test(x)),
      hashFailure: lines.some((x) => /FAILED|checksum.*(mismatch|fail)/i.test(x)),
      timeout: lines.some((x) => /timed? out|timeout/i.test(x)),
    },
  };
}
/** Capture bounded setup evidence without scanning backups or exporting private content. */
export async function collectDiagnostics(reader, backup, onProgress = () => {}) {
  const version = await (await fileHandle(reader, '.kobo/version')).getFile(),
    identity = await hashFile(version);
  const out = {
    format: 1,
    collected: new Date().toISOString(),
    readOnly: true,
    backupContentsScanned: false,
    identitySha256: identity,
  };
  let pin = null,
    pending = null;
  const store = 'kobold-installations/' + identity;
  onProgress('Reading saved request and verification records…');
  out.pending = await inspect(backup, store + '/pending.json', (text) => {
    const x = JSON.parse(text);
    pending = x;
    return {
      id: id(x.nonce),
      kind: ['fresh-install', 'existing-install', 'transition'].includes(x.kind)
        ? x.kind
        : 'unrecognised',
      identityMatches: x.identity === identity,
    };
  });
  out.trust = await inspect(backup, store + '/trust.json', (text) => {
    const x = JSON.parse(text);
    pin = x;
    return {
      sequence: Number.isSafeInteger(x.sequence) ? x.sequence : null,
      status: ['prepared', 'installed', 'healthy', 'disabled', 'removed'].includes(
        x.status,
      )
        ? x.status
        : 'unrecognised',
      identityMatches: x.identity === identity,
    };
  });
  out.queued = await inspect(reader, HOME + '/request.txt', request);
  out.latest = await inspect(reader, HOME + '/last-result.txt', (text) => ({
    id: id(text.trim()),
  }));
  out.markers = {};
  for (const name of ['INSTALL-INCOMPLETE.txt', 'backup-ack.txt', 'health-ack.txt'])
    out.markers[name] = await inspect(reader, HOME + '/' + name);
  out.firmwareQueue = await inspect(reader, '.kobo/KoboRoot.tgz');
  const ids = new Set(
    [id(pending?.nonce), out.queued.id, out.latest.id].filter(Boolean),
  );
  let count = 0;
  try {
    const dir = await directory(reader, HOME + '/reports');
    for await (const [name, h] of dir.entries()) {
      if (h.kind === 'directory' && id(name)) {
        count++;
        if (ids.size < 32) ids.add(name);
      }
    }
  } catch (e) {
    out.reportDirectory = e.name === 'NotFoundError' ? 'absent' : 'unreadable';
  }
  out.reportCount = count;
  out.reportLimit = 32;
  out.reports = {};
  for (const nonce of ids) {
    onProgress(
      'Reading report ' +
        (Object.keys(out.reports).length + 1) +
        ' of ' +
        ids.size +
        '…',
    );
    const prefix = HOME + '/reports/' + nonce,
      r = {};
    r.request = await inspect(reader, prefix + '/request.txt', request);
    r.result = await inspect(reader, prefix + '/result.txt', (text) => ({
      value: ['complete', 'failed'].includes(text.trim())
        ? text.trim()
        : 'unrecognised',
    }));
    for (const name of [
      'probes-private.txt',
      'runtime-private.txt',
      'login-private.txt',
      'provenance-error.txt',
    ])
      r[name] = await inspect(reader, prefix + '/' + name, log);
    r.readiness = await inspect(reader, prefix + '/readiness.json', (text) => {
      const x = JSON.parse(text);
      return {
        attempts: Number.isSafeInteger(x.attempts) ? x.attempts : null,
        state: [
          'NoState',
          'Starting',
          'Running',
          'NeedsLogin',
          'NeedsMachineAuth',
          'Stopped',
          'unrecognised',
          '',
        ].includes(x.state)
          ? x.state
          : 'unrecognised',
        healthCount: Number.isSafeInteger(x.healthCount) ? x.healthCount : null,
        tagMatches: x.tagMatches === true,
        outcome: [
          'waiting',
          'ready',
          'timeout',
          'client-error',
          'malformed-status',
          'unhealthy',
          'login-or-action-required',
          'unexpected-state',
        ].includes(x.outcome)
          ? x.outcome
          : 'unrecognised',
      };
    });
    r.status = await inspect(reader, prefix + '/status-private.json', (text) => {
      const x = JSON.parse(text);
      return {
        state: [
          'NoState',
          'NeedsLogin',
          'NeedsMachineAuth',
          'Stopped',
          'Starting',
          'Running',
        ].includes(x.BackendState)
          ? x.BackendState
          : 'unrecognised',
        healthCount: Array.isArray(x.Health) ? x.Health.length : null,
        tagCount: Array.isArray(x.Self?.Tags) ? x.Self.Tags.length : null,
      };
    });
    r.receipt = await inspect(reader, prefix + '/installation.json', async (text) => {
      if (!pin?.publicKey) return { verified: false, reason: 'no saved public key' };
      try {
        const { value: x } = await verifyEnvelope(JSON.parse(text), {
          [pin.publicKey]: pin.publicKey,
        });
        return {
          verified: true,
          requestMatches: x.nonce === nonce,
          identityMatches: x.identity === identity,
          sequence: Number.isSafeInteger(x.sequence) ? x.sequence : null,
          status: ['prepared', 'installed', 'healthy', 'disabled', 'removed'].includes(
            x.status,
          )
            ? x.status
            : 'unrecognised',
        };
      } catch {
        return { verified: false, reason: 'signature or format rejected' };
      }
    });
    out.reports[nonce] = r;
  }
  onProgress('Diagnostic capture completed.');
  return out;
}
