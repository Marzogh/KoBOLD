import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseHostname, fieldError } from '../web/lib/form-validation.js';
test('hostname normalises spaces and case without silently removing forbidden symbols', () => {
  assert.equal(normaliseHostname('  Sample   Kobo  '), 'sample-kobo');
  assert.equal(normaliseHostname('Sample’s Kobo!'), 'sample’s-kobo!');
  assert(fieldError('hostname', normaliseHostname('Sample’s Kobo!')));
  assert.equal(fieldError('hostname', normaliseHostname('Sample Kobo')), '');
});
test('each settings field identifies bad input without changing its syntax', () => {
  for (const [name, value] of [
    ['ip', '100.64.2.x'],
    ['ip', '192.168.1.1'],
    ['ports', '8083;22'],
    ['ports', '65536'],
    ['tag', 'tag:kobo sync'],
    ['owner', 'not an email'],
    ['hostname', '-kobo'],
    ['original-policy', ''],
    ['original-policy', '{"grants": [}'],
    ['extra-deny', '100.x.x.x:22'],
  ])
    assert(fieldError(name, value), name + ': ' + value);
  for (const [name, value] of [
    ['ip', '100.101.102.103'],
    ['ports', '8083, 8443'],
    ['tag', 'tag:kobo-sync'],
    ['owner', 'autogroup:admin'],
    ['owner', 'group:family'],
    ['owner', 'reader+tag@example.test'],
    ['original-policy', '/* policy */ {"grants":[],}'],
    ['extra-deny', ''],
  ])
    assert.equal(fieldError(name, value), '', name);
});
test('additional tests reject conflicts with allowed TCP destinations', () => {
  assert(
    fieldError('extra-deny', '100.101.102.103:8083', {
      ip: '100.101.102.103',
      ports: '8083',
    }),
  );
  assert.equal(
    fieldError('extra-deny', '100.101.102.103:22', {
      ip: '100.101.102.103',
      ports: '8083',
    }),
    '',
  );
});
