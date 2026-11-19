// 面板数据面：/liang-publish 前缀路由。宿主已做 token 鉴权（不要在这里再加 fail-closed）。
import { createReadStream, existsSync, statSync, readFileSync, realpathSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, NAMES, STATE_CN, episodes, getEpisode, getTasks, recentLogs, getSnapshot, getMeta, setTask, log as dbLog, V1_PLATFORMS, followerOn } from './db.mjs';
import { startJob, jobStatus, recentJobs } from './jobs.js';
import { runEpisode, syncEpisode, collectEpisodeMetrics, collectFollowers, doctor, planDir, adoptDir } from './hubops.js';
import { review, weekly } from './review.js';
import { buildProject } from './project.mjs';

const BASE = '/liang-publish';
const LAB = fileURLToPath(new URL('../lab/', import.meta.url));
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
};

const json = (res, code, v) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(v)); };
const latestMetric = (eid, p) => db.prepare('SELECT * FROM metrics WHERE episode_id=? AND platform=? ORDER BY day DESC LIMIT 1').get(eid, p);

function episodeView(ep, full = false) {
  const snap = getSnapshot(ep.id);
  let pj = null;
  try { pj = snap ? JSON.parse(snap.project) : null; } catch { pj = null; }
  if (!pj) { try { pj = JSON.parse(readFileSync(join(ep.dir, 'publish.json'), 'utf8')); } catch { pj = { platforms: {} }; } }
  let views = 0, inter = 0;
  const tasks = getTasks(ep.id).map(t => {
    const m = latestMetric(ep.id, t.platform);
    if (m) { views += m.views || 0; inter += (m.likes || 0) + (m.comments || 0) + (m.favorites || 0) + (m.shares || 0); }
    const p = (pj.platforms || {})[t.platform] || {};
    return {
      platform: t.platform, name: NAMES[t.platform] || t.platform, state: t.state, stateCn: STATE_CN[t.state] || t.state,
      detail: t.detail || '', url: t.url || '', updatedAt: t.updated_at,
      m: m && { day: m.day, views: m.views, likes: m.likes, comments: m.comments, favorites: m.favorites, shares: m.shares },
      ...(full ? { copy: { title: p.title || p.shortTitle || '', body: p.desc || p.body || '', tags: p.tags || p.topics || [] } } : {}),
    };
  });
  return {
    id: ep.id, name: ep.name, episode: ep.episode, dir: ep.dir, schedule: ep.schedule, created_at: ep.created_at,
    tasks, views, inter,
    ...(full ? { logs: recentLogs(ep.id, 30) } : {}),
  };
}

function overview() {
  const day = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  const fans = {};
  for (const p of V1_PLATFORMS) { const r = followerOn(day, p); if (r) fans[p] = r.total; }
  const recent = [...db.prepare('SELECT day, platform, total, gain, loss FROM followers ORDER BY day DESC LIMIT 40').all()];
  const list = episodes().slice(0, 30);
  return {
    day, fans, followersRecent: recent,
    episodes: list.map(ep => episodeView(ep)),
    job: jobStatus(), jobs: recentJobs(6),
    engineVersion: 'v1 国内四平台（B站/小红书/抖音/视频号）',
  };
}

function serveFile(req, res, file) {
  res.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream', 'content-length': statSync(file).size, 'cache-control': 'no-cache' });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}

function safeUnder(base, rel) {
  if (!base) return null;
  let b; try { b = realpathSync(base); } catch { return null; }
  const f = normalize(join(b, rel));
  if (!f.startsWith(b + sep) || !existsSync(f) || !statSync(f).isFile()) return null;
  return f;
}

function readJson(req, max = 64 * 1024) {
  return new Promise((resolve2, reject) => {
    if (req.method !== 'POST') return reject(Object.assign(new Error('method'), { status: 405 }));
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > max) req.destroy(); else chunks.push(c); });
    req.on('end', () => { try { resolve2(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(Object.assign(e, { status: 400 })); } });
    req.on('error', reject);
  });
}

