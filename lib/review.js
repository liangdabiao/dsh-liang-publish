// 复盘：单期发布后第 N 天对比 + 周报。只用梁工自己攒的数据（采样、每日流量、粉丝）。
// 移植自 mdldm-maitian src/review.mjs（MIT），去掉知识站转化部分。
import { db, episodes, getTasks, NAMES } from './db.mjs';

const PL = ['bilibili', 'douyin', 'xhs', 'channels'];
const DAY = 864e5;
const fmt = (n) => n == null ? '–' : Math.round(n).toLocaleString('en-US');
const pct = (a, b, d = 1) => b ? (a / b * 100).toFixed(d) + '%' : '–';
const bj = (t) => new Date(t + 8 * 3600e3).toISOString();           // 北京时间的 ISO 串
const dayOf = (t) => bj(t).slice(0, 10);
const pubAt = (ep) => Date.parse(ep.schedule || ep.created_at);
const short = (n) => (n || '').split(/[｜|]/)[0].trim();

// 某期某平台在时间 t 时的数据：优先用加密采样，没有就用每日流量里不晚于那天的最后一条
function at(eid, p, t) {
  const s = db.prepare('SELECT * FROM samples WHERE episode_id=? AND platform=? AND ts<=? ORDER BY ts DESC LIMIT 1').get(eid, p, new Date(t).toISOString().slice(0, 16));
  const m = db.prepare('SELECT * FROM metrics WHERE episode_id=? AND platform=? AND day<=? ORDER BY day DESC LIMIT 1').get(eid, p, dayOf(t));
  const r = s && (!m || s.ts.slice(0, 10) >= m.day) ? s : m;
  return r ? { views: r.views || 0, likes: r.likes || 0, comments: r.comments || 0, favorites: r.favorites || 0, shares: r.shares || 0 } : null;
}
const inter = (m) => m ? m.likes + m.comments + m.favorites + m.shares : 0;
// 有没有这一期在这个年龄附近的真实数据（接入前的期没有，不能硬比）
const hasDataBy = (eid, t) => !!db.prepare('SELECT 1 FROM metrics WHERE episode_id=? AND day<=? LIMIT 1').get(eid, p2(t));

function snapshot(ep, ageDays) {
  const t = Math.min(Date.now(), pubAt(ep) + ageDays * DAY);
  const rows = PL.map(p => ({ p, m: at(ep.id, p, t) })).filter(r => r.m && r.m.views != null);
  return { ageDays, t, rows, views: rows.reduce((s, r) => s + r.m.views, 0), inter: rows.reduce((s, r) => s + inter(r.m), 0) };
}
function p2(t) { return dayOf(t); }

// 涨粉：期间 [a, b) 的净涨（各平台粉丝表里有记录才算）
function fansBetween(a, b) {
  const rows = db.prepare('SELECT platform, day, total FROM followers WHERE day >= ? AND day < ? ORDER BY day').all(dayOf(a), dayOf(b));
  const per = {};
  for (const r of rows) {
    const cur = per[r.platform] || (per[r.platform] = {});
    per[r.platform][r.day] = r.total;
  }
  let out = null;
  const days = Object.keys(per);
  if (!days.length) return null;
  for (const [p, m] of Object.entries(per)) {
    const ds = Object.keys(m).sort();
    const delta = (m[ds[ds.length - 1]] || 0) - (m[ds[0]] || 0);
    if (delta) (out = out || {})[p] = delta;
  }
  return out;
}

export function review(ep, ageDays = 1) {
  const cur = snapshot(ep, ageDays), prev = snapshot(ep, ageDays - 1);
  const tasks = getTasks(ep.id);
  const prevEp = episodes().filter(e => pubAt(e) < pubAt(ep)).sort((a, b) => pubAt(b) - pubAt(a))[0];
  const peer = prevEp && hasDataBy(prevEp.id, pubAt(prevEp) + ageDays * DAY) ? snapshot(prevEp, ageDays) : null;
  // 涨粉窗口：发布当天 ~ 第 N 天（含第 N 天当天，右端再让一天让日期比较收进去）
  const fans = fansBetween(pubAt(ep), pubAt(ep) + (ageDays + 1) * DAY);

  const lines = [];
  lines.push(`【${ep.episode ? ep.episode + ' 期 ' : ''}${short(ep.name)}】发布第 ${ageDays} 天复盘`);
  if (!cur.rows.length) { lines.push('还没有可用的流量数据（要等采集过至少一次）'); return { text: lines.join('\n'), data: cur }; }

  for (const r of cur.rows) {
    const t = tasks.find(x => x.platform === r.p);
    const pm = peer ? peer.rows.find(x => x.p === r.p) : null;
    const bits = [`播放 ${fmt(r.m.views)}`, `互动 ${fmt(inter(r.m))}（互动率 ${pct(inter(r.m), r.m.views)}）`];
    if (pm) bits.push(`上期同龄 ${fmt(pm.m.views)}（${r.m.views >= pm.m.views ? '+' : ''}${fmt(r.m.views - pm.m.views)}）`);
    lines.push(`${NAMES[r.p]}：${bits.join('，')}${t && t.url ? `\n  ${t.url}` : ''}`);
  }
  lines.push(`全平台播放 ${fmt(cur.views)}，互动 ${fmt(cur.inter)}${peer ? `（上期同龄 ${fmt(peer.views)}）` : ''}`);
  if (fans) lines.push(`期间涨粉：${Object.entries(fans).map(([p, d]) => `${NAMES[p]} ${d >= 0 ? '+' : ''}${d}`).join('，')}`);
  lines.push(`（数据截至 ${bj(cur.t).slice(0, 16).replace('T', ' ')} 北京时间）`);
  return { text: lines.join('\n'), data: cur };
}

export function weekly() {
  const now = Date.now();
  const end = now - ((new Date(now).getUTCHours() + 8) >= 24 ? 0 : DAY);   // 粗略对齐周一
  const start = end - 7 * DAY;
  const eps = episodes().filter(e => Date.now() - Date.parse(e.created_at) < 60 * DAY);
  const lines = [];
  lines.push(`【梁工周报】${dayOf(start)} ~ ${dayOf(end)}`);
  let any = false;
  for (const ep of eps) {
    const s = snapshot(ep, Math.max(1, Math.round((end - pubAt(ep)) / DAY)));
    if (!s.rows.length) continue;
    any = true;
    lines.push(`${ep.episode ? ep.episode + ' 期 ' : ''}${short(ep.name)}：本周末播放 ${fmt(s.views)}，互动 ${fmt(s.inter)}`);
  }
  if (!any) lines.push('最近 60 天没有可复盘的期数。');
  const fans = fansBetween(start, end);
  if (fans) lines.push(`本周涨粉：${Object.entries(fans).map(([p, d]) => `${NAMES[p]} ${d >= 0 ? '+' : ''}${d}`).join('，')}`);
  return { text: lines.join('\n') };
}

// 到点的复盘提醒：第 1/3/7 天各发一次（由 dsh 定时任务在采集后调用，due() 决定今天该出哪些卡）
export function due(claim) {
  const out = [];
  for (const ep of episodes()) {
    const pub = pubAt(ep);
    if (!(Date.now() > pub + DAY * 0.5)) continue;
    for (const d of [1, 3, 7]) {
      const key = `review:${ep.id}:${d}`;
      if (Date.now() > pub + d * DAY - 6 * 3600e3 && Date.now() < pub + d * DAY + 3 * 86400e3) {
        if (claim(key)) out.push(review(ep, d).text);
      }
    }
  }
  return out;
}
