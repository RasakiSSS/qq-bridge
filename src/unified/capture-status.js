import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {accountId,fail} from './store.js';

// Operator-only aggregate. Never open a missing database or return identifiers,
// flags, message content, tokens or local paths.
export function readCaptureStatus(file,account) {
  accountId(account);
  const stat=fs.lstatSync(file,{throwIfNoEntry:false});
  if (!stat) return {exists:false};
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1) throw fail('UNSAFE_RAW_INBOX');
  const db=new DatabaseSync(file,{readOnly:true});
  try {
    db.exec('PRAGMA query_only=ON; BEGIN');
    if(db.prepare('PRAGMA application_id').get().application_id!==1364349528) throw fail('UNSAFE_RAW_INBOX');
    const rows=db.prepare('SELECT status,COUNT(*) AS n FROM raw WHERE account=? GROUP BY status').all(account);
    const counts={pending:0,done:0,uncertainCommands:0,unverified:0};
    for (const {status,n} of rows) {
      const key=status==='command-started'?'uncertainCommands':status.startsWith('login:')?'unverified':status;
      if (!Object.hasOwn(counts,key)) throw fail('INVALID_RAW_EVENT');
      counts[key]+=n;
    }
    const has=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='capture_windows'").get();
    const windows=has?db.prepare('SELECT opened,verified,failed,closed FROM capture_windows WHERE account=? ORDER BY rowid').all(account):[];
    return {exists:true,counts,windows:windows.length,failedWindows:windows.filter(w=>w.failed!==null).length,
      unknownPriorEnds:windows.slice(0,-1).filter(w=>w.closed===null).length,intervalsBetweenConnections:Math.max(0,windows.length-1),
      lastWindow:windows.at(-1)??null,historyCoverage:'unverified'};
  } finally {db.close();}
}
