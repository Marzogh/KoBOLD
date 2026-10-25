import test from 'node:test';
import assert from 'node:assert/strict';
import {
  tabSession,
  SESSION_TTL,
  SESSION_KEY,
  folderPermission,
} from '../web/lib/session.js';
const memory = () => {
  const map = new Map();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => map.set(k, v),
    removeItem: (k) => map.delete(k),
  };
};
test('refresh restores only allowed fields and progress, with a tab-local identity', () => {
  const storage = memory(),
    first = tabSession(storage);
  assert(
    first.save({
      form: {
        hostname: 'sample-kobo',
        ip: '100.101.102.103',
        privateKey: 'must not save',
      },
      page: 'install',
      policyConfirmed: true,
      policyText: '{}',
      signin: 'https://secret',
      backupName: 'kobold-' + 'a'.repeat(36),
    }),
  );
  const refreshed = tabSession(storage),
    saved = refreshed.load();
  assert.equal(refreshed.id, first.id);
  assert.equal(saved.form.hostname, 'sample-kobo');
  assert.equal(saved.page, 'install');
  assert(!('privateKey' in saved.form));
  assert(!('signin' in saved));
  assert.equal(tabSession(memory()).load(), null);
  refreshed.clear();
  assert.equal(first.load(), null);
});
test('expired, corrupt and inaccessible session storage fails without enabling progress', () => {
  const storage = memory();
  let now = 10000000;
  const session = tabSession(storage, () => now);
  session.save({ form: { hostname: 'saved' }, page: 'install' });
  now += SESSION_TTL + 1;
  assert.equal(session.load(), null);
  storage.setItem(SESSION_KEY, 'broken');
  assert.equal(session.load(), null);
  const blocked = tabSession({
    getItem() {
      throw Error('blocked');
    },
    setItem() {
      throw Error('full');
    },
  });
  assert.equal(blocked.load(), null);
  assert.equal(blocked.save({}), false);
});
test('folder restore never requests new permission automatically', async () => {
  let requests = 0;
  const handle = {
    queryPermission: async () => 'prompt',
    requestPermission: async () => {
      requests++;
      return 'granted';
    },
  };
  assert.equal(await folderPermission({ reader: handle, backup: handle }), false);
  assert.equal(requests, 0);
  assert.equal(await folderPermission({ reader: handle, backup: handle }, true), true);
  assert.equal(requests, 2);
});
