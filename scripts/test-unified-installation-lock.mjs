import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

test('strict unified installation claim never steals live, empty, malformed or stale-looking lock', async () => {
  const h = await bridgeHarness();
  const file = path.join(h.temp, 'state/bridge.lock');
  const original = fs.readFileSync(file);
  try {
    for (const value of [String(process.pid), '', 'malformed', '999999999']) {
      fs.writeFileSync(file, value);
      assert.throws(() => h.acquireLock({ strict: true }), { code: 'MIGRATION_INSTALLATION_LOCKED' });
      assert.equal(fs.readFileSync(file, 'utf8'), value);
    }
  } finally { fs.writeFileSync(file, original); await h.close(); }
});
