// 高层操作：把引擎/采集器接到数据库和状态机上（原版 hub.mjs 的角色）。
// 全部函数假设已持有 bridge；由 jobs.js 在后台任务里调用。
import fs from 'node:fs';
import path from 'node:path';
import { createBridge, checkEnv, sleep } from './bsk.js';
import { db, NAMES, LOCKED, STATE_CN, upsertEpisode, getTask, getTasks, setTask, log, episodes, getEpisode, saveMetric, prevMetric, saveFollower, saveSnapshot, V1_PLATFORMS } from './db.mjs';
import { loadProject, validateProject } from './project.mjs';
import { runProject, collectLinks, preflight, ORDER } from './engine.js';
import { metricReaders, followerReaders, FOLLOWER_PAGES } from './collectors.js';
import { bodyText } from './adapters/common.js';

const mapState = (s) => s === '待你发布' || s === '已填写' || s === '待你点发布' ? 'filled' : s === '已填好' ? 'filled' : s === '异常' || s === '上传超时' ? 'failed' : s === '未登录' ? 'not_logged_in' : s === '已停止' ? 'stopped' : s === '跳过' ? 'skipped' : s === '已定时' ? 'scheduled' : s === '已发布' ? 'published' : 'running';

// 登记进分发计划（不上传）
export function planDir(dir) {
  const pj = loadProject(dir);
  if (getEpisode(pj.id)) return null;
  upsertEpisode({ id: pj.id, episode: pj.episode, name: pj.name, dir, schedule: pj.schedule || null });
  saveSnapshot(pj.id, pj);
  for (const id of Object.keys(pj.platforms)) setTask(pj.id, id, pj.platforms[id].skip ? 'skipped' : 'planned', pj.platforms[id].skip ? String(pj.platforms[id].skip).slice(0, 80) : '');
  log(pj.id, '', 'plan', dir);
  return pj.name;
}

export function adoptDir(dir) {
  const pj = loadProject(dir);
  upsertEpisode({ id: pj.id, episode: pj.episode, name: pj.name, dir, schedule: pj.schedule || null });
  saveSnapshot(pj.id, pj);
  for (const id of Object.keys(pj.platforms)) if (!getTask(pj.id, id)) setTask(pj.id, id, 'pending', '登记的往期');
  return pj.id;
}

// 开跑（或续跑）一期：校验 → 登记 → 防重（库里已到位的跳过）→ 预检 → 逐平台填写 → 等上传
export async function runEpisode(dir, { only = null, force = false, onState, uploadPollMs } = {}) {
  const v = validateProject(dir);
  if (!v.ok) throw new Error(`校验没通过：\n${v.text.slice(-800)}`);
  const pj = loadProject(dir);
  const ep = { id: pj.id, episode: pj.episode, name: pj.name, dir, schedule: pj.schedule || null };
  upsertEpisode(ep);
  saveSnapshot(ep.id, pj, true);
  const todo = (only || Object.keys(pj.platforms)).filter(id => pj.platforms[id] && !pj.platforms[id].skip);
  const locked = todo.filter(id => LOCKED.includes((getTask(ep.id, id) || {}).state));
  if (locked.length && !force) {
    log(ep.id, '', 'run-skip-locked', locked.join(','));
    return { skippedLocked: locked };
  }
  const todoRun = todo.filter(id => !locked.includes(id));
  for (const id of todoRun) setTask(ep.id, id, 'pending', '');

  const br = createBridge();
  try {
    const env = await checkEnv();
    if (!env.ok) throw new Error(env.hint);
    const states = await runProject(br, {
      absDir: dir,
      project: pj,
      platforms: todoRun,
      shouldStop: () => false,
      uploadPollMs,
      onChange: (st) => {
        const state = mapState(st.status);
        const tail = (st.logs || []).filter(l => l.kind === 'err').slice(-1)[0];
        const detail = state === 'running' ? st.status : (state === 'filled' ? '填好待核对' : (tail ? tail.msg : st.status));
        if (setTask(ep.id, st.id, state, detail)) log(ep.id, st.id, 'state', `${st.status} ${detail}`);
        onState && onState(st);
      },
    });
    log(ep.id, '', 'run-done', Object.values(states).map(s => `${s.id}:${s.status}`).join(' '));
    return { states };
  } finally { await br.close(); }
}

