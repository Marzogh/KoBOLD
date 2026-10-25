export const PROFILE = Object.freeze({
  id: 'libra-colour-390-4.46.23836',
  model: 'Kobo Libra Colour',
  deviceCode: '390',
  serialPrefix: 'N428',
  firmware: '4.46.23836',
  kernel: '4.9.77',
  arch: 'armv7l',
  clientTested: true,
  bootstrapAccepted: false,
});
export function identify(version) {
  if (typeof version !== 'string' || version.length > 2048)
    throw Error('Invalid Kobo version file');
  const parts = version.trim().split(',');
  if (parts.length < 6 || !/^\d+\.\d+\.\d+$/.test(parts[2]))
    throw Error('Cannot identify this reader from its version file');
  const code = parts[5].match(/(?:^|0)(\d{3})$/)?.[1];
  const matched =
    code === PROFILE.deviceCode &&
    parts[0].startsWith(PROFILE.serialPrefix) &&
    parts[2] === PROFILE.firmware;
  return {
    model: code === '390' ? PROFILE.model : 'Unrecognised Kobo',
    deviceCode: code ?? 'unknown',
    firmware: parts[2],
    matched,
    profile: matched ? PROFILE.id : null,
  };
}
export function ipv4(value, tailnet = false) {
  const a = String(value).trim().split('.');
  if (
    a.length !== 4 ||
    a.some((s) => !/^\d{1,3}$/.test(s) || Number(s) > 255 || String(Number(s)) !== s)
  )
    throw Error('Enter a valid IPv4 address');
  if (tailnet && !(a[0] === '100' && Number(a[1]) >= 64 && Number(a[1]) <= 127))
    throw Error('Use the server’s Tailscale IPv4 address (100.64.0.0/10)');
  return a.join('.');
}
export function ports(value) {
  const raw = String(value)
    .split(',')
    .map((x) => x.trim());
  if (
    !raw.length ||
    raw.length > 16 ||
    raw.some((x) => !/^\d{1,5}$/.test(x) || +x < 1 || +x > 65535)
  )
    throw Error('Enter up to 16 TCP ports, separated by commas');
  return [...new Set(raw.map(Number))].sort((a, b) => a - b);
}
export function settings(input) {
  const ip = ipv4(input.ip, true),
    allowed = ports(input.ports);
  const tag = String(input.tag || 'tag:kobo-sync').trim();
  if (!/^tag:[a-z][a-z0-9-]{0,62}$/.test(tag))
    throw Error('Use a tag such as tag:kobo-sync');
  const hostname = String(input.hostname || 'kobo-reader').trim();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(hostname))
    throw Error('Use a hostname of 1–63 lowercase letters, numbers or hyphens');
  const owner = String(input.owner || 'autogroup:admin').trim();
  if (!/^(?:autogroup:admin|group:[a-zA-Z0-9_-]+|[^\s@:,]+@[^\s@:,]+)$/.test(owner))
    throw Error('Tag owner must be autogroup:admin, a group or one account email');
  return { ip, ports: allowed, tag, hostname, owner };
}
// HuJSON comments/trailing commas, without eval or altering string contents.
export function parsePolicy(text) {
  if (text.length > 1000000) throw Error('Policy is too large');
  let out = '',
    i = 0,
    string = false;
  for (; i < text.length; i++) {
    const c = text[i],
      n = text[i + 1];
    if (string) {
      out += c;
      if (c === '\\') {
        out += text[++i] ?? '';
      } else if (c === '"') string = false;
      continue;
    }
    if (c === '"') {
      string = true;
      out += c;
      continue;
    }
    if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      if (i >= text.length) throw Error('Unterminated policy comment');
      i++;
      out += ' ';
      continue;
    }
    out += c;
  }
  let clean = '';
  string = false;
  for (i = 0; i < out.length; i++) {
    const c = out[i];
    if (string) {
      clean += c;
      if (c === '\\') clean += out[++i] ?? '';
      else if (c === '"') string = false;
      continue;
    }
    if (c === '"') string = true;
    if (c === ',' && /^\s*[}\]]/.test(out.slice(i + 1))) continue;
    clean += c;
  }
  const policy = JSON.parse(clean || '{}');
  if (!policy || Array.isArray(policy) || typeof policy !== 'object')
    throw Error('Policy must be a JSON object');
  for (const key of ['grants', 'acls', 'tests'])
    if (policy[key] !== undefined && !Array.isArray(policy[key]))
      throw Error(key + ' must be an array');
  return policy;
}
export function policyProposal(
  original,
  config,
  replaceWildcard = false,
  extraDenied = '',
) {
  const s = settings(config),
    policy = parsePolicy(original);
  const broad = [],
    rewritten = [];
  for (const kind of ['grants', 'acls'])
    for (const [i, rule] of (policy[kind] ?? []).entries()) {
      if (!rule || typeof rule !== 'object' || !Array.isArray(rule.src))
        throw Error('Unrecognised ' + kind + ' rule; review manually');
      // Numeric sources, ranges, ipsets and unfamiliar autogroups may include
      // a future reader IP. Require manual review rather than guessing.
      const dangerous = rule.src.filter(
        (x) =>
          typeof x !== 'string' ||
          x === '*' ||
          x === s.tag ||
          !(
            x.startsWith('group:') ||
            x.includes('@') ||
            (x.startsWith('tag:') && x !== s.tag) ||
            x === 'autogroup:member' ||
            x === 'autogroup:admin'
          ),
      );
      const within =
        kind === 'grants' &&
        Array.isArray(rule.dst) &&
        rule.dst.length > 0 &&
        rule.dst.every((x) => x === s.ip) &&
        Array.isArray(rule.ip) &&
        rule.ip.length > 0 &&
        rule.ip.every((x) => s.ports.some((p) => x === 'tcp:' + p));
      if (within && (!rule.app || Object.keys(rule.app).length === 0)) continue;
      if (dangerous.length) {
        if (replaceWildcard && dangerous.every((x) => x === '*')) {
          rule.src = [
            ...new Set(rule.src.map((x) => (x === '*' ? 'autogroup:member' : x))),
          ];
          rewritten.push(kind + '[' + i + ']');
        } else
          broad.push(kind + '[' + i + '] may already grant access to the Kobo tag');
      }
    }
  const deny = [22, 443, 8443]
    .filter((p) => !s.ports.includes(p))
    .map((p) => s.ip + ':' + p);
  for (const item of extraDenied
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)) {
    const m = item.match(/^([0-9.]+):(\d+)$/);
    if (!m) throw Error('Additional tests must be IPv4:port, separated by commas');
    const address = ipv4(m[1]);
    const [port] = ports(m[2]);
    if (address === s.ip && s.ports.includes(port))
      throw Error('A deny test conflicts with an allowed port');
    deny.push(address + ':' + port);
  }
  if (
    policy.tagOwners !== undefined &&
    (!policy.tagOwners ||
      Array.isArray(policy.tagOwners) ||
      typeof policy.tagOwners !== 'object')
  )
    throw Error('Unrecognised tagOwners');
  const tagOwners = policy.tagOwners ?? {};
  if (
    Object.hasOwn(tagOwners, s.tag) &&
    JSON.stringify(tagOwners[s.tag]) !== JSON.stringify([s.owner])
  )
    throw Error(
      'This tag already has different owners; choose a new tag or review the policy manually',
    );
  policy.tagOwners = { ...tagOwners, [s.tag]: [s.owner] };
  const grant = {
    src: [s.tag],
    dst: [s.ip],
    ip: s.ports.map((p) => 'tcp:' + p),
  };
  const sameSet = (a, b) =>
    Array.isArray(a) &&
    Array.isArray(b) &&
    a.every((x) => typeof x === 'string') &&
    b.every((x) => typeof x === 'string') &&
    new Set(a).size === new Set(b).size &&
    a.every((x) => b.includes(x));
  // Reuse only an unqualified equivalent grant. Posture/via/app constraints
  // must not be silently removed or mistaken for unconditional access.
  const equivalent = (rule) =>
    rule &&
    Object.keys(rule).every((k) => ['src', 'dst', 'ip'].includes(k)) &&
    ['src', 'dst', 'ip'].every((k) => sameSet(rule[k], grant[k]));
  let found = false;
  policy.grants = (policy.grants ?? []).filter((rule) => {
    if (!equivalent(rule)) return true;
    if (found) return false;
    found = true;
    return true;
  });
  if (!found) policy.grants.push(grant);
  const proposedTests = [
    {
      src: s.tag,
      proto: 'tcp',
      accept: s.ports.map((p) => s.ip + ':' + p),
      ...(deny.length ? { deny: [...new Set(deny)] } : {}),
    },
    { src: s.tag, proto: 'udp', deny: s.ports.map((p) => s.ip + ':' + p) },
  ];
  // Keep custom test conditions and other sources untouched. For plain Kobo
  // tests, a superset preserves all assertions of a redundant smaller test.
  const plain = (t) =>
    t &&
    t.src === s.tag &&
    ['tcp', 'udp'].includes(t.proto) &&
    Object.keys(t).every((k) => ['src', 'proto', 'accept', 'deny'].includes(k)) &&
    ['accept', 'deny'].every(
      (k) =>
        t[k] === undefined ||
        (Array.isArray(t[k]) && t[k].every((x) => typeof x === 'string')),
    );
  const covers = (a, b) =>
    plain(a) &&
    plain(b) &&
    a.proto === b.proto &&
    ['accept', 'deny'].every((k) =>
      (b[k] ?? []).every((x) => (a[k] ?? []).includes(x)),
    );
  const tests = [...(policy.tests ?? []), ...proposedTests];
  policy.tests = tests.filter(
    (t, i) =>
      !plain(t) ||
      !tests.some(
        (other, j) => j !== i && covers(other, t) && (!covers(t, other) || j < i),
      ),
  );
  return {
    text: JSON.stringify(policy, null, 2) + '\n',
    conflicts: broad,
    rewritten,
    config: s,
  };
}
export function updateEndpoint(text, ip, port) {
  ipv4(ip, true);
  ports(String(port));
  let section = '',
    count = 0;
  const result = text.replace(/[^\r\n]*(?:\r\n|\n|$)/g, (line) => {
    const heading = line.trim().match(/^\[([^\]]+)\]$/);
    if (heading) section = heading[1];
    if (section !== 'OneStoreServices' || !line.startsWith('api_endpoint='))
      return line;
    count++;
    const m = line.match(
      /^api_endpoint=https?:\/\/[^/\r\n]+(\/kobo\/[a-fA-F0-9]{32})(\/?)((?:\r?\n)?)$/,
    );
    if (!m)
      throw Error(
        'Existing Calibre-Web token endpoint is not recognised; nothing changed',
      );
    return 'api_endpoint=http://' + ip + ':' + port + m[1] + m[2] + m[3];
  });
  if (count !== 1)
    throw Error('Expected one existing Calibre-Web endpoint in OneStoreServices');
  return result;
}
export function safePath(path) {
  if (
    typeof path !== 'string' ||
    !path ||
    path.startsWith('/') ||
    path.includes('\\') ||
    /[\x00-\x1f]/.test(path) ||
    path.split('/').some((x) => !x || x === '.' || x === '..')
  )
    throw Error('Unsafe relative path');
  return path;
}
export function request(action, config, id) {
  if (
    !['inspect', 'enrol', 'status', 'enable', 'disable', 'uninstall'].includes(action)
  )
    throw Error('Unknown action');
  const s = settings(config);
  if (!/^[a-f0-9]{32}$/.test(id)) throw Error('Invalid request identifier');
  return `id=${id}\naction=${action}\nprofile=${PROFILE.id}\nhostname=${s.hostname}\ntag=${s.tag}\n`;
}
export function redactStatus(status) {
  return {
    state: status.BackendState ?? 'unknown',
    tags: status.Self?.Tags ?? [],
    health: status.Health ?? [],
    address: status.Self?.TailscaleIPs?.find((x) => !x.includes(':')) ?? null,
  };
}
