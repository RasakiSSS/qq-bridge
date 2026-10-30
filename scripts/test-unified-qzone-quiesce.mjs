import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createQzoneService } from '../src/qzone.js';

function fixture(t, initial) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qzone-quiesce-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'qzone.json');
  if (initial !== undefined) fs.writeFileSync(file, initial);
  let gate = null, observed = 0;
  const calls = [];
  const service = createQzoneService({ file, getConfig: () => ({ enabled: true }),
    assertAllowed() {}, audit() {}, decide: () => assert.fail('model must not run'),
    observeMemory: () => { observed++; }, request: async action => {
      calls.push(action); if (gate) await gate;
      const data = action === 'get_login_info' ? { user_id: 100 }
        : action === 'get_qzone_feeds' ? { feeds: [] }
          : action === 'get_qzone_msg_list' ? { msglist: [] } : assert.fail('unexpected request');
      return { status: 'ok', retcode: 0, data };
    } });
  return { service, file, calls, get observed() { return observed; }, setGate(value) { gate = value; } };
}

test('Qzone maintenance drains entered work, rejects queued/new work and flushes without memory or network effects', async t => {
  const f = fixture(t); let finish;
  f.setGate(new Promise(resolve => { finish = resolve; }));
  const entered = f.service.status({});
  await Promise.resolve(); // The first operation has entered the serial queue.
  const queued = f.service.status({});
  const queuedFailure = assert.rejects(queued, /迁移维护/);
  const acquiring = f.service.quiesceForMigration({ assertExclusive: () => true });
  finish(); await entered; await queuedFailure;
  const lease = await acquiring;
  const count = f.calls.length, observed = f.observed;
  assert.equal(lease.flush(), true); assert.equal(f.calls.length, count); assert.equal(f.observed, observed);
  assert.ok(JSON.parse(fs.readFileSync(f.file, 'utf8')).accounts['100']);
  lease.release(); assert.throws(() => lease.flush(), /租约不可用/);
  await assert.rejects(f.service.status({}), /迁移维护/);
});

test('missing exclusivity and corrupt source fail without overwriting files', async t => {
  const f = fixture(t, '{broken');
  await assert.rejects(f.service.quiesceForMigration(), /独占/);
  await assert.rejects(f.service.quiesceForMigration({ assertExclusive: () => true }), /不可用于迁移/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), '{broken'); assert.equal(f.calls.length, 0);
});

test('lost exclusivity after drain blocks flush and keeps the service frozen', async t => {
  const f = fixture(t); let exclusive = true;
  const lease = await f.service.quiesceForMigration({ assertExclusive: () => exclusive });
  exclusive = false;
  assert.throws(() => lease.flush(), /独占/); assert.equal(fs.existsSync(f.file), false);
  await assert.rejects(f.service.status({}), /迁移维护/);
});

test('maintenance during browsing prevents the subsequent model call, while background polls become idle', async t => {
  const f = fixture(t); let finish;
  f.setGate(new Promise(resolve => { finish = resolve; }));
  const running = f.service.run(); await Promise.resolve();
  const acquiring = f.service.quiesceForMigration({ assertExclusive: () => true });
  finish(); await running;
  const lease = await acquiring; assert.equal(lease.flush(), true);
  const before = f.calls.length;
  await f.service.run();
  assert.equal((await f.service.collect({}, () => assert.fail('no delivery'))).status, 'idle');
  assert.equal(f.calls.length, before); lease.release();
});
