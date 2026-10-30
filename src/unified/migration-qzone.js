import { accountId, fail } from './store.js';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value);

// Project only explicit legacy evidence. Retention limits, historical comments
// and reply intentions are not acknowledgments. The original partition remains
// preserved separately, including cursors and uncertain writes.
export function projectLegacyQzone(account, data) {
  accountId(account);
  if (data === null) return [];
  if (!object(data) || !Array.isArray(data.pendingFeeds) || !Array.isArray(data.seenFeeds)
      || !Array.isArray(data.ownPosts) || !Array.isArray(data.writes) || !object(data.comments)
      || (data.knownPosts !== undefined && !object(data.knownPosts))) throw fail('MIGRATION_INVALID_SOURCE');
  const seen = new Set(data.seenFeeds), pending = new Map(), posts = new Map();
  if ([...seen].some(key => typeof key !== 'string' || !key || key.length > 512)) throw fail('MIGRATION_INVALID_SOURCE');
  const add = (row, own = false) => {
    if (!object(row) || !id(row.authorQQ) || typeof row.content !== 'string') throw fail('MIGRATION_INVALID_SOURCE');
    const key = own ? `post:${account}:${row.tid}` : row.key;
    if (own && (row.authorQQ !== account || typeof row.tid !== 'string' || !row.tid)) throw fail('MIGRATION_INVALID_SOURCE');
    if (typeof key !== 'string' || !key.startsWith(`post:${row.authorQQ}:`) || key.length > 512
        || key === `post:${row.authorQQ}:` || (row.tid && key !== `post:${row.authorQQ}:${row.tid}`)) throw fail('MIGRATION_INVALID_SOURCE');
    const payload = { ...row, key, text: row.content, originalUnavailable: true };
    const previous = posts.get(key);
    if (previous && (previous.content !== row.content || previous.authorQQ !== row.authorQQ
        || previous.time !== row.time || previous.tid !== row.tid)) throw fail('MIGRATION_CONFLICT');
    posts.set(key, { ...previous, ...payload });
    return key;
  };
  for (const [key, row] of Object.entries(data.knownPosts || {})) {
    if (row?.key !== key) throw fail('MIGRATION_CONFLICT');
    add(row);
  }
  for (const row of data.pendingFeeds) pending.set(add(row), true);
  for (const row of data.ownPosts) add(row, true);
  const rows = [];
  const append = (sourceId, kind, payload, readState, time) => {
    const at = Number.isSafeInteger(time) && time > 0 ? time : null;
    // Missing original timestamps must not become today's fresh input.
    rows.push({ sourceId, kind, payload, readState, at });
  };
  for (const [key, post] of posts) {
    if (pending.has(key) && seen.has(key) && post.authorQQ !== account) throw fail('MIGRATION_CONFLICT');
    const state = post.authorQQ === account || seen.has(key) ? 'read' : pending.has(key) ? 'unread' : 'unknown';
    append(key, 'qzone-feed', post, state, Number(post.time) * 1000);
  }
  for (const [key, comment] of Object.entries(data.comments)) {
    if (!object(comment) || comment.key !== key || !id(comment.ownerQQ) || !id(comment.authorQQ)
        || typeof comment.tid !== 'string' || !comment.tid || typeof comment.commentId !== 'string' || !comment.commentId
        || typeof comment.parentId !== 'string' || typeof comment.content !== 'string' || key.length > 512
        || key !== JSON.stringify([comment.ownerQQ, comment.tid, comment.parentId, comment.commentId])
        || !['new', 'read', 'replied', 'historical'].includes(comment.status)) throw fail('MIGRATION_INVALID_SOURCE');
    const replies = data.writes.filter(w => w.kind === 'reply' && w.commentKey === key);
    const confirmed = replies.some(w => w.status === 'sent' && w.ownerQQ === comment.ownerQQ && w.tid === comment.tid);
    const eligible = comment.ownerQQ === account || comment.mentioned === true
      || data.writes.some(w => w.kind === 'comment' && w.status === 'sent' && w.ownerQQ === comment.ownerQQ && w.tid === comment.tid);
    const state = comment.status === 'read' || (comment.status === 'replied' && confirmed) ? 'read'
      : comment.status === 'new' && eligible ? 'unread' : 'unknown';
    append(key, 'qzone-comment', { ...comment, text: comment.content, originalUnavailable: true }, state, Number(comment.time));
  }
  if (new Set(rows.map(row => row.sourceId)).size !== rows.length) throw fail('MIGRATION_CONFLICT');
  return rows.sort((a, b) => a.sourceId.localeCompare(b.sourceId));
}
