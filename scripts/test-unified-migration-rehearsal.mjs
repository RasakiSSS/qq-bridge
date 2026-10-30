import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { MigrationIngress, createMigrationBarrier } from '../src/unified/migration-ingress.js';
import { captureMigrationSnapshot, readLegacySnapshotFiles, loadMigrationSnapshot } from '../src/unified/migration-snapshot.js';
import { MigrationStage } from '../src/unified/migration-stage.js';
import { importStagedMigration } from '../src/unified/migration-import.js';
import { importMigrationDeltas } from '../src/unified/migration-delta.js';
import { UnifiedStore } from '../src/unified/store.js';
import { assertLegacySessionsIdle } from '../src/unified/bridge-driver.js';

// Forward HALF of the rehearsal. Real bridge/Qzone persistence, but synthetic
// source ownership, DSH, ACL and ingress routing. No activation or rollback is
// claimed here, and no production process or source files are used.
test('isolated forward rehearsal composes bridge saves, Qzone drain, snapshot, ingress and fenced import', async () => {
  const h = await bridgeHarness({ config: { socialV2: { sharedMemory: { enabled: false } } } });
  let journal, stage, store, qzoneLease;
  try {
    h.socialV2.paused = true;
    const old = h.getSocialV2State('group:456');
    const legacy = { seq: 1, messageId: 'old-message', userId: '200', text: 'legacy preview', time: 1000 };
    old.recentMessages = [legacy]; old.unread = [legacy]; old.lastUnreadSeq = 1; old.lastReadThroughSeq = 0;
    old.wakeConfig.mode = 'diving';
    h.saveState({ strict: true }); h.saveSocialV2State({ strict: true }); h.saveInitialPrompts({ strict: true });
    const privateRoot = path.join(h.temp, 'private-migration'); fs.mkdirSync(privateRoot);
    const identity = () => ({ account: '100', sourceAccount: '100', epoch: 'fixture-epoch', provenance: 'fixture-owner-confirmation' });
    journal = new MigrationIngress({ file: path.join(privateRoot, 'ingress.sqlite'), verifyPrivate: () => true, assertExclusive: () => true });
    let flushes = 0;
    const barrier = createMigrationBarrier({ journal, currentIdentity: identity,
      assertLegacyIdle: async () => {
        await assertLegacySessionsIdle({ sessions: { list: async () => ({ result: { ok: true, value: { items: [] } } }) } }, []);
        return true;
      },
      flushLegacy: async () => {
        qzoneLease = await h.qzoneService.quiesceForMigration({ assertExclusive: () => true });
        for (const save of [h.saveState, h.saveSocialV2State, h.saveInitialPrompts]) assert.equal(save({ strict: true }), true);
        assert.equal(qzoneLease.flush(), true); flushes++; return true;
      },
    });
    const incoming = { account: '100', scene: 'group:456', kind: 'message', sourceId: 'during-snapshot', at: 2000,
      payload: { text: 'full incoming after routing barrier', senderQQ: '200', media: [] } };
    let reads = 0;
    const captured = await captureMigrationSnapshot({ root: privateRoot, verifyPrivate: () => true, acquire: barrier.acquire,
      readFiles: async () => {
        if (++reads === 1) await barrier.ingest(incoming, () => assert.fail('must not mutate old bridge during capture'));
        return readLegacySnapshotFiles(h.temp);
      } });
    assert.equal(flushes, 1); assert.equal(reads, 2); assert.equal(old.unread.length, 1);
    const handle = loadMigrationSnapshot({ ...captured, expectedAccount: '100', verifyPrivate: () => true, attest: () => true });
    journal.bindSnapshot(identity(), handle);
    stage = new MigrationStage({ file: path.join(privateRoot, 'stage.sqlite'), verifyPrivate: () => true });
    stage.importSnapshot(handle); journal.transfer(identity(), stage);
    store = new UnifiedStore(path.join(privateRoot, 'unified.sqlite'));
    const options = { store, stage, account: '100', assertExclusive: () => true };
    importStagedMigration({ ...options, retainDeltas: true }); importMigrationDeltas(options);
    assert.equal(importMigrationDeltas(options).duplicate, 1);
    const events = store.db.prepare('SELECT source_id,payload,unread,wake FROM events ORDER BY seq').all();
    assert.deepEqual(events.map(row => row.source_id), ['old-message', 'during-snapshot']);
    assert.ok(events.every(row => row.unread === 1 && row.wake === 0));
    assert.equal(JSON.parse(events[0].payload).originalUnavailable, true);
    assert.equal(JSON.parse(events[1].payload).text, incoming.payload.text);
    assert.equal(store.db.prepare('SELECT paused FROM accounts').get().paused, 1);
    assert.equal(store.db.prepare('SELECT phase FROM migration_imports').get().phase, 'staged');
    assert.equal(h.calls.prompts.length, 0); assert.equal(h.calls.sent.length, 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(h.temp, 'state/social-v2.json'))).conversations['group:456'].unread.length, 1);
    // The current rollback output is still a plan, explicitly NOT an executed
    // recovery. Keep this assertion until a real reverse merge is implemented.
    assert.equal(stage.rollbackPlan('100').applicable, false);
    qzoneLease.release();
    assert.throws(() => barrier.runLegacy(() => {}), { code: 'MIGRATION_PENDING' });
  } finally {
    store?.close(); stage?.close(); journal?.close(); await h.close();
  }
});
