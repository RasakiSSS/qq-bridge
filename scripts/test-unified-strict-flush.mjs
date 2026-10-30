import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

async function fixture(t) {
  let fault = '', synced = 0;
  const wrapped = { ...fs,
    writeFileSync(...args) {
      if (fault === 'write') throw Object.assign(Error('fixture write failed'), { code: 'ENOSPC' });
      return fs.writeFileSync(...args);
    },
    fsyncSync(fd) {
      if (fault === 'sync') throw Object.assign(Error('fixture sync failed'), { code: 'EIO' });
      synced++; return fs.fsyncSync(fd);
    },
    readFileSync(file, ...args) {
      const value = fs.readFileSync(file, ...args);
      return fault === 'verify' && String(file).endsWith('social-v2.json') ? value + ' ' : value;
    },
  };
  const h = await bridgeHarness({ globals: { fs: wrapped } }); t.after(() => h.close());
  return { h, setFault(value) { fault = value; }, get synced() { return synced; } };
}

test('strict bridge saves fsync and verify real fixture state without changing pause or unread', async t => {
  const f = await fixture(t), h = f.h;
  h.socialV2.paused = true;
  const scene = h.getSocialV2State('group:1'); scene.lastUnreadSeq = 7;
  scene.unread = [{ seq: 7, text: 'fixture pending' }];
  for (const save of [h.saveState, h.saveSocialV2State, h.saveInitialPrompts]) assert.equal(save({ strict: true }), true);
  assert.equal(f.synced, 3);
  const data = JSON.parse(fs.readFileSync(path.join(h.temp, 'state/social-v2.json'), 'utf8'));
  assert.equal(data.paused, true); assert.equal(data.conversations['group:1'].lastUnreadSeq, 7);
  assert.equal(data.conversations['group:1'].unread[0].text, 'fixture pending');
});

test('strict failures propagate, failed temp writes preserve originals and legacy callers keep behavior', async t => {
  const f = await fixture(t), h = f.h;
  h.saveSocialV2State({ strict: true });
  const file = path.join(h.temp, 'state/social-v2.json'), before = fs.readFileSync(file);
  for (const fault of ['write', 'sync']) {
    f.setFault(fault);
    for (const save of [h.saveState, h.saveSocialV2State, h.saveInitialPrompts]) assert.throws(() => save({ strict: true }), { code: fault === 'write' ? 'ENOSPC' : 'EIO' });
    assert.deepEqual(fs.readFileSync(file), before);
  }
  f.setFault('write');
  assert.doesNotThrow(() => h.saveSocialV2State()); assert.equal(h.saveInitialPrompts(), false);
  assert.throws(() => h.saveState(), { code: 'ENOSPC' }); // Original session save already propagated errors.
  f.setFault('');
  assert.ok(fs.readdirSync(path.dirname(file)).every(name => !name.endsWith('.tmp')));
});

test('strict saves reject read-only degradation and detect post-write verification failure', async t => {
  const f = await fixture(t), h = f.h;
  h.setStateWritableForTest(false); h.setInitialPromptsWritableForTest(false);
  assert.equal(h.saveState(), undefined); assert.equal(h.saveInitialPrompts(), false);
  assert.throws(() => h.saveState({ strict: true }), { code: 'STATE_READ_ONLY' });
  assert.throws(() => h.saveInitialPrompts({ strict: true }), { code: 'STATE_READ_ONLY' });
  f.setFault('verify');
  assert.throws(() => h.saveSocialV2State({ strict: true }), { code: 'STATE_WRITE_VERIFY_FAILED' });
  f.setFault('');
});

test('corrupt legacy social source cannot be replaced by strict flush of fallback memory', async t => {
  const h = await bridgeHarness({ files: { 'state/social-v2.json': '{broken fixture' } });
  t.after(() => h.close());
  const file = path.join(h.temp, 'state/social-v2.json'), before = fs.readFileSync(file);
  assert.throws(() => h.saveSocialV2State({ strict: true }), { code: 'STATE_SOURCE_UNVERIFIED' });
  assert.deepEqual(fs.readFileSync(file), before);
});
