import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFriendValidation } from '../plugins/qq-friend-probe/friend-validation.cjs';
import { watchBuddyRequests } from '../plugins/qq-friend-probe/friend-requests.cjs';
import { QQ_VERSION, WRAPPER_SHA256, MAJOR_SHA256 } from '../plugins/qq-friend-probe/friend-adapter.cjs';
const account = '123456789', target = '987654321', uid = 'u_0123456789012345678901';
async function setup(t) {
  const journalDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-validation-'));
  t.after(() => fs.rm(journalDir, { recursive: true, force: true }));
  let friend = false, pending = false, valid = true, sent = 0, reads = 0, friendReads = 0, unknown = false;
  const pins = { qqVersion: QQ_VERSION, wrapperSha256: WRAPPER_SHA256, majorSha256: MAJOR_SHA256 };
  const listener = { onBuddyReqChange() {} };
  const receiver = {
    async addBuddy() { sent++; return { result: 0, rsp: { result: 0, errorCode: 0 } }; },
    async getBuddySetting() { reads++; return { result: 0, rsp: { querySetting: 1, isContactFriend: false, errorCode: 0 } }; },
  };
  const b = { ...pins, accountUin: account, receiver, method: receiver.addBuddy, epoch: 1, isCurrent: () => valid };
  const buddy = {
    addKernelBuddyListener() { return 'id'; }, removeKernelBuddyListener() {},
    getBuddyReq() { queueMicrotask(() => listener.onBuddyReqChange(unknown ? {} : { buddyReqs: pending ? [{ friendUid: uid, reqType: 0, isDecide: false }] : [] })); },
  };
  const requestReader = watchBuddyRequests({ ...pins, receiver: buddy, isCurrent: () => valid }, { targetUid: uid });
  buddy.addKernelBuddyListener(listener);
  const config = { ...pins, enabled: true, expectedUin: account, allowedTargetUins: [target], journalDir,
    request: { action: 'request', accountUin: account, targetUin: target, idempotencyKey: 'maintenance-test-0001', dryRun: true,
      addFriendSetting: 1, answer: 'test', remark: '', defaultCategory: 0, sourceId: 5, sourceSubId: 2,
      onlyChat: false, qzoneNotWatch: false, qzoneNotWatched: false } };
  const deps = { getBinding: () => valid ? b : null, getRequestReader: () => requestReader,
    readFriendStatus: async () => { friendReads++; return { accountUin: account, targetUin: target, friend }; } };
  const validation = createFriendValidation(config, deps);
  t.after(() => { validation.stop(); requestReader.stop(); });
  return { validation, config, deps, requestReader, journalDir, counts: () => ({ sent, reads, friendReads }),
    friend: v => { friend = v; }, pending: v => { pending = v; }, unknown: () => { unknown = true; }, invalidate: () => { valid = false; } };
}
test('composed preflight does not send/reserve; explicit send rechecks and invokes once across controllers', async t => {
  const f = await setup(t);
  const preflight = await f.validation.run('preflight');
  assert.equal(preflight.eligible, true); assert.equal(preflight.pendingScope, 'client-request-list');
  assert.equal(f.counts().sent, 0); assert.deepEqual(await fs.readdir(f.journalDir), []);
  const result = await f.validation.run('send-once'); assert.equal(result.nativeInvoked, true); assert.equal(result.requestSent, null);
  assert.deepEqual(f.counts(), { sent: 1, reads: 2, friendReads: 2 });
  const again = createFriendValidation(f.config, f.deps); t.after(() => again.stop());
  assert.equal((await again.run('send-once')).nativeInvoked, false); assert.equal(f.counts().sent, 1);
});
test('friend/pending change after preflight, unknown lists and stale binding prevent native calls', async t => {
  for (const state of ['friend', 'pending', 'unknown', 'invalidate']) {
    const f = await setup(t); assert.equal((await f.validation.run('preflight')).eligible, true);
    f[state](true); const result = await f.validation.run('send-once');
    assert.equal(result.nativeInvoked, false, state); assert.equal(f.counts().sent, 0);
    assert.deepEqual(await fs.readdir(f.journalDir), []);
  }
});
test('maintenance action boundary rejects arbitrary actions and remains stopped', async t => {
  const f = await setup(t);
  assert.equal((await f.validation.run('delete')).code, 'ERR_ACTION');
  f.validation.stop(); assert.equal((await f.validation.run('send-once')).code, 'ERR_VALIDATION_STOPPED');
  assert.equal(f.counts().sent, 0);
});
test('overlapping preflight/send commands cannot race the shared reader', async t => {
  const f = await setup(t); const pending = f.validation.run('preflight');
  assert.equal((await f.validation.run('send-once')).code, 'ERR_BUSY');
  assert.equal((await pending).eligible, true); assert.equal(f.counts().sent, 0);
});
