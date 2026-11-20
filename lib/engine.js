// 发布编排：预检登录 → 逐平台填写（状态回调）→ 等上传完成补封面 → 取链接。
// 移植自 publisher lib/publish.js run()/preflight()/collectLinks()（Apache-2.0），原语换 bsk 桥。
// v1 只做国内四家（bilibili/xhs/douyin/channels）：只填写不提交，最后一下由人点。
import path from 'node:path';
import { createBridge, sleep } from './bsk.js';
import { bodyText, bjTime } from './adapters/common.js';
import { linkReaders } from './collectors.js';

import bilibili from './adapters/bilibili.js';
import xhs from './adapters/xhs.js';
import douyin from './adapters/douyin.js';
import channels from './adapters/channels.js';

export const ADAPTERS = { bilibili, xhs, douyin, channels };
export const ORDER = ['bilibili', 'xhs', 'douyin', 'channels'];

const LOGIN_URL = /login|passport|signin/i;
const abs = (dir, rel) => path.join(dir, ...(rel || '').split('/'));
const p2f = (s) => s.replace(/\\/g, '/');

// 登录预检：逐个打开上传页，判断登录态 + 表单就绪。返回 { id: { ok, reason, session, tab } }
// ——session/tab 供填写阶段复用（同一 tab，不重复开）
export async function preflight(br, ids) {
  const out = {};
  for (const id of ids) {
    const ad = ADAPTERS[id];
    try {
      await br.open(ad.url);
      const session = br.session, tab = br.tab;
      const end = Date.now() + 60000;
      let res = null;
      while (!res && Date.now() < end) {
        await sleep(1500);
        const url = await br.tabUrl().catch(() => '');
        if (LOGIN_URL.test(url)) { res = { ok: false, reason: `${ad.name}没有登录（跳到了登录页）`}; break; }
        const t = await bodyText(br).catch(() => '');
        if (/扫码登录/.test(t) && /验证码登录|密码登录/.test(t)) { res = { ok: false, reason: `${ad.name}没有登录（页面显示扫码登录）` }; break; }
        if (await br.waitFor(ad.ready, 3000)) res = { ok: true };
      }
      out[id] = { ...(res || { ok: false, reason: `${ad.name}上传页 60 秒没打开（可能没登录或网络慢）` }), session, tab };
    } catch (e) {
      out[id] = { ok: false, reason: e.message };
    }
  }
  return out;
}

function makeState(id, onChange) {
  const st = { id, name: ADAPTERS[id].name, status: '等待', logs: [], failed: false };
  const push = (kind, msg) => { st.logs.push({ kind, msg }); onChange && onChange(st); };
  st.log = (m) => push('ok', m);
  st.note = (m) => push('info', m);
  st.fail = (m) => { st.failed = true; push('err', m); };
  st.set = (s) => { st.status = s; onChange && onChange(st); };
  return st;
}

