import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UnifiedStore } from '../src/unified/store.js';
import { UnifiedOwner } from '../src/unified/owner.js';

function fixture(t) { const store = new UnifiedStore(); t.after(() => store.close()); return store; }
test('one live owner per account; graceful release advances generation', t => {
  const store = fixture(t), first = new UnifiedOwner({ store, account: '100' });
  assert.throws(() => new UnifiedOwner({ store, account: '100' }), { code: 'RUNTIME_ALREADY_OWNED' });
  first.release(); const second = new UnifiedOwner({ store, account: '100' });
  assert.equal(second.generation, first.generation + 1); second.assert();
  assert.throws(() => first.assert(), { code: 'RUNTIME_NOT_OWNER' }); second.release();
});
test('confirmed dead process permits takeover; old owner is fenced and cannot release new ownership', t => {
  const store = fixture(t), first = new UnifiedOwner({ store, account: '100', host: 'fixture', pid: 123 });
  const second = new UnifiedOwner({ store, account: '100', host: 'fixture', processAlive: () => false });
  assert.throws(() => first.assert(), { code: 'RUNTIME_NOT_OWNER' }); first.release(); second.assert(); second.release();
});
test('foreign host, reused PID and uncertain liveness never authorize takeover', t => {
  const store = fixture(t), first = new UnifiedOwner({ store, account: '100', host: 'fixture', pid: 123 });
  for (const options of [{ host: 'other', processAlive: () => false }, { host: 'fixture', processAlive: () => true }, { host: 'fixture', processAlive: () => undefined }]) {
    assert.throws(() => new UnifiedOwner({ store, account: '100', ...options }), { code: 'RUNTIME_ALREADY_OWNED' });
  }
  first.assert(); first.release();
});
