import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { SHA256, hashBytes } from '../web/lib/sha256.js';
import {
  identify,
  settings,
  parsePolicy,
  policyProposal,
  updateEndpoint,
  safePath,
  request,
} from '../web/lib/core.js';
const c = {
  ip: '100.101.102.103',
  ports: '8083',
  tag: 'tag:kobo-sync',
  hostname: 'kobo-reader',
  owner: 'autogroup:admin',
};
test('streaming SHA256 matches independent Node implementation at block boundaries', () => {
  for (const n of [0, 1, 55, 56, 63, 64, 65, 1000, 1000000]) {
    const b = randomBytes(n),
      h = new SHA256();
    for (let i = 0; i < n; i += 37) h.update(b.subarray(i, i + 37));
    assert.equal(h.digest(), createHash('sha256').update(b).digest('hex'));
  }
  assert.equal(
    hashBytes(new TextEncoder().encode('abc')),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
});
test('only exact model, serial prefix and firmware match', () => {
  const v = 'N428-test,4.9.77,4.46.23836,x,y,00000000-0000-0000-0000-000000000390';
  assert.equal(identify(v).matched, true);
  for (const bad of [
    v.replace('N428', 'P428'),
    v.replace('390', '393'),
    v.replace('23836', '99999'),
  ])
    assert.equal(identify(bad).matched, false);
  assert.throws(() => identify('garbage'));
});
test('HuJSON preserves comments inside strings and strips real comments and trailing commas', () => {
  assert.deepEqual(
    parsePolicy('/* hi */ {"url":"https://x/y,}", "grants": [], // note\n}'),
    { url: 'https://x/y,}', grants: [] },
  );
  assert.throws(() => parsePolicy('/*'));
  assert.throws(() => parsePolicy('[]'));
});
test('policy preserves unrelated SSH/Funnel and flags additive wildcard access', () => {
  const p = {
    grants: [{ src: ['*'], dst: ['*'], ip: ['*'] }],
    ssh: [{ action: 'check' }],
    nodeAttrs: [{ attr: ['funnel'] }],
    hosts: { library: '100.100.100.100' },
    tests: [{ src: 'tag:old', deny: ['100.1.1.1:22'] }],
  };
  const result = policyProposal(JSON.stringify(p), c);
  assert.equal(result.conflicts.length, 1);
  const out = JSON.parse(result.text);
  for (const key of ['ssh', 'nodeAttrs', 'hosts']) assert.deepEqual(out[key], p[key]);
  assert.equal(out.tests.length, 3);
  assert.deepEqual(out.grants.at(-1), {
    src: ['tag:kobo-sync'],
    dst: ['100.101.102.103'],
    ip: ['tcp:8083'],
  });
});
test('wildcard rewrite is explicit and applies to grants and legacy ACLs only', () => {
  const p = {
    grants: [{ src: ['*'], dst: ['*'], ip: ['*'] }],
    acls: [{ action: 'accept', src: ['*'], dst: ['*:*'] }],
  };
  const result = policyProposal(JSON.stringify(p), c, true);
  assert.deepEqual(result.rewritten, ['grants[0]', 'acls[0]']);
  assert.equal(result.conflicts.length, 0);
  const out = JSON.parse(result.text);
  assert.deepEqual(out.acls[0].src, ['autogroup:member']);
  assert.throws(() =>
    policyProposal('{"tagOwners":{"tag:kobo-sync":["group:other"]}}', c),
  );
});
test('deny tests are general, never contradict selected allowed ports', () => {
  const p = JSON.parse(
    policyProposal('{}', { ...c, ports: '443,8083' }, false, '100.100.100.100:22').text,
  );
  assert(!p.tests[0].deny.includes(c.ip + ':443'));
  assert(p.tests[0].deny.includes('100.100.100.100:22'));
  assert.equal(p.tests[1].proto, 'udp');
  assert.throws(() => policyProposal('{}', c, false, c.ip + ':8083'));
});
test('reject shell injection, invalid network values and unsafe paths', () => {
  for (const value of ['192.168.1.1', '100.064.1.1', '100.128.0.1', '100.90.1.999'])
    assert.throws(() => settings({ ...c, ip: value }));
  for (const hostname of ['$(id)', 'hi;reboot', '-invalid', 'a b'])
    assert.throws(() => settings({ ...c, hostname }));
  for (const path of ['../x', '/etc/passwd', 'a//b', 'a/../b', 'a\\b'])
    assert.throws(() => safePath(path));
  assert.throws(() => request('shell', c, 'a'.repeat(32)));
});
test('endpoint change preserves token, CRLF and every other byte', () => {
  const token = '0'.repeat(32),
    text =
      '[OneStoreServices]\r\napi_endpoint=http://192.168.0.10:8083/kobo/' +
      token +
      '\r\n[Other]\r\npassword=keep\r\n';
  const out = updateEndpoint(text, c.ip, 8083);
  assert.equal(out, text.replace('192.168.0.10', '100.101.102.103'));
  assert.throws(() => updateEndpoint(text + text, c.ip, 8083));
  assert.throws(() => updateEndpoint(text.replace('/kobo/', '/opds/'), c.ip, 8083));
});
test('numeric ranges and unknown source aliases require review', () => {
  for (const source of [
    '100.64.0.0/10',
    'fd7a:115c:a1e0::/48',
    'ipset:readers',
    'host-alias',
    'autogroup:tagged',
  ]) {
    const p = { grants: [{ src: [source], dst: ['*'], ip: ['*'] }] };
    assert.equal(policyProposal(JSON.stringify(p), c).conflicts.length, 1);
  }
});

test('regenerating the same policy is stable and preserves stronger existing tests', () => {
  const grant = { src: [c.tag], dst: [c.ip], ip: ['tcp:8083'] };
  const stronger = {
    src: c.tag,
    proto: 'tcp',
    accept: [c.ip + ':8083'],
    deny: [c.ip + ':22', c.ip + ':443', c.ip + ':8443', c.ip + ':5432'],
  };
  const udp = { src: c.tag, proto: 'udp', deny: [c.ip + ':8083'] };
  const owner = {
    src: 'owner@example.test',
    proto: 'tcp',
    accept: [c.ip + ':22'],
  };
  const original = {
    grants: [{ src: ['autogroup:member'], dst: ['*'], ip: ['*'] }, grant, grant],
    tests: [
      stronger,
      udp,
      owner,
      { ...stronger, deny: stronger.deny.slice(0, 3) },
      udp,
    ],
    ssh: [{ action: 'check' }],
    nodeAttrs: [{ attr: ['funnel'] }],
  };
  const result = policyProposal(JSON.stringify(original), c);
  const out = JSON.parse(result.text);
  assert.equal(result.conflicts.length, 0);
  assert.equal(out.grants.length, 2);
  assert.deepEqual(out.tests, [stronger, udp, owner]);
  assert.deepEqual(out.ssh, original.ssh);
  assert.deepEqual(out.nodeAttrs, original.nodeAttrs);
  assert.equal(policyProposal(result.text, c).text, result.text);
});
test('qualified grants and custom test conditions are preserved rather than treated as duplicates', () => {
  const constrained = {
    src: [c.tag],
    dst: [c.ip],
    ip: ['tcp:8083'],
    srcPosture: ['posture:secure'],
  };
  const custom = {
    src: c.tag,
    proto: 'tcp',
    accept: [c.ip + ':8083'],
    deny: [c.ip + ':22', c.ip + ':443', c.ip + ':8443'],
    srcPosture: ['posture:secure'],
  };
  const out = JSON.parse(
    policyProposal(JSON.stringify({ grants: [constrained], tests: [custom] }), c).text,
  );
  assert.deepEqual(out.grants[0], constrained);
  assert.equal(out.grants.length, 2);
  assert.deepEqual(out.tests[0], custom);
  assert.equal(out.tests.length, 3);
});
test('equivalent grant port ordering does not add another grant, and contradictory tests remain visible', () => {
  const config = { ...c, ports: '8083,8084' };
  const existing = { ip: ['tcp:8084', 'tcp:8083'], dst: [c.ip], src: [c.tag] };
  const contradictory = { src: c.tag, proto: 'tcp', deny: [c.ip + ':8083'] };
  const out = JSON.parse(
    policyProposal(
      JSON.stringify({ grants: [existing], tests: [contradictory] }),
      config,
    ).text,
  );
  assert.deepEqual(out.grants, [existing]);
  assert(out.tests.some((t) => t.deny?.includes(c.ip + ':8083')));
  assert(out.tests.some((t) => t.accept?.includes(c.ip + ':8083')));
});
