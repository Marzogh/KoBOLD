import test from 'node:test';
import assert from 'node:assert/strict';
import { authorisationStep } from '../web/lib/authorisation-ui.js';
const base = {
  active: true,
  systemBackup: true,
  configured: true,
  pending: null,
  returned: false,
  status: null,
  signin: null,
  opened: false,
  healthy: false,
};
test('one authorisation control follows prepare, USB return, sign-in, check and verified completion', () => {
  assert.equal(authorisationStep(base).action, 'enrol');
  let s = authorisationStep({ ...base, pending: { action: 'enrol' } });
  assert.equal(s.action, 'read');
  assert(s.disabled);
  assert(
    !authorisationStep({
      ...base,
      pending: { action: 'enrol' },
      returned: true,
    }).disabled,
  );
  assert.equal(
    authorisationStep({
      ...base,
      status: { BackendState: 'NeedsLogin' },
      signin: 'https://login.tailscale.com/a/fixture',
    }).action,
    'open',
  );
  assert.equal(
    authorisationStep({
      ...base,
      status: { BackendState: 'NeedsLogin' },
      signin: 'https://login.tailscale.com/a/fixture',
      opened: true,
    }).action,
    'status',
  );
  s = authorisationStep({ ...base, healthy: true });
  assert(s.disabled);
  assert.equal(s.label, 'Kobo authorised');
});
test('opening sign-in is not completion; missing prerequisites and unrelated pending work stay gated', () => {
  assert(!authorisationStep({ ...base, opened: true }).disabled);
  assert.equal(authorisationStep({ ...base, opened: true }).action, 'status');
  for (const key of ['active', 'systemBackup', 'configured'])
    assert(authorisationStep({ ...base, [key]: false }).disabled);
  assert(
    authorisationStep({
      ...base,
      pending: { action: 'connect' },
      returned: true,
    }).disabled,
  );
});
test('a still-unregistered Kobo can obtain a fresh sign-in link after refresh or expiry', () => {
  assert.equal(
    authorisationStep({ ...base, status: { BackendState: 'NeedsLogin' } }).action,
    'enrol',
  );
  assert.equal(
    authorisationStep({
      ...base,
      pending: { action: 'status' },
      returned: true,
    }).action,
    'read',
  );
});

test('pending authorisation results can be read after refresh before the active receipt is restored', () => {
  const step = authorisationStep({
    ...base,
    active: false,
    pending: { action: 'enrol' },
    returned: true,
  });
  assert.equal(step.action, 'read');
  assert(!step.disabled);
});

test('managed update checks retained enrolment before asking for a new login', () => {
  const base = {
    active: true,
    systemBackup: true,
    configured: true,
    existingEnrollment: true,
  };
  assert.equal(authorisationStep(base).action, 'status');
  assert.equal(
    authorisationStep({ ...base, status: { BackendState: 'NeedsLogin' } }).action,
    'enrol',
  );
  assert.equal(authorisationStep({ ...base, systemBackup: false }).disabled, true);
});