export function registerApi(ctx, hooks = {}) {
  return ctx.webServer.register({
    kind: 'prefix',
    path: BASE,
    async handler(req, res) {
      try {
        const url = new URL(req.url, 'http://x');
        if (!url.pathname.startsWith(BASE + '/') && url.pathname !== BASE) return json(res, 404, { error: 'not found' });
        const p = decodeURIComponent(url.pathname.slice(BASE.length)) || '/';

        if (p === '/' || p === '/index.html') return serveFile(req, res, join(LAB, 'index.html'));
        if (p === '/api/overview') return json(res, 200, overview());
        if (p.startsWith('/api/')) { /* 下方 API 分支处理 */ }
        // lab 静态资源：/liang-publish/app.js、/style.css 直接映射 lab 目录（面板用相对路径引用）
        if (req.method === 'GET' && !p.startsWith('/api/')) {
          const f = safeUnder(LAB, p.replace(/^\/+/, ''));
          if (f) return serveFile(req, res, f);
        }

        if (p === '/api/overview') return json(res, 200, overview());

        if (p === '/api/episode') {
          const ep = getEpisode(url.searchParams.get('id'));
          return ep ? json(res, 200, episodeView(ep, true)) : json(res, 404, { error: '没有这一期' });
        }

        // 封面 / 成片等本地文件（只许工程目录内的图片）
        if (p === '/api/file') {
          const id = url.searchParams.get('id'), rel = url.searchParams.get('f') || '';
          const ep = getEpisode(id);
          if (!ep || !/\.(png|jpe?g|webp)$/i.test(rel)) return json(res, 404, { error: 'not found' });
          const f = safeUnder(ep.dir, rel);
          return f ? serveFile(req, res, f) : json(res, 404, { error: 'not found' });
        }

        if (p === '/api/job') return json(res, 200, { job: jobStatus(url.searchParams.get('id')), jobs: recentJobs(6) });

        if (p === '/api/action' && req.method === 'POST') {
          const a = await readJson(req);
          const started = dispatch(a, hooks);
          if (started.error) return json(res, 409, started);
          return json(res, 200, { ok: true, ...started });
        }

        if (p === '/api/review') {
          const ep = getEpisode(url.searchParams.get('id'));
          if (!ep) return json(res, 404, { error: '没有这一期' });
          const d = Number(url.searchParams.get('d')) || 1;
          const r = review(ep, d);
          return json(res, 200, { text: r.text });
        }
        if (p === '/api/weekly') return json(res, 200, weekly());

        return json(res, 404, { error: 'not found' });
      } catch (e) { json(res, e.status || 500, { error: e.message }); }
    },
  });
}

function dispatch(a, hooks) {
  const cfg = hooks.config || {};
  const rootPath = a.dir || cfg.rootPath || '';
  const absDir = rootPath ? resolve(rootPath, a.dirRel || '') : a.absDir || '';
  switch (a.type) {
    case 'doctor':
      return startJob('登录体检', async ({ write }) => {
        const r = await doctor();
        const lines = V1_PLATFORMS.map(id => `${NAMES[id]}：${r[id] && r[id].ok ? '✅ 已登录，上传页正常' : `❌ ${r[id] ? r[id].reason : '没有结果'}`}`);
        write(lines.join('\n'));
        return lines;
      });
    case 'run': {
      if (!absDir) return { error: '缺工程目录（dir 或 rootPath+dirRel）' };
      return startJob(`开跑：${a.dirRel || absDir}`, async ({ write }) => {
        const r = await runEpisode(absDir, { only: a.only || null, force: !!a.force, onState: (st) => write(`${st.name}：${st.status}${st.logs.length ? ' · ' + st.logs[st.logs.length - 1].msg : ''}`) });
        write(`跑完：${JSON.stringify(r.states ? Object.fromEntries(Object.values(r.states).map(s => [s.id, s.status])) : r)}`);
        return r;
      });
    }
    case 'sync': {
      const ep = getEpisode(a.id);
      if (!ep) return { error: '没有这一期' };
      return startJob(`取链接：${ep.name}`, async ({ write }) => {
        const r = await syncEpisode(ep.dir, a.only || null);
        write(Object.entries(r).map(([id, v]) => `${NAMES[id]}：${v.status}${v.url ? ' ' + v.url : ''}`).join('\n'));
        return r;
      });
    }
    case 'metrics': {
      const ep = a.id ? getEpisode(a.id) : null;
      if (a.id && !ep) return { error: '没有这一期' };
      return startJob(ep ? `采流量：${ep.name}` : '采流量（近 30 天）', async ({ write }) => {
        const list = ep ? [ep] : episodes().filter(e => Date.now() - Date.parse(e.created_at) < 30 * 86400e3);
        const parts = [];
        for (const e of list) {
          try { const r = await collectEpisodeMetrics(e.dir); if (r) { parts.push(r); write(r); } } catch (e2) { write(`【${e.name}】采集出错：${e2.message}`, 'err'); }
        }
        return parts;
      });
    }
    case 'followers':
      return startJob('采粉丝', async ({ write }) => {
        const r = await collectFollowers();
        write(Object.entries(r).map(([p, v]) => `${NAMES[p]}：${v.total != null ? v.total.toLocaleString('en-US') : v.error}`).join('\n'));
        return r;
      });
    case 'mark': {
      if (!a.id || !a.platform || a.state !== 'published') return { error: 'mark 只支持标「已发布」（平台认不出时用）' };
      setTask(a.id, a.platform, 'published', a.note || '人工标记', { url: a.url || undefined });
      dbLog(a.id, a.platform, 'mark', '人工标记已发布');
      return { ok: true };
    }
    case 'plan': {
      if (!absDir) return { error: '缺工程目录' };
      const name = planDir(absDir);
      return { ok: true, name };
    }
    case 'adopt': {
      if (!absDir) return { error: '缺工程目录' };
      const id = adoptDir(absDir);
      return startJob(`登记往期：${id}`, async ({ write }) => {
        const r = await syncEpisode(absDir);
        write(JSON.stringify(r));
        return r;
      });
    }
    case 'make': {
      if (!a.mdPath || !absDir) return { error: 'make 需要 mdPath + 工程目录' };
      const r = buildProject(a.mdPath, absDir, { requireTag: a.requireTag, schedule: a.schedule });
      return { ok: r.ok, ...r };
    }
    default:
      return { error: `不支持的操作：${a.type}（可选 doctor/run/sync/metrics/followers/mark/plan/adopt/make）` };
  }
}
