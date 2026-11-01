import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRawInbox } from '../src/unified/raw-inbox.js';

test('restart recovers original QQ event and never repeats an uncertain owner command', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-raw-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'raw.sqlite'), seen = [];
  const options = { file, verifyPrivate: () => true, hardenFile: () => ({ ok: true }), assertAccess() {}, allowed: () => true };
  const incoming = (n, id, message) => ({ post_type: 'message', message_type: 'private', self_id: 100, user_id: n, time: 1000, message_id: id, message });
  const cmd = incoming(123, 1, '/reset'), msg = incoming(124, 1, [{ type: 'image', data: { file: 'fixture' } }]);
  const first = createRawInbox({ ...options, deliver: async (_key, _kind, e) => { seen.push(e.message); throw Error('interrupted'); } });
  first.capture('private:123', cmd);
  first.capture('private:124', msg);
  await assert.rejects(first.drain('100'), /interrupted/);
  assert.deepEqual(seen, [cmd.message, msg.message]);
  const recovered = createRawInbox({ ...options, deliver: async (_key, _kind, e) => { seen.push(e); } });
  recovered.capture('private:123', cmd);
  recovered.capture('private:124', msg);
  await recovered.drain('101');
  assert.equal(seen.length, 2);
  await recovered.drain('100');
  await recovered.drain('100');
  assert.deepEqual(seen.slice(2), [msg]);
  assert.throws(() => recovered.capture('private:124', { ...msg, message: 'conflicting content' }), /RAW_EVENT_CONFLICT/);
  assert.throws(() => recovered.capture('private:124', { ...msg, time: undefined }), /INVALID_RAW_EVENT/);
});

test('maintenance receiver stores pre-login messages provisionally and only releases the verified connection generation', async t => {
  const { startCaptureReceiver } = await import('../src/unified/capture-receiver.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-capture-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const events = {}, deliveries = [], account = '100', statuses = [];
  let resolveLogin;
  const bot = { on: (k,f) => events[k]=f, onGroupMessage: f => events.group=f, onPrivateMessage: f => events.private=f,
    onRequest: (k,f) => events[k]=f, getLoginInfo: () => new Promise(r => resolveLogin=r), connect: async () => { events.open(); }, close() {} };
  const opts = { file:path.join(dir,'raw.sqlite'), verifyPrivate:()=>true,hardenFile:()=>({ok:true}), assertAccess(){}, allowed:()=>true,
    deliver: async (_key,_kind,e) => deliveries.push(e.message_id) };
  const inbox = createRawInbox(opts);
  const recv = await startCaptureReceiver({ account,bot,inbox,allowed:()=>true,relationships:true,status:s=>statuses.push(s) });
  const msg = id => ({ post_type:'message',message_type:'private',self_id:100,user_id:123,message_id:id,time:1000,message:'hello' });
  events.private(msg(1)); resolveLogin({user_id:999}); await new Promise(r=>setImmediate(r));
  events.close(); events.open(); await Promise.resolve(); events.private(msg(2)); resolveLogin({user_id:100});
  await new Promise(r=>setImmediate(r)); assert.equal(recv.verified,true);
  events.private(msg(3)); assert.deepEqual(deliveries,[]);
  await recv.close();
  const next = createRawInbox(opts); await next.drain(account);
  assert.deepEqual(deliveries,[2,3]); assert.ok(statuses.includes('unverified')); await next.close();
});
