'use strict';

// Maintenance-only composition. The request is fixed by the local package;
// callers select preflight/send-once, never a target, method or native args.
const { createFriendRuntime } = require('./friend-runtime.cjs');
const { createBuddySettingReader } = require('./friend-setting.cjs');

function createFriendValidation(config, { getBinding, getRequestReader, readFriendStatus, authorize }) {
  const { request, journalDir, timeoutMs = 15000, ...planning } = config;
  const fixed = Object.freeze({ ...request, accountUin: planning.expectedUin, action: 'request' });
  const setting = createBuddySettingReader({ ...planning, mode: 'dry-run' }, getBinding, { timeoutMs });
  let stopped = false, busy = false;
  async function lookupRelationship({ accountUin, targetUin, sourceId, sourceSubId }) {
    if (stopped || accountUin !== fixed.accountUin || targetUin !== fixed.targetUin) throw Error('ERR_VALIDATION_SCOPE');
    const b = getBinding();
    if (!b?.isCurrent()) throw Error('ERR_BINDING_UNAVAILABLE');
    const friends = await readFriendStatus();
    if (friends.accountUin !== accountUin || friends.targetUin !== targetUin || typeof friends.friend !== 'boolean') throw Error('ERR_FRIEND_STATE');
    if (friends.friend) return { accountUin, targetUin, friend: true, pending: false, addFriendSetting: null };
    const reader = getRequestReader();
    if (!reader?.ready()) throw Error('ERR_REQUEST_LISTENER_UNAVAILABLE');
    const list = await reader.read();
    if (list.status !== 'read' || list.scope !== 'client-request-list' || typeof list.pending !== 'boolean') throw Error('ERR_REQUEST_STATE');
    const settings = await setting.read({ targetUin, sourceId, sourceSubId });
    if (settings.status !== 'read' || settings.accountUin !== accountUin || settings.targetUin !== targetUin
      || getBinding() !== b || !b.isCurrent() || getRequestReader() !== reader || !reader.ready() || stopped) throw Error('ERR_BINDING_OR_SETTING');
    return Object.freeze({ accountUin, targetUin, friend: false, pending: list.pending, addFriendSetting: settings.addFriendSetting });
  }
  const runtime = createFriendRuntime({ ...planning, mode: 'send-once', journalDir, timeoutMs }, { getBinding, lookupRelationship, ...(authorize ? { authorize } : {}) });
  async function run(action) {
    if (stopped) return { status: 'not_called', code: 'ERR_VALIDATION_STOPPED', requestSent: false };
    if (busy) return { status: 'not_called', code: 'ERR_BUSY', requestSent: false };
    if (!['preflight', 'send-once'].includes(action)) return { status: 'not_called', code: 'ERR_ACTION', requestSent: false };
    busy = true;
    try {
      if (action === 'send-once') return await runtime.execute({ ...fixed, dryRun: false });
      const prepared = runtime.prepare({ ...fixed, dryRun: true });
      if (prepared.code !== 'PREPARED') return prepared;
      const r = await lookupRelationship(fixed);
      return { status: 'preflight', requestSent: false, friend: r.friend, pending: r.friend ? null : r.pending,
        pendingScope: 'client-request-list', addFriendSetting: r.addFriendSetting,
        eligible: !r.friend && !r.pending && r.addFriendSetting === fixed.addFriendSetting };
    } catch { return { status: 'not_called', code: 'ERR_PREFLIGHT_UNKNOWN', requestSent: false }; }
    finally { busy = false; }
  }
  return Object.freeze({ run, stop() { stopped = true; setting.stop(); runtime.stop(); } });
}
module.exports = { createFriendValidation };