// 跑一次分发。absDir = 工程目录绝对路径；project = publish.json 内容。
// ★ 四平台并行：每平台独立 bsk 会话/tab，同时填写、同时上传（原版麦田同架构）。
//    总耗时 ≈ 最慢的平台（3-5 分钟），而不是串行相加。
// 波动失败自动重试一次（弹窗遮挡/页面跳变类瞬时错误）；重试仍失败才标异常。
export async function runProject({ absDir, project, platforms, onChange, shouldStop, uploadTimeoutH = 4, uploadPollMs = 5000, retryPass = true, autoPublish = false }) {
  const b = project;
  const states = {};
  const brs = {};
  const brOf = (id) => brs[id] || (brs[id] = createBridge());
  const todo = ORDER.filter(id => b.platforms[id] && platforms.includes(id) && !b.platforms[id].skip);
  for (const id of todo) { const st = states[id] = makeState(id, onChange); st.set('检查登录'); }

  // 并行预检：每平台独立会话，open + 登录判定同时进行
  const pre = {};
  await Promise.all(todo.map(async (id) => {
    const ad = ADAPTERS[id], br = brOf(id);
    try {
      await br.open(ad.url);
      const session = br.session, tab = br.tab;
      const end = Date.now() + 60000;
      let res = null;
      while (!res && Date.now() < end) {
        await sleep(1000);
        const url = await br.tabUrl().catch(() => '');
        if (LOGIN_URL.test(url)) { res = { ok: false, reason: `${ad.name}没有登录（跳到了登录页）` }; break; }
        const t = await bodyText(br).catch(() => '');
        if (/扫码登录/.test(t) && /验证码登录|密码登录/.test(t)) { res = { ok: false, reason: `${ad.name}没有登录（页面显示扫码登录）` }; break; }
        if (await br.waitFor(ad.ready, 2500)) res = { ok: true };
      }
      pre[id] = { ...(res || { ok: false, reason: `${ad.name}上传页 60 秒没打开（可能没登录或网络慢）` }), session, tab };
    } catch (e) {
      pre[id] = { ok: false, reason: e.message };
    }
  }));

  // 单平台全生命周期：复用预检会话 → 填写 → 等上传（每轮 sync 刷新 VOM）→ 补封面 → 待你发布
  const runOne = async (id, preEntry) => {
    const p = b.platforms[id];
    const st = states[id];
    const ad = ADAPTERS[id];
    if (p.skip) { st.note(`跳过：${p.skip}`); st.set('跳过'); return; }
    if (!preEntry || !preEntry.ok) {
      st.fail(`${preEntry ? preEntry.reason : '预检没有结果'}，这个平台先跳过；登录后可以单独重填`);
      st.set('未登录');
      return;
    }
    if (shouldStop && shouldStop()) { st.set('已停止'); return; }

    const br = brOf(id);
    const ctx = {
      p,
      video: abs(absDir, p.video || b.video),
      projectId: b.id,
      cover: (k) => ((p.covers || []).includes(k) && b.covers[k]) ? abs(absDir, b.covers[k]) : null,
      log: st.log, note: st.note, fail: st.fail,
      schedule: b.schedule ? bjTime(b.schedule) : null,
      autoPublish,
    };
    try {
      if (preEntry.session) await br.useSession(preEntry.session, preEntry.tab);   // 复用预检 tab，不重复开
      else await br.open(ad.url);
      await sleep(600);
      st.set('填写中');
      await ad.fill(br, ctx);
      st.set(st.failed ? '异常' : '上传中');
      if (!st.failed) {
        // 等视频传完（每轮 sync 刷新 VOM，5s 一轮）；传完补封面
        const deadline = Date.now() + uploadTimeoutH * 3600 * 1000;
        let done = false;
        while (!done && Date.now() < deadline && !(shouldStop && shouldStop())) {
          await br.sync().catch(() => {});
          done = await ad.uploadDone(br).catch((e) => { st.fail(`页面丢失：${e.message}`); return true; });
          if (!done) await sleep(uploadPollMs);
        }
        if (done) {
          st.log('视频上传完成');
          if (ad.afterUpload) {
            try { await ad.afterUpload(br, ctx); }
            catch (e) { st.note(`后台补封面没成功（${e.message.slice(0, 60)}），请手动补封面`); }
          }
          // ★ autoPublish（用户明确授权时）：直接点各平台的发布按钮，不等人工
          if (ctx.autoPublish && typeof ad.submit === 'function') {
            st.set('发布中');
            await sleep(1000);
            let r;
            try { r = await ad.submit(br, ctx); } catch (e) { r = { ok: false, detail: e.message.slice(0, 120) }; }
            if (r && r.ok) {
              st.log(`已自动发布${r.detail ? `（${r.detail}）` : ''}`);
              st.set('已发布');
              await br.activate().catch(() => {});
              return;
            }
            st.note(`自动发布没成：${r ? r.detail : '未知原因'}——页面已填好，请手动点发布`);
            st.set('待你发布');
            await br.activate().catch(() => {});
            return;
          }
          st.set(st.failed ? '异常' : '待你发布');
          // ★ 到「待你发布」立刻把页面亮到前台——简单契约：填完马上交给你，不做任何跨时间承诺
          if (st.status === '待你发布') await br.activate().catch(() => {});
        } else {
          st.set(shouldStop && shouldStop() ? '已停止' : '上传超时');
        }
      }
    } catch (e) {
      st.fail(e.message);
      st.set('异常');
    }
  };

  await Promise.all(todo.map(id => runOne(id, pre[id])));

  // 瞬时失败自动重试一次（预检本来是过的 → 说明登录没问题，是页面波动）
  if (retryPass && !(shouldStop && shouldStop())) {
    const retryIds = todo.filter(id => ['异常', '未登录'].includes(states[id].status) && pre[id] && pre[id].ok);
    if (retryIds.length) {
      for (const id of retryIds) {
        const st = states[id];
        st.failed = false;
        st.logs.push({ kind: 'info', msg: '波动失败，自动重试一次' });
        st.set('检查登录');
        onChange && onChange(st);
      }
      const pre2 = {};
      await Promise.all(retryIds.map(async (id) => {
        const ad = ADAPTERS[id], br = brOf(id);
        try { await br.open(ad.url); } catch (e) { pre2[id] = { ok: false, reason: e.message }; return; }
        pre2[id] = { ok: true, session: br.session, tab: br.tab };
      }));
      await Promise.all(retryIds.map(id => runOne(id, pre2[id])));
    }
  }

  const keptTabs = Object.values(brs).flatMap(br => br.keptTabs || []);
  const sessions = [...new Set(keptTabs.map(t => t.session))];
  return { states, keptTabs, sessions };
}

// 取链接：逐平台打开作品管理页，读状态和链接。返回 { id: { status, url, time, note } }
export async function collectLinks(br, { absDir, project, platforms }) {
  const b = project;
  const out = {};
  for (const id of ORDER) {
    const p = b.platforms[id];
    const ad = ADAPTERS[id];
    const reader = linkReaders[id];
    if (!p || !platforms.includes(id) || p.skip) continue;
    if (!reader || !ad.links) { out[id] = { status: '不支持', url: '' }; continue; }
    try {
      await br.open(ad.links.url);
      let ok = false;
      for (let i = 0; i < 20 && !ok; i++) { await sleep(1500); ok = await br.waitFor(ad.links.ready, 3000).catch(() => false); }
      const url = await br.tabUrl().catch(() => '');
      if (!ok) { out[id] = { status: LOGIN_URL.test(url) ? '未登录' : '页面没打开', url: '' }; continue; }
      let r = null;
      for (let i = 0; i < 3 && !r; i++) { await sleep(2000); r = await reader(br, p).catch((e) => ({ status: '出错', url: '', note: e.message })); }
      out[id] = r || { status: '未找到', url: '', note: '管理页里没找到同标题的作品（可能还没发，或标题改过）' };
    } catch (e) {
      out[id] = { status: '出错', url: '', note: e.message };
    }
  }
  return out;
}
