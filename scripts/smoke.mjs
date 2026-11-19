// 离线全流程冒烟（BSK_MODE=mock，不碰真实浏览器/网络）：
//   建工程 → make 校验 → plan → run（四平台 mock 页面填写）→ 标发布 → sync 取链接 →
//   metrics 采流量 → followers 采粉丝 → review 复盘 → overview API。
//   LIANG_HOME=<临时目录> node scripts/smoke.mjs
process.env.BSK_MODE = 'mock';
process.env.LIANG_HOME = process.env.LIANG_HOME || mkdtemp();
process.env.LIANG_DB = process.env.LIANG_DB || join(process.env.LIANG_HOME, 'hub.db');

import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function mkdtemp() { return mkdtempSync(join(tmpdir(), 'liang-smoke-')); }
const here = dirname(fileURLToPath(import.meta.url));

// —— 先注册 mock 页面（必须在 import engine/hubops 之前？不需要，注册表是全局的，用前就位即可）
const { registerMockPages } = await import(pathToFileURL(join(here, '../lib/bsk.js')).href);
const { bilibiliPage, xhsPage, douyinPage, channelsPage, managePage, followerPage, SCHED } = await import(pathToFileURL(join(here, '../test/mocks.mjs')).href);
const adaptersMod = await import(pathToFileURL(join(here, '../lib/engine.js')).href);
const { ADAPTERS } = adaptersMod;
const pad = (n) => String(n).padStart(2, '0');

const TITLE = '梁工冒烟：Agent 自动整理资料';
const BODY_XHS = '这周把资料整理全交给 Agent。\n踩坑两个。';
const BODY_DY = '资料乱成一锅粥？交给 Agent。';
const BODY_CH = '这期演示 Agent 整理资料的全过程。\n更多细节看置顶。';

registerMockPages({
  [ADAPTERS.bilibili.url]: bilibiliPage,
  [ADAPTERS.xhs.url]: xhsPage,
  [ADAPTERS.douyin.url]: douyinPage,
  [ADAPTERS.channels.url]: channelsPage,
  [ADAPTERS.bilibili.links.url]: () => managePage('bilibili', { title: TITLE, bvid: '1xK411C7Y2' }),
  [ADAPTERS.xhs.links.url]: () => managePage('xhs', { title: 'Agent 整理资料真的绝了', noteId: 'a1b2c3d4e5f6a7b8c9d0e1f2' }),
  [ADAPTERS.douyin.links.url]: () => managePage('douyin', { title: '一条指令整理全部资料', awemeId: '7412589630123456789' }),
  [ADAPTERS.channels.links.url]: () => managePage('channels', { title: BODY_CH.split('\n')[0].slice(0, 30) }),
  'https://member.bilibili.com/platform/home': () => followerPage('bilibili', 54321),
  'https://creator.douyin.com/creator-micro/home': () => followerPage('douyin', 12034),
  'https://creator.xiaohongshu.com/statistics/fans-data': () => followerPage('xhs', 8765),
  'https://channels.weixin.qq.com/platform/statistic/follower': () => followerPage('channels', 4211),
});

const hub = await import(pathToFileURL(join(here, '../lib/hubops.js')).href);
const dbm = await import(pathToFileURL(join(here, '../lib/db.mjs')).href);
const projectMod = await import(pathToFileURL(join(here, '../lib/project.mjs')).href);
const reviewMod = await import(pathToFileURL(join(here, '../lib/review.js')).href);

const MD = `# AI 实战 · 第 1 期｜${TITLE}

> 序号：1
> 定时发布：${SCHED.y}-${pad(SCHED.m)}-${pad(SCHED.d)} ${pad(SCHED.hh)}:${pad(SCHED.mm)}

## 二、B站
**标题：**
${TITLE}
**简介：**
冒烟测试简介：演示 Agent 整理资料的全过程，含两个踩坑。
**标签：**
#梁工学AI #Agent

## 三、小红书
**标题：**
Agent 整理资料真的绝了
**正文：**
${BODY_XHS}
#梁工学AI #Agent

## 四、抖音
**标题：**
一条指令整理全部资料
**正文：**
${BODY_DY}
#梁工学AI #Agent

## 五、视频号
**短标题：**
Agent 整理资料真香
**描述：**
${BODY_CH}
#梁工学AI #Agent
`;

// faststart 的最小 mp4 头（moov 在前）
const box = (type, payload) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + payload.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, payload]);
};

