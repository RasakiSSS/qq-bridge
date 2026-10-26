import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

test('shared memory endpoint auth, write evidence, owner-only forget, revocation and malformed input', async () => {
  const h = await bridgeHarness({ config: { allow: { groups: ['456', '789'], private: ['123'] } } });
  h.setMode('reserved2'); h.setSelfIdentity('鲸鱼', '9');
  const owner = h.getSocialV2State('private:123').agentToken, group = h.getSocialV2State('group:456').agentToken;
  const server = h.startConsoleServer(h.cfg); if (!server.listening) await new Promise((r) => server.once('listening', r));
  const event = h.sharedMemory.record({ accountQQ: '9', actorQQ: '123', source: 'private:123', externalId: 'a', text: '计划去海边' });
  const request = (action, body, token = group, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: '/api/socialV2/shared-memory/' + action, method: 'POST',
      headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token', 'x-agent-call': '1', ...(token === null ? {} : { 'x-agent-token': token }), ...headers } }, (res) => {
      let content = ''; res.on('data', (s) => { content += s; }); res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(content) }));
    }); req.on('error', reject); req.end(JSON.stringify(body));
  });
  try {
    for (const token of [null, '', 'fake']) assert.equal((await request('recall', { key: 'group:456' }, token)).status, 403);
    assert.equal((await request('recall', { key: 'group:789' })).status, 403);
    assert.equal((await request('recall', { key: 'private:123' })).status, 403);
    const recalled = await request('recall', { key: 'group:456', people: ['123'] });
    assert.equal(recalled.status, 200); assert.equal(recalled.data.events[0].source, 'private:123');
    assert.equal((await request('recall', null)).status, 400);
    assert.equal((await request('recall', { key: 'group:456', people: '123' })).status, 400);
    assert.equal((await request('recall', { key: 'group:456' }, group, { origin: 'https://external.invalid' })).status, 403);
    const note = { kind: 'fact', personQQ: '123', text: '计划去海边', evidenceIds: [event] };
    const saved = await request('remember', { key: 'group:456', note }); assert.equal(saved.status, 200);
    const original = h.sharedMemory.recall('9').notes.find((n) => n.id === saved.data.id);
    const correction = { ...note, id: saved.data.id, text: '改成下周去海边', updatedAt: original.updatedAt };
    assert.equal((await request('remember', { key: 'group:456', note: correction })).status, 200);
    assert.equal((await request('remember', { key: 'group:456', note: correction })).status, 409);
    assert.equal((await request('history', { key: 'group:456', id: saved.data.id })).status, 403);
    assert.equal((await request('history', { key: 'private:123', id: saved.data.id }, owner)).data.history[0].text, note.text);
    assert.equal((await request('status', { key: 'group:456' })).status, 403);
    assert.equal((await request('status', { key: 'private:123' }, owner)).status, 200);
    assert.equal((await request('remember', { key: 'group:456', note: { ...note, evidenceIds: ['fake'] } })).status, 400);
    assert.equal((await request('forget', { key: 'group:456', ids: [saved.data.id] })).status, 403);
    h.cfg.allow.groups = []; assert.equal((await request('recall', { key: 'group:456' })).status, 403);
    h.cfg.allow.groups = ['456']; h.cfg.socialV2.tools.memory = false;
    assert.equal((await request('recall', { key: 'group:456' })).status, 403); h.cfg.socialV2.tools.memory = true;
    h.cfg.socialV2.sharedMemory = { enabled: false };
    assert.equal((await request('remember', { key: 'private:123', note }, owner)).status, 403); h.cfg.socialV2.sharedMemory.enabled = true;
    assert.equal((await request('forget', { key: 'private:123', ids: [saved.data.id] }, owner)).status, 200);
    assert.equal(h.sharedMemory.recall('9').events.length, 0);
    h.getSocialV2State('group:456').agentToken = 'new-fixture-token';
    assert.equal((await request('recall', { key: 'group:456' }, group)).status, 403);
  } finally { await new Promise((r) => server.close(r)); await h.close(); }
});