// 取链接、更新状态；写 发布记录.json 回工程目录
export async function syncEpisode(dir, ids = null) {
  const pj = loadProject(dir);
  const ep = getEpisode(pj.id);
  if (!ep) throw new Error('这一期还没登记，先 plan 或 run');
  const want = (ids || Object.keys(pj.platforms)).filter(i => pj.platforms[i] && !pj.platforms[i].skip);
  const br = createBridge();
  try {
    const env = await checkEnv();
    if (!env.ok) throw new Error(env.hint);
    const r = await collectLinks(br, { absDir: dir, project: pj, platforms: want });
    for (const [id, v] of Object.entries(r)) {
      const state = /定时|审核/.test(v.status || '') ? 'scheduled' : v.url || /已发布/.test(v.status || '') ? 'published' : null;
      log(ep.id, id, 'links', JSON.stringify(v));
      if (state) setTask(ep.id, id, state, v.note || v.status, { url: v.url || undefined });
      else if (v.status) setTask(ep.id, id, (getTask(ep.id, id) || {}).state || 'pending', `${v.status}${v.note ? '，' + v.note : ''}`);
    }
    const tasks = getTasks(ep.id);
    try {
      fs.writeFileSync(path.join(dir, '发布记录.json'), JSON.stringify({
        updatedAt: new Date().toISOString(),
        platforms: Object.fromEntries(tasks.map(t => [t.platform, { name: NAMES[t.platform], state: STATE_CN[t.state] || t.state, url: t.url || '', detail: t.detail || '' }])),
      }, null, 2) + '\n');
    } catch { /* 工程目录只读就算了 */ }
    return r;
  } finally { await br.close(); }
}

// 采集一期流量（只采已发布的平台），返回日报文字
const today = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
export async function collectEpisodeMetrics(dir, { skip = [] } = {}) {
  const pj = loadProject(dir);
  const ep = getEpisode(pj.id);
  if (!ep) throw new Error('这一期还没登记');
  const br = createBridge();
  const lines = [];
  let total = 0, totalDelta = 0, any = false;
  try {
    const env = await checkEnv();
    if (!env.ok) throw new Error(env.hint);
    for (const t of getTasks(ep.id)) {
      const fn = metricReaders[t.platform], p = pj.platforms[t.platform];
      const ad = (await import('./engine.js')).ADAPTERS[t.platform];
      if (!fn || !p || t.state !== 'published' || skip.includes(t.platform)) continue;
      let m = null;
      try {
        await br.open(ad.links.url);
        for (let i = 0; i < 12 && !(await br.waitFor(ad.links.ready, 2000).catch(() => false)); i++) await sleep(1500);
        m = await fn(br, p);
      } catch (e) { log(ep.id, t.platform, 'metrics-error', e.message); }
      if (!m) { lines.push(`${NAMES[t.platform]}：没读到`); continue; }
      saveMetric(today(), ep.id, t.platform, m); any = true;
      const prev = prevMetric(ep.id, t.platform, today());
      const d = prev && m.views != null && prev.views != null ? m.views - prev.views : null;
      total += m.views || 0; totalDelta += d || 0;
      const f = (k, v) => v == null ? '' : `｜${k} ${v}`;
      lines.push(`${NAMES[t.platform]}：播放 ${m.views ?? '-'}${d != null ? `（${d >= 0 ? '+' : ''}${d}）` : ''}${f('赞', m.likes)}${f('评', m.comments)}${f('藏', m.favorites)}${f('转', m.shares)}`);
      await sleep(2000);   // 一个一个来，放慢
    }
  } finally { await br.close(); }
  if (!lines.length) return null;
  return `【${ep.episode ? ep.episode + ' 期 ' : ''}${ep.name.split(/[｜|]/)[0]}】全平台播放 ${total}${totalDelta ? `（较上次 +${totalDelta}）` : ''}\n${lines.join('\n')}`;
}

// 采四平台粉丝
export async function collectFollowers() {
  const br = createBridge();
  const out = {};
  try {
    const env = await checkEnv();
    if (!env.ok) throw new Error(env.hint);
    for (const id of V1_PLATFORMS) {
      try {
        await br.open(FOLLOWER_PAGES[id]);
        for (let i = 0; i < 10 && !(await br.waitFor('body', 1500).catch(() => false)); i++) await sleep(1500);
        await sleep(2000);
        const r = await followerReaders[id](br).catch(() => null);
        if (r && r.total != null) { saveFollower(today(), id, r, 'daily'); out[id] = r; }
        else out[id] = { error: '没读到' };
      } catch (e) { out[id] = { error: e.message }; }
    }
  } finally { await br.close(); }
  return out;
}

// 体检：各平台登录态 + 上传页
export async function doctor() {
  const br = createBridge();
  try {
    const env = await checkEnv();
    if (!env.ok) throw new Error(env.hint);
    const r = await preflight(br, V1_PLATFORMS);
    for (const [id, v] of Object.entries(r)) log('', id, 'doctor', v.ok ? 'ok' : v.reason);
    return r;
  } finally { await br.close(); }
}