const root = mkdtemp();
const dir = join(root, 'AI实战', '第1期');
mkdirSync(join(dir, '封面'), { recursive: true });
writeFileSync(join(dir, '成片.mp4'), Buffer.concat([box('moov', Buffer.alloc(16)), box('mdat', Buffer.alloc(64))]));
writeFileSync(join(dir, '封面', 'cover-3x4.png'), 'x');
writeFileSync(join(dir, '封面', 'cover-4x3.png'), 'x');
writeFileSync(join(dir, '发布素材.md'), MD);

const step = (name, ok, extra = '') => {
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) { console.error(`冒烟在「${name}」失败`); process.exit(1); }
};

// ① make
const made = projectMod.buildProject(join(dir, '发布素材.md'), dir, { requireTag: '梁工学AI' });
step('make 生成 publish.json 并通过校验', made.ok === true, made.text.split('\n').slice(-1)[0]);

// ② plan
const name = hub.planDir(dir);
step('plan 进分发计划', !!name && name.includes(TITLE), `期名=${name}`);
const ep0 = dbm.getEpisode(made.project.id);
step('计划里四平台都是「计划中」', dbm.getTasks(ep0.id).every(t => t.state === 'planned'));

// ③ run（mock 串行四平台）
const run = await hub.runEpisode(dir, { uploadPollMs: 30 });
const states = run.states ? Object.values(run.states) : [];
step('run 跑完四平台', states.length === 4, states.map(s => `${s.id}:${s.status}`).join(' '));
const filled = states.every(s => s.status === '待你发布' && !s.failed);
step('四平台全部「待你发布」（填写+读回校验通过）', filled, states.filter(s => s.failed).map(s => `${s.id}:${s.logs.filter(l => l.kind === 'err').map(l => l.msg).join(';')}`).join(' | '));

// ④ 用户点发布 → 标记已发布（国内平台人工点完后用 mark/sync）
for (const id of ['bilibili', 'xhs', 'douyin', 'channels']) dbm.setTask(ep0.id, id, 'published', '冒烟：人工标记');

// ⑤ sync 取链接
const links = await hub.syncEpisode(dir);
const withUrl = ['bilibili', 'xhs', 'douyin'].every(id => links[id] && links[id].url);
step('sync 取回三平台链接（视频号无链接）', withUrl, JSON.stringify(links).slice(0, 220));
step('发布记录.json 已写回工程目录', existsSync(join(dir, '发布记录.json')));

// ⑥ metrics 采流量
const report = await hub.collectEpisodeMetrics(dir);
step('metrics 采到四平台流量', !!report && report.includes('全平台播放'), (report || '').split('\n')[0]);

// ⑦ followers 采粉丝
const fans = await hub.collectFollowers();
const fanOk = ['bilibili', 'xhs', 'douyin', 'channels'].every(id => fans[id] && fans[id].total > 0);
step('followers 采到四平台粉丝', fanOk, Object.entries(fans).map(([p, v]) => `${p}:${v.total ?? v.error}`).join(' '));

// ⑧ review 复盘
const ep = dbm.getEpisode(ep0.id);
const r = reviewMod.review(ep, 1);
step('review 出第 1 天复盘', r.text.includes('B站') && r.text.includes('播放'), r.text.split('\n')[0]);

// ⑨ 面板 overview
const apiMod = await import(pathToFileURL(join(here, '../lib/api.js')).href);
let overviewPayload = null;
const fakeCtx = { webServer: { register: (r) => { r.handler({ url: 'http://x/liang-publish/api/overview', method: 'GET' }, { writeHead: () => {}, end: (b) => { overviewPayload = JSON.parse(b); } }); } } };
apiMod.registerApi(fakeCtx, { config: {} });
step('overview API：期数/粉丝/任务齐全', overviewPayload && overviewPayload.episodes.length === 1 && overviewPayload.episodes[0].tasks.length === 4 && Object.keys(overviewPayload.fans).length === 4);

console.log(`\n🎉 冒烟全绿（数据目录 ${process.env.LIANG_HOME}，工程 ${root}）`);
try { dbm.db.close(); } catch {}
for (const d of [root, process.env.LIANG_HOME]) {
  try { rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 }); }
  catch { /* Windows 偶发 EBUSY（WAL 句柄释放滞后），Temp 目录系统会清 */ }
}
process.exit(0);
