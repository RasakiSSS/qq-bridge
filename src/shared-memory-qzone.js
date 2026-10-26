// 空间本地快照是证据来源；发送意图和未知回执绝不伪装成已参与的经历。
export function recordQzoneMemory(memory, accountQQ, data) {
  if (!data || !accountQQ) return;
  const record = (input) => memory.record({ accountQQ, ...input });
  for (const p of [...(data.pendingFeeds || []), ...Object.values(data.knownPosts || {}), ...(data.ownPosts || [])]) {
    const actorQQ = p.authorQQ || accountQQ;
    if (actorQQ === accountQQ && (data.writes || []).some((w) => w.kind === 'post' && w.status === 'sent' && w.tid === p.tid)) continue;
    record({ source: `qzone:${actorQQ}`, actorQQ, name: p.name, externalId: `post:${p.tid || p.key}`,
      text: p.content, time: Number(p.time) * 1000, kind: 'qzonePost', status: 'observed' });
  }
  for (const c of Object.values(data.comments || {})) record({ source: `qzone:${c.ownerQQ}:${c.tid}`,
    actorQQ: c.authorQQ, name: c.name, externalId: `comment:${c.parentId || ''}:${c.commentId}`,
    text: c.content, time: c.time, kind: 'qzoneComment', people: [c.ownerQQ] });
  for (const w of data.writes || []) {
    if (!['sent', 'uncertain'].includes(w.status)) continue;
    const target = w.ownerQQ || accountQQ;
    record({ source: `qzone:${target}${w.kind === 'post' ? '' : ':' + w.tid}`, actorQQ: accountQQ,
      externalId: `write:${w.id}`, text: w.content, time: w.at, kind: 'qzoneAction', status: w.status,
      people: [target, data.comments?.[w.commentKey]?.authorQQ].filter(Boolean) });
  }
}
