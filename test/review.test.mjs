// 复盘算法单测：同龄对比、互动率、涨粉、due 出卡节奏。独立数据库（LIANG_DB 指向临时文件）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'liang-review-'));
process.env.LIANG_DB = join(dir, 'hub.db');
// followers/metrics 的 day 一律北京时间日期（与 lib 采集端 today()/dayOf() 同一约定）
const bjDay = (t) => new Date(t + 8 * 3600e3).toISOString().slice(0, 10);

let mod;
before(async () => {
  mod = await import('../lib/review.js');
  const db = (await import('../lib/db.mjs')).db;
  const now = Date.now();
  const t0 = now - 2 * 86400e3;   // 2 天前发布的一期
  db.prepare('INSERT INTO episodes (id, episode, name, dir, schedule, created_at) VALUES (?,?,?,?,?,?)')
    .run('ep_test_12', 12, 'AI 实战 · 第 12 期｜测试', 'D:/x/12', new Date(t0).toISOString(), new Date(t0).toISOString());
  db.prepare('INSERT INTO tasks (episode_id, platform, state, url, updated_at) VALUES (?,?,?,?,?)')
    .run('ep_test_12', 'bilibili', 'published', 'https://www.bilibili.com/video/BV1xK411C7Y2', new Date(t0).toISOString());
  db.prepare('INSERT INTO tasks (episode_id, platform, state, url, updated_at) VALUES (?,?,?,?,?)')
    .run('ep_test_12', 'xhs', 'published', '', new Date(t0).toISOString());
  // 发布当天：b站播放 1000（采样）；第二天：5000
  db.prepare('INSERT INTO samples (ts, episode_id, platform, views, likes, comments, favorites, shares) VALUES (?,?,?,?,?,?,?,?)')
    .run(new Date(t0 + 3600e3).toISOString().slice(0, 16), 'ep_test_12', 'bilibili', 1000, 100, 20, 30, 5);
  const day2 = bjDay(t0 + 86400e3);
  db.prepare('INSERT INTO metrics (day, episode_id, platform, views, likes, comments, favorites, shares, extra, collected_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(day2, 'ep_test_12', 'bilibili', 5000, 400, 60, 80, 20, '{}', new Date().toISOString());
  // 粉丝：期间涨了 30
  db.prepare('INSERT INTO followers (day, platform, total, gain, loss, source, collected_at) VALUES (?,?,?,?,?,?,?)')
    .run(bjDay(t0), 'bilibili', 1000, null, null, 'daily', new Date().toISOString());
  db.prepare('INSERT INTO followers (day, platform, total, gain, loss, source, collected_at) VALUES (?,?,?,?,?,?,?)')
    .run(bjDay(t0 + 86400e3), 'bilibili', 1030, 30, 0, 'daily', new Date().toISOString());
});

after(async () => {
  // Windows：先关数据库连接再删目录（WAL 文件被占用会 EBUSY）
  try { const { db } = await import('../lib/db.mjs'); db.close(); } catch {}
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* Temp 目录系统会清 */ }
});

test('review：第 1 天复盘有播放/互动率/同龄对比/涨粉', async () => {
  const { review } = mod;
  const eps = (await import('../lib/db.mjs')).episodes();
  const ep = eps.find(e => e.id === 'ep_test_12');
  const { text } = review(ep, 1);
  assert.ok(text.includes('第 12 期'), text);
  assert.ok(text.includes('B站'), text);
  assert.ok(text.includes('5,000'), `应有第二天播放：${text}`);
  assert.ok(text.includes('互动率'), text);
  assert.ok(text.includes('涨粉'), text);
});

test('due：第 1 天的卡只出一次（claim 幂等）', async () => {
  const { due } = mod;
  const claimed = new Set();
  const claim = (k) => { if (claimed.has(k)) return false; claimed.add(k); return true; };
  const first = due(claim);
  const second = due(claim);
  assert.ok(first.length >= 1, '2 天前的期应出第 1 天复盘');
  assert.deepEqual(second, [], '第二次不应再出');
});
