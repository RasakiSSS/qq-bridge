import { readDshWorkspaces } from './dsh-session.js';
import { fail } from './store.js';

const value = response => { if (response?.result?.ok !== true) throw fail('DSH_READ_FAILED'); return response.result.value; };

// Host-owned worker sessions share the main workspace. Creation is journalled
// before the request; a lost response is inspected, never blindly re-created.
export function summaryWorkerAdapter({ store, api, workspaceId, configureModel, readWorkspaces = () => readDshWorkspaces(api) }) {
  const workspace = async (sessionId, required, check) => {
    const baseline = await readWorkspaces(); check();
    if (!Array.isArray(baseline?.items) || !Array.isArray(baseline.archivedSessionIds)
      || baseline.items.some(row => !Array.isArray(row.sessionIds))) throw fail('INVALID_WORKSPACE_BASELINE');
    const targets = baseline.items.filter(row => row.workspaceId === workspaceId);
    const owners = baseline.items.filter(row => row.sessionIds.includes(sessionId));
    if (targets.length !== 1 || baseline.archivedSessionIds.includes(sessionId) || owners.length > 1
      || owners.some(row => row.workspaceId !== workspaceId) || required && owners.length !== 1) throw fail('SESSION_WORKSPACE_MISMATCH');
  };
  return async (job, check) => {
    check();
    const sid = job.worker_session;
    const inspect = async () => {
      const list = value(await api.sessions.list({})); check();
      if (!Array.isArray(list?.items) || list.hasMore === true) throw fail('INVALID_SESSION_LIST');
      const rows = list.items.filter(row => row.sessionId === sid);
      if (rows.length > 1) throw fail('INVALID_SESSION_LIST');
      const projection = value(await api.callUnary('session/projections', { sessionId: sid })); check();
      return { row: rows[0], projection };
    };
    let current = await inspect();
    if (!current.row) {
      if (current.projection !== null) throw fail('UNSAFE_SUMMARY_SESSION');
      await workspace(sid, false, check);
      const claim = store.db.prepare('UPDATE summary_jobs SET create_attempted=1 WHERE id=? AND create_attempted=0').run(job.id);
      if (claim.changes !== 1) throw fail('SUMMARY_CREATION_UNCERTAIN');
      const created = value(await api.sessions.create({ sessionId: sid, workspaceId, agentPreset: 'qq-summary' })); check();
      if (created?.sessionId !== sid) throw fail('SESSION_ID_MISMATCH');
      current = await inspect();
    }
    const validate = ({ row, projection }) => {
      if (!row || row.running || row.parentSessionId || row.origin === 'subagent' || row.formatStatus !== 'current'
        || projection?.kind !== 'sequenced' || !Number.isSafeInteger(projection.asOfSeq) || projection.asOfSeq < -1
        || projection.values?.agentPreset !== 'qq-summary') throw fail('UNSAFE_SUMMARY_SESSION');
      const inbox = projection.values.inbox;
      if (!inbox || !Array.isArray(inbox['next-step']) || !Array.isArray(inbox['next-turn'])
        || inbox['next-step'].length || inbox['next-turn'].length) throw fail('SUMMARY_SESSION_BUSY');
    };
    validate(current); await workspace(sid, true, check);
    if (await configureModel({ account: job.account, sessionId: sid }) !== true) throw fail('MODEL_CONFIGURATION_FAILED');
    check(); validate(await inspect()); await workspace(sid, true, check); check();
  };
}
