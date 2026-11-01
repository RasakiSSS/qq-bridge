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

test('maintenance holds the same exclusive loopback port probed by legacy startup', async()=>{
  const {holdMigrationPort}=await import('../src/unified/maintenance-port.js');
  const net=await import('node:net');
  const probe=net.createServer(); await new Promise((ok,no)=>{probe.once('error',no);probe.listen(0,'127.0.0.1',ok);});
  const port=probe.address().port;await new Promise(r=>probe.close(r));
  const held=await holdMigrationPort(port);
  try{held.assert();await assert.rejects(holdMigrationPort(port),{code:'MIGRATION_INSTALLATION_LOCKED'});}finally{await held.close();}
  assert.throws(()=>held.assert(),{code:'MIGRATION_EXCLUSIVE_REQUIRED'});
  const next=await holdMigrationPort(port);await next.close();
});
