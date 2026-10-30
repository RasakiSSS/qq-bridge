// QQ 空间：账号隔离、持久化去重、发送前预记账。所有 QQ/模型调用均可注入测试。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { beijingParts } from './model-prices.js';

export const QZONE_DEFAULTS = Object.freeze({
  enabled: false, browseFriends: true, watchQQ: [], pollIntervalMs: 1800000,
  dailyPostLimit: 3, minPostIntervalMs: 10800000, visibility: 'friends',
  readComments: true, autoReplyComments: true, ownPostsLimit: 20, eventPollIntervalMs: 60000,
});
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const id = (value) => /^\d+$/.test(String(value ?? '')) && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? String(Number(value)) : '';
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const bounded = (v, fallback, min, max) => Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Math.floor(Number(v)))) : fallback;
export function qzoneConfig(raw = {}) {
  return {
    ...QZONE_DEFAULTS, enabled: raw.enabled === true,
    browseFriends: raw.browseFriends !== false,
    watchQQ: [...new Set((Array.isArray(raw.watchQQ) ? raw.watchQQ : []).map(id).filter(Boolean))],
    pollIntervalMs: bounded(raw.pollIntervalMs, 1800000, 60000, 86400000),
    dailyPostLimit: bounded(raw.dailyPostLimit, 3, 0, 100),
    minPostIntervalMs: bounded(raw.minPostIntervalMs, 10800000, 0, 86400000),
    visibility: ['friends', 'public', 'self'].includes(raw.visibility) ? raw.visibility : 'friends',
    readComments: raw.readComments !== false, autoReplyComments: raw.autoReplyComments !== false,
    ownPostsLimit: bounded(raw.ownPostsLimit, 20, 1, 100),
    eventPollIntervalMs: bounded(raw.eventPollIntervalMs, 60000, 30000, 1800000),
  };
}
export function qzoneText(value, max = 1600) {
  return String(value ?? '').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<[^>]*>/g, ' ').replace(/&(?:nbsp|amp|lt|gt|quot|#39);/g,
      (s) => ({ '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" })[s])
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);
}
export function parseQzoneDecision(text) {
  const source = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const value = JSON.parse(source);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !(value.post === null || typeof value.post === 'string' || typeof value.post?.content === 'string') || !Array.isArray(value.replies)) {
    throw fail('空间决策格式无效，需要 {post: string|null, replies: []}');
  }
  if (value.replies.some((r) => !r || typeof r.commentKey !== 'string' || typeof r.content !== 'string')) throw fail('评论决策格式无效');
  value.comments ??= [];
  if (!Array.isArray(value.comments) || value.comments.some((r) => !r || typeof r.postKey !== 'string' || typeof r.content !== 'string')) throw fail('主动评论格式无效');
  return value;
}

export function qzoneMentions(value) {
  const text = String(value ?? '');
  const out = [...text.matchAll(/@\{uin:(\d+),nick:[^}]*\}/g)].map((m) => m[1]);
  for (const m of text.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    if (!/^@/.test(qzoneText(m[2]))) continue;
    const qq = /(?:nameCard_|data-uin=["']?|qzone\.qq\.com\/|[?&]uin=)(\d+)/i.exec(m[1])?.[1];
    if (qq) out.push(qq);
  }
  return [...new Set(out.map(id).filter(Boolean))];
}

export function createQzoneService({ file, getConfig, request, assertAllowed, audit, decide, observeMemory = () => {}, remember = () => {}, now = Date.now, log = () => {} }) {
  let state = { version: 1, accounts: {} };
  let readOnly = false;
  try {
    if (fs.existsSync(file)) {
      state = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (state.version !== 1 || !state.accounts || typeof state.accounts !== 'object' || Array.isArray(state.accounts)) throw Error('状态格式错误');
      for (const a of Object.values(state.accounts)) {
        if (!Array.isArray(a.writes) || !Array.isArray(a.ownPosts) || !Array.isArray(a.pendingFeeds)
          || !Array.isArray(a.seenFeeds) || !a.comments || typeof a.comments !== 'object' || !Number.isFinite(a.startedAt)) throw Error('账号状态格式错误');
        for (const w of a.writes) if (w.status === 'pending') w.status = 'uncertain';
      }
    }
  } catch { readOnly = true; log('[qzone] 空间状态读取失败，已停止空间任务并保留原文件'); }
  let chain = Promise.resolve();
  let maintenance = false;
  let polling = false;
  let retryAt = 0;
  let activeAccount = '';
  const cfg = () => qzoneConfig(getConfig());
  let enabledSince = cfg().enabled ? now() : null;
  function enabled() {
    if (!cfg().enabled) { enabledSince = null; return false; }
    enabledSince ??= now();
    return true;
  }
  function save() {
    if (readOnly) throw fail('空间状态不可写，请检查 state/qzone.json 后重启桥接', 503);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temp = file + '.tmp';
      fs.writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
      fs.renameSync(temp, file);
    } catch (error) { readOnly = true; throw fail('空间状态保存失败，已停止发送以防重复', 503); }
    // 记忆失败不能把已经成功的发送变为 uncertain 或触发补发。
    try { observeMemory(activeAccount, state.accounts[activeAccount]); } catch { log('[qzone] 本轮记忆记录未完成，空间发送状态保留'); }
  }
  function check(context, action) {
    if (maintenance && action === 'model') throw fail('空间处于迁移维护中', 503);
    if (readOnly) throw fail('空间状态读取或保存失败，已停止任务', 503);
    if (!enabled()) throw fail('QQ 空间功能已关闭', 403);
    assertAllowed(context, action);
  }
  function serial(fn) {
    const run = chain.then(() => {
      if (maintenance) throw fail('空间处于迁移维护中', 503);
      return fn();
    });
    chain = run.catch(() => {});
    return run;
  }
  async function call(action, params, context, purpose = 'read', onDispatch = () => {}) {
    check(context, purpose);
    let timer;
    try {
      onDispatch();
      const result = await Promise.race([request(action, params), new Promise((_, reject) => {
        timer = setTimeout(() => reject(fail('空间接口超时', 504)), 20000); timer.unref?.();
      })]);
      if (!result || result.status !== 'ok' || result.retcode !== 0) {
        // 不返回网关原始错误，避免回显令牌、网址或未经清洗的远端内容。
        throw fail(`空间接口 ${action} 失败（retcode=${Number(result?.retcode) || 'unknown'}）`, 502);
      }
      return result.data;
    } finally { clearTimeout(timer); }
  }
  async function account(context) {
    const login = await call('get_login_info', {}, context);
    check(context, 'read');
    const qq = id(login?.user_id);
    if (!qq) throw fail('无法确认当前 QQ 账号', 502);
    if (context?.accountQQ != null && qq !== String(context.accountQQ)) throw fail('QQ 账号已切换，本次空间操作已取消', 409);
    activeAccount = qq;
    if (!state.accounts[qq]) {
      state.accounts[qq] = { startedAt: enabledSince ?? now(), nextPollAt: 0, nextEventAt: 0, ownPosts: [], seenFeeds: [], pendingFeeds: [], comments: {}, writes: [], commentCursors: {}, knownPosts: {} };
      save();
    }
    const data = state.accounts[qq];
    data.commentCursors ??= {};
    data.knownPosts ??= {};
    // Upgrade existing pending self feeds without acknowledging their comments.
    const ownPending = data.pendingFeeds.filter((f) => f.authorQQ === qq);
    if (ownPending.length) { markOwnFeeds(qq, data, ownPending.map((f) => f.key)); save(); }
    return { qq, data };
  }
  async function confirmAccount(qq, context, action) {
    const login = await call('get_login_info', {}, context);
    if (id(login?.user_id) !== qq) throw fail('QQ 账号已切换，本次空间操作已取消', 409);
    check(context, action);
  }
  function postBudget(a) {
    const c = cfg();
    const used = a.writes.filter((w) => w.kind === 'post' && w.status !== 'not-sent');
    const today = used.filter((w) => beijingParts(w.at).date === beijingParts(now()).date).length;
    const last = Math.max(0, ...used.map((w) => w.at));
    const uncertain = used.some((w) => ['pending', 'uncertain'].includes(w.status));
    const remainingMs = last ? Math.max(0, c.minPostIntervalMs - (now() - last)) : 0;
    return { allowed: !uncertain && today < c.dailyPostLimit && remainingMs === 0,
      today, limit: c.dailyPostLimit, remainingMs, uncertain, visibility: c.visibility };
  }
  function snapshot(qq, a) {
    return { accountQQ: qq, budget: postBudget(a), nextPollAt: a.nextPollAt,
      commentSupport: a.commentSupport ?? 'unknown', lastError: a.lastError || '',
      pendingFeeds: [...a.pendingFeeds].sort((x, y) => Number(y.mentioned) - Number(x.mentioned)).slice(0, 20),
      comments: Object.values(a.comments).filter((c) => c.status === 'new' && (c.ownerQQ === qq || c.mentioned
        || a.writes.some((w) => w.kind === 'comment' && w.tid === c.tid && w.ownerQQ === c.ownerQQ && w.status === 'sent'))).slice(0, 50),
      ownPosts: a.ownPosts, recentWrites: a.writes.slice(-20) };
  }
  function markOwnFeeds(qq, a, keys) {
    a.seenFeeds = [...new Set([...a.seenFeeds, ...keys])].slice(-5000);
    a.pendingFeeds = a.pendingFeeds.filter((f) => f.authorQQ !== qq);
  }
  function addFeeds(qq, a, rows) {
    const seen = new Set([...a.seenFeeds, ...a.pendingFeeds.map((f) => f.key)]);
    for (const row of rows) {
      if (row.key && row.authorQQ === qq) { markOwnFeeds(qq, a, [row.key]); continue; }
      if (!row.key || seen.has(row.key)) continue;
      seen.add(row.key); a.pendingFeeds.push(row);
      if (row.tid && row.authorQQ) a.knownPosts[row.key] = row;
    }
    // 有界缓存；历史原文仍留在空间。避免长期无人值守时无限积累。
    a.pendingFeeds = a.pendingFeeds.slice(-200);
    a.knownPosts = Object.fromEntries(Object.entries(a.knownPosts).slice(-200));
  }
  function ingestComments(qq, a, post, comments) {
    for (const parent of comments) {
      for (const [r, parentId] of [[parent, ''], ...(Array.isArray(parent.replies) ? parent.replies : []).map((r) => [r, String(parent.comment_id)])]) {
        const cid = String(r.comment_id ?? '');
        const author = id(r.uin);
        if (!cid || !author || author === qq) continue;
        const key = JSON.stringify([post.authorQQ || qq, post.tid, parentId, cid]);
        if (a.comments[key]) continue;
        const time = Number(r.time) * 1000;
        a.comments[key] = { key, tid: post.tid, commentId: cid, parentId, authorQQ: author,
          ownerQQ: post.authorQQ || qq, mentioned: qzoneMentions(r.content).includes(qq),
          name: qzoneText(r.name, 60), content: qzoneText(r.content), time,
          postContent: post.content, status: Number.isFinite(time) && time >= a.startedAt - 1000 ? 'new' : 'historical' };
      }
    }
  }
  function reconcile(a, post, comments = []) {
    for (const w of a.writes.filter((w) => ['pending', 'uncertain'].includes(w.status))) {
      if (w.kind === 'post' && post.content === w.content && post.time * 1000 >= w.at - 60000) {
        w.status = 'sent'; w.tid = post.tid;
      }
      if (['reply', 'comment'].includes(w.kind) && w.tid === post.tid && (w.ownerQQ || activeAccount) === post.authorQQ) {
        const found = comments.flatMap((c) => [c, ...(c.replies || [])]).find((c) =>
          id(c.uin) === activeAccount && String(c.content ?? '').trim() === w.content && Number(c.time) * 1000 >= w.at - 60000);
        if (found) { w.status = 'sent'; w.receiptId = String(found.comment_id || ''); }
      }
    }
  }
  async function browse(qq, a, context) {
    const c = cfg();
    if (c.browseFriends) {
      const data = await call('get_qzone_feeds', { page_num: 1, count: 20 }, context);
      if (!Array.isArray(data?.feeds)) throw fail('好友动态返回格式无效', 502);
      addFeeds(qq, a, data.feeds.filter((f) => f.key && id(f.uin)).map((f) => ({ key: `post:${id(f.uin)}:${f.key}`, authorQQ: id(f.uin),
        tid: Number(f.appid) === 311 ? String(f.key) : null,
        name: qzoneText(f.nickname, 60), time: Number(f.time), content: qzoneText(f.html),
        mentioned: qzoneMentions(f.html).includes(qq) && Number(f.time) * 1000 >= a.startedAt - 1000 })));
    }
    for (const target of c.watchQQ) {
      const data = await call('get_qzone_msg_list', { target_uin: Number(target), pos: 0, num: 10 }, context);
      if (!Array.isArray(data?.msglist)) throw fail('指定 QQ 动态返回格式无效', 502);
      addFeeds(qq, a, data.msglist.filter((p) => p.tid).map((p) => ({ key: `post:${target}:${p.tid}`, authorQQ: target, tid: String(p.tid),
        time: Number(p.time), content: qzoneText(p.content),
        mentioned: qzoneMentions(p.content).includes(qq) && Number(p.time) * 1000 >= a.startedAt - 1000 })));
    }
    const own = await call('get_qzone_msg_list', { target_uin: Number(qq), pos: 0, num: c.ownPostsLimit }, context);
    if (!Array.isArray(own?.msglist)) throw fail('自己的动态返回格式无效', 502);
    a.ownPosts = own.msglist.filter((p) => typeof p.tid === 'string' && p.tid).map((p) => ({
      tid: p.tid, authorQQ: qq, content: String(p.content ?? '').trim().slice(0, 4000), time: Number(p.time), commentCount: Number(p.comment_num) || 0,
    }));
    markOwnFeeds(qq, a, a.ownPosts.map((p) => `post:${qq}:${p.tid}`));
    const known = Object.values(a.knownPosts).filter((p) => p.authorQQ !== qq && p.tid);
    const recentKeys = new Set(known.slice(-20).map((p) => p.key));
    const followed = known.filter((p) => recentKeys.has(p.key) || p.mentioned || a.writes.some((w) => w.kind === 'comment' && w.postKey === p.key));
    for (const post of [...a.ownPosts, ...followed]) {
      if (post.authorQQ === qq) reconcile(a, post);
      if (!c.readComments || post.commentCount === 0) continue;
      try {
        // 分页游标持久化；每次最多读取五页，下一次接着读。不是回复次数限制。
        const cursorKey = `${post.authorQQ}:${post.tid}`;
        let pos = a.commentCursors[cursorKey] || 0;
        for (let page = 0; page < 5; page++) {
          const detail = await call('get_qzone_msg_detail', { tid: post.tid, target_uin: Number(post.authorQQ), pos, num: 100 }, context);
          if (!Array.isArray(detail?.comments) || String(detail.tid) !== post.tid) throw fail('评论接口返回格式无效', 502);
          a.commentSupport = 'available';
          a.lastError = ''; a.commentErrorNoted = '';
          ingestComments(qq, a, post, detail.comments);
          reconcile(a, post, detail.comments);
          pos += detail.comments.length;
          if (!detail.comments.length || pos >= Number(detail.comment_num)) { pos = 0; break; }
        }
        a.commentCursors[cursorKey] = pos;
      } catch (error) {
        check(context, 'read');
        a.commentSupport = 'unavailable';
        a.lastError = '读取评论失败：请确认 SnowLuma 支持 get_qzone_msg_detail 且账号可访问自己的空间';
        if (a.commentErrorNoted !== a.lastError) { log('[qzone] ' + a.lastError); a.commentErrorNoted = a.lastError; }
        break; // 接口不可用时不重复轰炸每条说说；浏览/发表仍可继续。
      }
    }
    check(context, 'read');
    save();
    return snapshot(qq, a);
  }
  function contentText(value) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 2000) throw fail('空间正文必须是 1–2000 字符的文字');
    const text = value.trim(); audit(text); return text;
  }
  function withMentions(a, value, mentions = []) {
    const text = contentText(value);
    if (/@\{uin:/.test(text)) throw fail('@ 请使用 mentions QQ 数组，不能手写协议标记');
    if (!Array.isArray(mentions) || mentions.some((v) => !id(v))) throw fail('mentions 必须是 QQ 号数组');
    const people = new Map([...Object.values(a.knownPosts).map((p) => [p.authorQQ, p.name || p.authorQQ]),
      ...Object.values(a.comments).map((c) => [c.authorQQ, c.name || c.authorQQ])]);
    for (const qq of cfg().watchQQ) if (!people.has(qq)) people.set(qq, qq);
    const prefix = [...new Set(mentions.map(id))].map((qq) => {
      if (!people.has(qq)) throw fail('只能 @ 已读取空间内容中的用户或配置的关注 QQ');
      const nick = qzoneText(people.get(qq), 60).replace(/[,{}\r\n]/g, '');
      return `@{uin:${qq},nick:${nick || qq},who:1}`;
    }).join(' ');
    return contentText(prefix ? `${prefix} ${text}` : text);
  }
  async function publish(qq, a, value, context, mentions = []) {
    const content = withMentions(a, value, mentions);
    const hash = digest(content);
    const previous = a.writes.find((w) => w.kind === 'post' && w.hash === hash && w.status !== 'not-sent');
    if (previous) return { ok: previous.status === 'sent', duplicate: true, ...previous };
    if (!postBudget(a).allowed) throw fail('发说说额度、间隔或待核对记录不允许本次发布', 429);
    await confirmAccount(qq, context, 'publish');
    if (!postBudget(a).allowed) throw fail('发说说额度或间隔已变化', 429);
    const entry = { id: crypto.randomUUID(), kind: 'post', at: now(), content, hash, status: 'pending' };
    a.writes.push(entry); save(); // 先持久化，再触达远端。
    let dispatched = false;
    try {
      const data = await call('send_qzone_msg', { content, ugc_right: { public: 1, friends: 4, self: 64 }[cfg().visibility] }, context, 'publish', () => { dispatched = true; });
      if (!data || !String(data.tid ?? '')) throw fail('发布回执缺少 tid，需核对自己的空间', 502);
      entry.status = 'sent'; entry.tid = String(data.tid);
      markOwnFeeds(qq, a, [`post:${qq}:${entry.tid}`]);
      save(); log('[qzone] 已发布一条说说');
      return { ok: true, ...entry };
    } catch (error) {
      if (!dispatched) { entry.status = 'not-sent'; save(); throw error; }
      entry.status = 'uncertain'; save();
      throw fail('发布结果未确认，已保留记录；自动核对前不会再次发布，请用空间状态查看', 502);
    }
  }
  async function reply(qq, a, commentKey, value, context, mentions = []) {
    if (!cfg().autoReplyComments) throw fail('评论回复已关闭', 403);
    const comment = a.comments[commentKey];
    if (!comment) throw fail('只能回复已读取的评论', 404);
    const previous = a.writes.find((w) => w.kind === 'reply' && w.commentKey === commentKey && w.status !== 'not-sent');
    if (previous) return { ok: previous.status === 'sent', duplicate: true, ...previous };
    if (comment.status !== 'new') throw fail('该评论已处理或属于启用前的历史评论', 409);
    const content = withMentions(a, `回复 ${comment.name || comment.authorQQ}：${contentText(value)}`, mentions);
    await confirmAccount(qq, context, 'reply');
    const entry = { id: crypto.randomUUID(), kind: 'reply', commentKey, tid: comment.tid, ownerQQ: comment.ownerQQ, at: now(), content, status: 'pending' };
    a.writes.push(entry); comment.status = 'replied'; save();
    let dispatched = false;
    try {
      const data = await call('comment_qzone', { tid: comment.tid, content, target_uin: Number(comment.ownerQQ) }, context, 'reply', () => { dispatched = true; });
      // SnowLuma 的评论 ID 是 best-effort；明确成功的 OneBot 回执足以确认。
      entry.status = 'sent'; entry.receiptId = String(data?.comment_id ?? '');
      save(); log('[qzone] 已回应一条空间评论');
      return { ok: true, ...entry };
    } catch (error) {
      if (!dispatched) { entry.status = 'not-sent'; comment.status = 'new'; save(); throw error; }
      entry.status = 'uncertain'; save();
      throw fail('评论发送结果未确认，已记录且不会自动重复回复', 502);
    }
  }
  async function comment(qq, a, postKey, value, context, mentions = []) {
    const post = a.knownPosts[postKey];
    if (!post?.tid || !id(post.authorQQ)) throw fail('只能评论已读取的说说', 404);
    const previous = a.writes.find((w) => w.kind === 'comment' && w.postKey === postKey && w.status !== 'not-sent');
    if (previous) return { ok: previous.status === 'sent', duplicate: true, ...previous };
    const content = withMentions(a, value, mentions);
    await confirmAccount(qq, context, 'comment');
    const entry = { id: crypto.randomUUID(), kind: 'comment', postKey, tid: post.tid, ownerQQ: post.authorQQ, at: now(), content, status: 'pending' };
    a.writes.push(entry); save();
    let dispatched = false;
    try {
      const data = await call('comment_qzone', { tid: post.tid, content, target_uin: Number(post.authorQQ) }, context, 'comment', () => { dispatched = true; });
      entry.status = 'sent'; entry.receiptId = String(data?.comment_id || ''); save();
      log('[qzone] 已评论一条好友说说'); return { ok: true, ...entry };
    } catch (error) {
      if (!dispatched) { entry.status = 'not-sent'; save(); throw error; }
      entry.status = 'uncertain'; save(); throw fail('评论结果未确认，已记录且不会自动重发', 502);
    }
  }
  async function run() {
    if (maintenance || !enabled() || polling || now() < retryAt || readOnly) return;
    try { check(null, 'read'); } catch { return; }
    polling = true;
    try {
      await serial(async () => {
        const { qq, data: a } = await account(null);
        if (now() < (a.nextEventAt || 0)) return;
        a.nextEventAt = now() + cfg().eventPollIntervalMs; save();
        const input = await browse(qq, a, null);
        await confirmAccount(qq, null, 'model');
        if (!cfg().autoReplyComments) input.comments = [];
        const eventWake = input.pendingFeeds.some((f) => f.mentioned) || input.comments.length > 0;
        if (now() < a.nextPollAt && !eventWake) return;
        a.nextPollAt = now() + cfg().pollIntervalMs; save();
        input.wakeReason = eventWake ? '新评论或空间 @' : '定时刷空间';
        if (!input.pendingFeeds.length && !input.comments.length && !input.budget.allowed) return;
        check(null, 'model');
        const decision = parseQzoneDecision(await decide(input));
        check(null, 'model');
        const offered = new Set(input.comments.map((c) => c.key));
        const offeredPosts = new Set(input.pendingFeeds.map((p) => p.key));
        // 先审核整批目标和正文，再产生任何远端副作用。
        for (const r of decision.replies) {
          if (!offered.has(r.commentKey)) throw fail('模型尝试回复未提供的评论');
          withMentions(a, r.content, r.mentions);
        }
        for (const r of decision.comments) {
          if (!offeredPosts.has(r.postKey) || !a.knownPosts[r.postKey]?.tid) throw fail('模型尝试评论未提供的说说');
          withMentions(a, r.content, r.mentions);
        }
        if (decision.post) withMentions(a, typeof decision.post === 'string' ? decision.post : decision.post.content, decision.post.mentions);
        for (const r of decision.replies) {
          await reply(qq, a, r.commentKey, r.content, null, r.mentions);
        }
        for (const r of decision.comments) {
          await comment(qq, a, r.postKey, r.content, null, r.mentions);
        }
        if (decision.post && input.budget.allowed) await publish(qq, a, typeof decision.post === 'string' ? decision.post : decision.post.content, null, decision.post.mentions);
        check(null, 'read');
        for (const key of offered) if (a.comments[key]?.status === 'new') a.comments[key].status = 'read';
        const consumed = new Set(input.pendingFeeds.map((f) => f.key));
        a.seenFeeds = [...new Set([...a.seenFeeds, ...consumed])].slice(-5000);
        a.pendingFeeds = a.pendingFeeds.filter((f) => !consumed.has(f.key));
        a.lastPollAt = now(); save();
        try { remember(qq, decision.memory); } catch { log('[qzone] 记忆候选无效，未写入'); }
      });
    } catch (error) {
      retryAt = now() + 60000;
      log('[qzone] 本轮空间任务未完成：' + (error.statusCode ? error.message : '模型或连接暂不可用'));
    } finally { polling = false; }
  }
  // Unified mode uses collection only. This path never calls decide, performs
  // writes to QQ, marks comments read, or advances the autonomous model timer.
  // Delivery must persist before resolving; retries offer the same source keys.
  async function collect(context, deliver, { force = false } = {}) {
    if (typeof deliver !== 'function') throw fail('空间事件投递器未配置');
    if (maintenance || !enabled() || polling || now() < retryAt || readOnly) return { status: 'idle' };
    check(context, 'read'); polling = true;
    try {
      return await serial(async () => {
        const { qq, data: a } = await account(context);
        if (!force && now() < (a.nextEventAt || 0)) return { status: 'idle' };
        await browse(qq, a, context);
        await confirmAccount(qq, context, 'read');
        let delivered = 0;
        const eventTime = value => Number.isSafeInteger(value) && value > 0 ? value : now();
        for (const feed of a.pendingFeeds) {
          check(context, 'read');
          if (feed.authorQQ === qq) continue;
          await deliver({ accountQQ: qq, sourceId: feed.key, kind: 'qzone-feed',
            payload: { ...feed, text: feed.content }, at: eventTime(Number(feed.time) * 1000), wake: feed.mentioned === true });
          delivered++;
        }
        for (const comment of Object.values(a.comments)) {
          if (comment.status !== 'new' || !(comment.ownerQQ === qq || comment.mentioned
            || a.writes.some(w => w.kind === 'comment' && w.tid === comment.tid && w.ownerQQ === comment.ownerQQ && w.status === 'sent'))) continue;
          check(context, 'read');
          await deliver({ accountQQ: qq, sourceId: comment.key, kind: 'qzone-comment',
            payload: { ...comment, text: comment.content }, at: eventTime(Number(comment.time)),
            wake: comment.mentioned === true || cfg().autoReplyComments });
          delivered++;
        }
        check(context, 'read');
        a.nextEventAt = now() + cfg().eventPollIntervalMs; save();
        return { status: 'collected', events: delivered };
      });
    } catch (error) {
      retryAt = now() + 60000;
      throw error;
    } finally { polling = false; }
  }
  return {
    // Host-only: not routed through QQ tools or the console. Releasing the
    // lease does not resume operations; activation/rollback must decide that.
    async quiesceForMigration({ assertExclusive } = {}) {
      const check = () => {
        if (typeof assertExclusive !== 'function' || assertExclusive() !== true) throw fail('空间维护独占状态不可验证', 503);
        if (readOnly) throw fail('空间状态不可用于迁移保存', 503);
      };
      check(); maintenance = true;
      await chain;
      check();
      let released = false;
      const assert = () => { check(); if (released || !maintenance) throw fail('空间维护租约不可用', 503); return true; };
      return {
        assert,
        flush() {
          assert();
          // Do not call save(): it also records memory, which belongs to a
          // separately drained source. This flush has no network/model work.
          const content = JSON.stringify(state, null, 2);
          const temp = `${file}.${crypto.randomUUID()}.migration.tmp`;
          try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            const fd = fs.openSync(temp, 'wx', 0o600);
            try { fs.writeFileSync(fd, content, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
            assert(); fs.renameSync(temp, file);
            if (fs.readFileSync(file, 'utf8') !== content) throw fail('空间维护写后核验失败', 503);
            assert(); return true;
          } catch (error) {
            try { fs.unlinkSync(temp); } catch {}
            throw error;
          }
        },
        release() { released = true; },
      };
    },
    run,
    collect,
    status: (context) => serial(async () => { const { qq, data } = await account(context); return snapshot(qq, data); }),
    browse: (context) => serial(async () => { const { qq, data } = await account(context); return browse(qq, data, context); }),
    publish: (text, context, mentions) => serial(async () => { const { qq, data } = await account(context); return publish(qq, data, text, context, mentions); }),
    reply: (key, text, context, mentions) => serial(async () => { const { qq, data } = await account(context); return reply(qq, data, key, text, context, mentions); }),
    comment: (key, text, context, mentions) => serial(async () => { const { qq, data } = await account(context); return comment(qq, data, key, text, context, mentions); }),
    resolve: (writeId, sent, context) => serial(async () => {
      if (!context?.operator) throw fail('仅控制台可以人工核对发送结果', 403);
      const { data } = await account(context);
      const w = data.writes.find((w) => w.id === writeId && w.status === 'uncertain');
      if (!w) throw fail('找不到待核对记录', 404);
      w.status = sent ? 'sent' : 'not-sent';
      if (!sent && w.commentKey && data.comments[w.commentKey]) data.comments[w.commentKey].status = 'new';
      save(); return { ok: true, id: w.id, status: w.status };
    }),
  };
}
