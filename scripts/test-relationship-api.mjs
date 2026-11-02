import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

test('relationship API records requests, restricts visibility and executes guarded OneBot actions', async () => {
  const h = await bridgeHarness({ config: {
    allow: { private: ['123'], groups: ['456'] },
    socialV2: {
      relationships: { enabled: true, promptPendingRequests: false },
      tools: { relationships: true },
    },
  } });
  h.setMode('reserved2'); h.setSelfIdentity('鲸鱼', '9');
  // Keep the fixture explicit even if the production config defaults change.
  h.cfg.socialV2.relationships = { enabled: true, promptPendingRequests: false, ...(h.cfg.socialV2.relationships ?? {}) };
  h.cfg.socialV2.tools.relationships = true;
  const ownerToken = h.getSocialV2State('private:123').agentToken;
  const groupToken = h.getSocialV2State('group:456').agentToken;
  const server = h.startConsoleServer(h.cfg);
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const request = (method, route, body, token = null) => new Promise((resolve, reject) => {
    const headers = { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token' };
    if (token !== null) Object.assign(headers, { 'x-agent-call': '1', 'x-agent-token': token });
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: route, method, headers }, (res) => {
      let content = '';
      res.on('data', (chunk) => { content += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(content) }));
    });
    req.on('error', reject);
    if (body !== undefined) req.end(JSON.stringify(body)); else req.end();
  });
  try {
    const event = { post_type: 'request', request_type: 'friend', flag: 'fixture-flag', user_id: 222, comment: '请通过', time: 1700000000 };
    h.bot.emitRequest('friend', event);
    h.bot.emitRequest('friend', { ...event, comment: '重复申请更新说明' });
    assert.equal((await request('GET', '/api/socialV2/relationships/requests?key=private%3A123', undefined, ownerToken)).status, 200);
    const visible = await request('GET', '/api/socialV2/relationships/requests?key=private%3A123', undefined, ownerToken);
    assert.equal(visible.data.requests.length, 1);
    assert.equal(visible.data.requests[0].comment, '重复申请更新说明');
    assert.equal((await request('GET', '/api/socialV2/relationships/requests?key=group%3A456', undefined, groupToken)).status, 403);
    assert.equal((await request('GET', '/api/socialV2/relationships/status?key=private%3A123', undefined, 'wrong-token')).status, 403);

    const accepted = await request('POST', '/api/socialV2/relationships/action', {
      key: 'private:123', action: 'accept_request', input: { requestId: 'friend-request:fixture-flag', reason: '资料足够' },
    }, ownerToken);
    assert.equal(accepted.status, 200);
    assert.equal(accepted.data.result.status, 'succeeded');
    assert.deepEqual(h.calls.requests[0], { action: 'set_friend_add_request', params: { flag: 'fixture-flag', approve: true } });

    const afterAccept = await request('GET', '/api/socialV2/relationships/requests?key=private%3A123', undefined, ownerToken);
    assert.equal(afterAccept.data.requests.length, 0);
    const status = await request('GET', '/api/socialV2/relationships/status?key=private%3A123', undefined, ownerToken);
    assert.equal(status.data.status.history, 1);
    assert.equal(status.data.status.recent[0].reason, '资料足够');

    const deleted = await request('POST', '/api/socialV2/relationships/action', {
      key: 'private:123', action: 'delete_friend', input: { userId: '222', block: false, reason: '结束联系' },
    }, ownerToken);
    assert.equal(deleted.status, 200);
    assert.deepEqual(h.calls.requests[1], { action: 'delete_friend', params: { user_id: 222, block: false } });

    const left = await request('POST', '/api/socialV2/relationships/action', {
      key: 'private:123', action: 'leave_group', input: { groupId: '456', reason: '离开群组' },
    }, ownerToken);
    assert.equal(left.status, 200);
    assert.deepEqual(h.calls.requests[2], { action: 'set_group_leave', params: { group_id: 456 } });
    assert.equal((await request('POST', '/api/socialV2/relationships/action', { key: 'private:123', action: 'deleteFriend', input: { userId: '222' } }, ownerToken)).status, 400);

    h.cfg.socialV2.tools.relationships = false;
    assert.equal((await request('GET', '/api/socialV2/relationships/status?key=private%3A123', undefined, ownerToken)).status, 403);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await h.close();
  }
});
