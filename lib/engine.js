// 发布编排：预检登录 → 逐平台填写（状态回调）→ 等上传完成补封面 → 取链接。
// 移植自 publisher lib/publish.js run()/preflight()/collectLinks()（Apache-2.0），原语换 bsk 桥。
// v1 只做国内四家（bilibili/xhs/douyin/channels）：只填写不提交，最后一下由人点。
import path from 'node:path';
import { sleep } from './bsk.js';
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

// 登录预检：逐个打开上传页，判断登录态 + 表单就绪。返回 { id: { ok, reason } }
export async function preflight(br, ids) {
  const out = {};
  for (const id of ids) {
    const ad = ADAPTERS[id];
    try {
      await br.open(ad.url);
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
      out[id] = res || { ok: false, reason: `${ad.name}上传页 60 秒没打开（可能没登录或网络慢）` };
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
// v1 串行：一个平台跑完整个生命周期（填写 → 等上传 → 补封面）再下一家 —— bsk 是单浏览器会话，
// 原版麦田的「全部填完并发等上传」需要多标签并行，留到 v2 校准后再开。
export async function runProject(br, { absDir, project, platforms, onChange, shouldStop, uploadTimeoutH = 4, uploadPollMs = 20000 }) {
  const b = project;
  const states = {};
  const todo = ORDER.filter(id => b.platforms[id] && platforms.includes(id) && !b.platforms[id].skip);
  for (const id of todo) { const st = states[id] = makeState(id, onChange); st.set('检查登录'); }
  const pre = await preflight(br, todo);

  for (const id of ORDER) {
    const p = b.platforms[id];
    if (!p || !platforms.includes(id)) continue;
    const st = states[id] || (states[id] = makeState(id, onChange));
    if (p.skip) { st.note(`跳过：${p.skip}`); st.set('跳过'); continue; }
    if (!pre[id] || !pre[id].ok) {
      st.fail(`${pre[id] ? pre[id].reason : '预检没有结果'}，这个平台先跳过；登录后可以单独重填`);
      st.set('未登录');
      continue;
    }
    if (shouldStop && shouldStop()) { st.set('已停止'); continue; }

    const ad = ADAPTERS[id];
    const ctx = {
      p,
      video: abs(absDir, p.video || b.video),
      projectId: b.id,
      cover: (k) => ((p.covers || []).includes(k) && b.covers[k]) ? abs(absDir, b.covers[k]) : null,
      log: st.log, note: st.note, fail: st.fail,
      schedule: b.schedule ? bjTime(b.schedule) : null,
    };
    try {
      await br.open(ad.url);      // 单页会话：填写前重新认领这个平台的页面
      await sleep(1000);
      st.set('填写中');
      await ad.fill(br, ctx);
      st.set(st.failed ? '异常' : '上传中');
      if (!st.failed) {
        // 等视频传完；传完补封面（小红书、视频号）
        const deadline = Date.now() + uploadTimeoutH * 3600 * 1000;
        let done = false;
        while (!done && Date.now() < deadline && !(shouldStop && shouldStop())) {
          done = await ad.uploadDone(br).catch((e) => { st.fail(`页面丢失：${e.message}`); return true; });
          if (!done) await sleep(uploadPollMs);
        }
        if (done) {
          st.log('视频上传完成');
          if (ad.afterUpload) {
            try { await ad.afterUpload(br, ctx); }
            catch (e) { st.note(`后台补封面没成功（${e.message}），请手动补封面`); }
          }
          st.set(st.failed ? '异常' : '待你发布');
        } else {
          st.set(shouldStop && shouldStop() ? '已停止' : '上传超时');
        }
      }
    } catch (e) {
      st.fail(e.message);
      st.set('异常');
    }
  }
  return states;
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
