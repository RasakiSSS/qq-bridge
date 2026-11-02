import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { accountId, fail } from './store.js';

// Gate a maintenance receiver on a pre-existing private installation barrier.
// No old or new runtime, token repair, model dispatch or state flush is involved.
export function captureAccount({ file, expected, verifyPrivate, excluded }) {
  accountId(expected);
  const parent = path.dirname(file), st = fs.lstatSync(file);
  if (path.relative(parent, fs.realpathSync(parent)) || !st.isFile() || st.isSymbolicLink() || st.nlink !== 1
      || !verifyPrivate(parent) || !verifyPrivate(file) || !excluded(file)) throw fail('MIGRATION_PRIVATE_DIRECTORY_REQUIRED');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    if (db.prepare('PRAGMA application_id').get().application_id !== 0x51514d49 || db.prepare('PRAGMA user_version').get().user_version !== 1) throw fail('MIGRATION_SOURCE_CHANGED');
    const proof = JSON.parse(db.prepare('SELECT identity FROM barrier WHERE id=1').get()?.identity ?? 'null');
    if (proof?.account !== expected || proof.sourceAccount !== expected || !proof.epoch || !proof.provenance) throw fail('MIGRATION_ACCOUNT_UNVERIFIED');
    return expected;
  } finally { db.close(); }
}

export async function startCaptureReceiver({ account, bot, inbox, allowed, relationships, status }) {
  let epoch = 0, online = false, closed = false, healthy = true, hold;
  function observe(state) {
    if (!hold) return;
    try { inbox.observeCapture(account,hold,state); }
    catch { healthy=false; status('capture-failed'); }
  }
  const invalid = () => { online = false; hold = undefined; epoch++; };
  bot.on('open', () => {
    observe('closed'); invalid();
    const seen = epoch; hold = 'login:' + randomUUID(); observe('opened');
    void Promise.resolve().then(() => bot.getLoginInfo()).then(info => {
      if (seen !== epoch || closed) return;
      if (String(info?.user_id) !== account) throw fail('MIGRATION_ACCOUNT_UNVERIFIED');
      inbox.confirmLogin(account, hold); online = true; observe('verified'); status('ready');
    }).catch(() => { if (seen === epoch && !closed) { observe('unverified'); status('unverified'); } });
  });
  bot.on('close', () => { observe('closed'); invalid(); if (!closed) status('disconnected'); });
  bot.on('error', () => { if (!closed) status('connection-error'); });
  function capture(kind, event) {
    if (closed || !hold || String(event?.self_id) !== account) return;
    // Even frames delivered before login confirmation remain in the account-
    // bound raw spool. This receiver never drains them or executes commands.
    try {
      if (kind === 'friend') { if (relationships) inbox.captureFriend(event, online ? undefined : hold); return; }
      if (String(event.user_id) === account || String(event.sender?.user_id) === account) return;
      const peer = kind === 'private' ? event.user_id : event.group_id;
      if (allowed(kind, peer)) inbox.capture(kind + ':' + peer, event, online ? undefined : hold);
    } catch { healthy = false; observe('failed'); status('capture-failed'); }
  }
  bot.onPrivateMessage(e => capture('private',e));
  bot.onGroupMessage(e => capture('group',e));
  bot.onRequest('friend', e => capture('friend',e));
  try { await bot.connect(); } catch { closed = true; bot.close(); throw fail('MIGRATION_RECEIVER_OFFLINE'); }
  return { get generation() { return online ? hold : null; }, get healthy() { return healthy; }, get verified() { return online && !closed; }, close() { closed = true; observe('closed'); invalid(); bot.close(); return inbox.close(); } };
}
