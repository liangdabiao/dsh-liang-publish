// 状态落盘：期数、平台任务、操作日志、流量/粉丝。node:sqlite（宿主 Node 24 自带）。
// 移植自 mdldm-maitian src/db.mjs（MIT），去掉知识站/多维表格相关表。
//   $DSH_HOME/liang-publish/hub.db   （测试用 LIANG_DB 环境变量覆盖）
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';

export const DATA_DIR = process.env.LIANG_HOME || path.join(process.env.DSH_HOME || path.join(homedir(), '.dsh'), 'liang-publish');
const DB_PATH = process.env.LIANG_DB || path.join(DATA_DIR, 'hub.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
db.exec(`
CREATE TABLE IF NOT EXISTS episodes (id TEXT PRIMARY KEY, episode INTEGER, name TEXT, dir TEXT, schedule TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS tasks (episode_id TEXT, platform TEXT, state TEXT, detail TEXT, url TEXT, tab_id TEXT, updated_at TEXT, PRIMARY KEY (episode_id, platform));
CREATE TABLE IF NOT EXISTS metrics (day TEXT, episode_id TEXT, platform TEXT, views INTEGER, likes INTEGER, comments INTEGER, favorites INTEGER, shares INTEGER, extra TEXT, collected_at TEXT, PRIMARY KEY (day, episode_id, platform));
CREATE TABLE IF NOT EXISTS samples (ts TEXT, episode_id TEXT, platform TEXT, views INTEGER, likes INTEGER, comments INTEGER, favorites INTEGER, shares INTEGER, PRIMARY KEY (ts, episode_id, platform));
CREATE TABLE IF NOT EXISTS followers (day TEXT, platform TEXT, total INTEGER, gain INTEGER, loss INTEGER, source TEXT, collected_at TEXT, PRIMARY KEY (day, platform));
CREATE TABLE IF NOT EXISTS snapshots (episode_id TEXT PRIMARY KEY, taken_at TEXT, project TEXT);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, episode_id TEXT, platform TEXT, action TEXT, result TEXT);
`);

const now = () => new Date().toISOString();
export const NAMES = { bilibili: 'B站', xhs: '小红书', douyin: '抖音', channels: '视频号', youtube: 'YouTube', x: 'X', instagram: 'Instagram' };
export const V1_PLATFORMS = ['bilibili', 'xhs', 'douyin', 'channels'];
// 已经到位、不允许再跑的状态（防重）
export const LOCKED = ['filled', 'awaiting_user', 'scheduled', 'published'];
export const STATE_CN = { planned: '计划中', pending: '等待', running: '进行中', filled: '已填好', awaiting_user: '待你点发布', scheduled: '已定时', published: '已发布', failed: '异常', not_logged_in: '未登录', stopped: '已停止', skipped: '跳过' };

export function upsertEpisode(e) {
  db.prepare(`INSERT INTO episodes (id, episode, name, dir, schedule, created_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET episode=excluded.episode, name=excluded.name, dir=excluded.dir, schedule=excluded.schedule`).run(e.id, e.episode ?? null, e.name, e.dir, e.schedule ?? null, now());
}
export const getTask = (eid, p) => db.prepare('SELECT * FROM tasks WHERE episode_id=? AND platform=?').get(eid, p);
export const getTasks = (eid) => db.prepare('SELECT * FROM tasks WHERE episode_id=? ORDER BY rowid').all(eid);
export const episodes = () => db.prepare('SELECT * FROM episodes ORDER BY created_at DESC').all();
export const getEpisode = (id) => db.prepare('SELECT * FROM episodes WHERE id=?').get(id);
// 返回 true 表示状态真的变了
export function setTask(eid, p, state, detail = '', extra = {}) {
  const old = getTask(eid, p);
  db.prepare(`INSERT INTO tasks (episode_id, platform, state, detail, url, tab_id, updated_at) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(episode_id, platform) DO UPDATE SET state=excluded.state, detail=excluded.detail, url=COALESCE(excluded.url, tasks.url), tab_id=COALESCE(excluded.tab_id, tasks.tab_id), updated_at=excluded.updated_at`)
    .run(eid, p, state, detail, extra.url ?? null, extra.tabId ?? null, now());
  return !old || old.state !== state || old.detail !== detail;
}
export function log(eid, p, action, result = '') {
  db.prepare('INSERT INTO logs (ts, episode_id, platform, action, result) VALUES (?,?,?,?,?)').run(now(), eid, p || '', action, String(result).slice(0, 2000));
}
export const recentLogs = (eid, n = 40) => db.prepare('SELECT * FROM logs WHERE episode_id=? ORDER BY id DESC LIMIT ?').all(eid, n).reverse();
export const getMeta = (k) => (db.prepare('SELECT value FROM meta WHERE key=?').get(k) || {}).value;
export const setMeta = (k, v) => db.prepare('INSERT INTO meta (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));
export function saveMetric(day, eid, p, m) {
  // 每次采集都留一条带时间的样本，用来画新期头几天的走势
  db.prepare('INSERT OR REPLACE INTO samples (ts, episode_id, platform, views, likes, comments, favorites, shares) VALUES (?,?,?,?,?,?,?,?)').run(new Date().toISOString().slice(0, 16), eid, p, m.views ?? null, m.likes ?? null, m.comments ?? null, m.favorites ?? null, m.shares ?? null);
  db.prepare(`INSERT INTO metrics (day, episode_id, platform, views, likes, comments, favorites, shares, extra, collected_at) VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(day, episode_id, platform) DO UPDATE SET views=excluded.views, likes=excluded.likes, comments=excluded.comments, favorites=excluded.favorites, shares=excluded.shares, extra=excluded.extra, collected_at=excluded.collected_at`)
    .run(day, eid, p, m.views ?? null, m.likes ?? null, m.comments ?? null, m.favorites ?? null, m.shares ?? null, JSON.stringify(m.extra || {}), new Date().toISOString());
}
export const metricsOn = (eid, day) => db.prepare('SELECT * FROM metrics WHERE episode_id=? AND day=?').all(eid, day);
export const prevMetric = (eid, p, day) => db.prepare('SELECT * FROM metrics WHERE episode_id=? AND platform=? AND day<? ORDER BY day DESC LIMIT 1').get(eid, p, day);
export const latestMetric = (eid, p) => db.prepare('SELECT * FROM metrics WHERE episode_id=? AND platform=? ORDER BY day DESC LIMIT 1').get(eid, p);
export function saveFollower(day, p, r, source = '') {
  db.prepare(`INSERT INTO followers (day, platform, total, gain, loss, source, collected_at) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(day, platform) DO UPDATE SET total=excluded.total, gain=excluded.gain, loss=excluded.loss, source=excluded.source, collected_at=excluded.collected_at`)
    .run(day, p, r.total ?? null, r.gain ?? null, r.loss ?? null, source, now());
}
export const followerOn = (day, p) => db.prepare('SELECT * FROM followers WHERE day=? AND platform=?').get(day, p);
export function saveSnapshot(eid, project, overwrite = false) {
  if (!overwrite && db.prepare('SELECT 1 FROM snapshots WHERE episode_id=?').get(eid)) return;
  db.prepare('INSERT OR REPLACE INTO snapshots (episode_id, taken_at, project) VALUES (?,?,?)').run(eid, now(), JSON.stringify(project));
}
export const getSnapshot = (eid) => db.prepare('SELECT * FROM snapshots WHERE episode_id=?').get(eid);
