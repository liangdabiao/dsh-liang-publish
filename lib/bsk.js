// browser-skill（bsk）桥：dsh 插件 → 本机浏览器 的唯一通道。
//
// 设计约束（2026-11 定稿）：
//   - Chrome 136+ 禁止对默认 profile 开 CDP 调试端口 → 原版麦田「专用 Chrome + chrome-shim」路线不可行，
//     bsk 的扩展通道是唯一能控制「用户已登录的本机 Chrome」的方式。
//   - bsk 没有任意 JS evaluate → 四平台适配器全部按「点按钮/填文字/传文件/读页面」原语重写，
//     本模块提供这些原语；每个 op 一个实现函数，所有 bsk CLI 细节（参数名、输出解析）都收在这里，
//     真机校准只改本文件，不动适配器。
//   - 双后端：BSK_MODE=mock 走页面状态机模拟（scripts/smoke、test 用），默认 spawn bsk CLI。
//
// target 规范（适配器里统一用）：
//   'css选择器'            —— 主文档唯一匹配（wait-for-element/step 原生支持）
//   { sel: 'css' }         —— 同上，对象形式
//   { text: '完成' }        —— 按可见文本定位（snapshot 里找 ref；mock 里按按钮文本匹配）
//   { ref: '@e5' }         —— 上一次观察返回的引用（shadow DOM 内容必须走 ref）
import { spawn } from 'node:child_process';
import path from 'node:path';

export const sleep = (ms) => new Promise(r => setTimeout(r, MOCK() ? Math.min(ms, 5) : ms));   // mock 下快进
const BSK = process.env.BSK_BIN || 'bsk';
const MOCK = () => process.env.BSK_MODE === 'mock';

// ---------------------------------------------------------------------------
// real 后端：spawn bsk CLI
// ---------------------------------------------------------------------------
function exec(args, { timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const ch = spawn(BSK, args, { env: { ...process.env, BSK_AUTO_START: '0' }, windowsHide: true });
    let out = '', err = '', dead = false;
    const timer = setTimeout(() => { dead = true; ch.kill(); reject(new Error(`bsk ${args[0]} 超时（${timeout}ms）`)); }, timeout);
    ch.stdout.on('data', d => { out += d; });
    ch.stderr.on('data', d => { err += d; });
    ch.on('error', e => { clearTimeout(timer); reject(new Error(`bsk 跑不起来：${e.message}（先在独立终端跑一次 bsk daemon start，或设 BSK_BIN 指到 bsk.exe）`)); });
    ch.on('close', code => {
      if (dead) return;
      clearTimeout(timer);
      resolve({ code, stdout: out, stderr: err });
    });
  });
}

function parseJson(stdout) {
  // bsk 输出里可能混有人读的状态行；取第一个 { 到最后一个 } 之间的 JSON
  const i = stdout.indexOf('{'), j = stdout.lastIndexOf('}');
  if (i < 0 || j <= i) return null;
  try { return JSON.parse(stdout.slice(i, j + 1)); } catch { return null; }
}

export async function checkEnv() {
  if (MOCK()) return { daemon: true, browsers: ['mock-browser'], ok: true, hint: '' };
  // 环境体检：daemon 在不在、有没有已连接的浏览器
  const s = await exec(['status', '--json'], { timeout: 15000 }).catch(e => ({ code: 1, stdout: '', stderr: e.message }));
  const j = parseJson(s.stdout) || {};
  const browsers = j.browsers || j.connected || [];
  return {
    daemon: s.code === 0,
    browsers,
    ok: s.code === 0 && browsers.length > 0,
    hint: s.code === 0
      ? (browsers.length ? '' : 'bsk 守护在跑，但浏览器还没连上：打开本机 Chrome，确认 BrowserSkill 扩展已装并点过连接。')
      : 'bsk 守护没在跑：在独立终端跑 `bsk daemon start --foreground`（建议设成开机任务），或参考 browser-skill 技能的说明。',
    raw: j,
  };
}

class RealBridge {
  constructor({ scope = 'liang-publish' } = {}) {
    this.scope = scope;
    this.session = null;   // bsk session id（open 返回）
    this.tab = null;       // 当前受控 tab id
  }
  static common() { return []; }

  async open(url) {
    const r = await exec(['open', url, '--scope', this.scope, '--no-focus', '--json'], { timeout: 45000 });
    const j = parseJson(r.stdout) || {};
    if (r.code !== 0 && !j.session) throw new Error(`bsk open 失败：${(j.error || r.stderr || r.stdout || '').slice(0, 300)}`);
    this.session = this.session || j.session || j.session_id || j.sessionId || null;
    this.tab = j.tab_id || j.tabId || this.tab;
    return { session: this.session, tab: this.tab, vom: j };
  }
  async tabUrl() {
    // session 状态里有当前地址；拿不到就返回空（登录检测退化为 ready 判断）
    const r = await exec(['view', '--json'], { timeout: 15000 }).catch(() => ({ stdout: '{}' }));
    const j = parseJson(r.stdout) || {};
    return j.url || j.tab?.url || '';
  }
  argvTail(target, extra = []) {
    const t = ['--session', this.session, ...extra];
    if (this.tab != null) t.push('--tab-id', String(this.tab));
    return t;
  }
  async waitFor(target, timeoutMs = 20000) {
    const sel = typeof target === 'string' ? target : target.sel;
    if (sel) {
      const r = await exec(['wait-for-element', sel, '--timeout-ms', String(timeoutMs), ...this.argvTail()], { timeout: timeoutMs + 15000 });
      return r.code === 0;
    }
    // ref/文本目标：轮询 snapshot
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) { if (await this.find(target)) return true; await sleep(800); }
    return false;
  }
  async find(target) {
    return (await this.findAll(target))[0] || null;
  }
  // 按可见文本在 snapshot 里找全部匹配 ref（保持页面顺序）。
  // {text, exact} 行文本严格等于（日历/时间列的数字项）；{text, after} 要求出现在锚文本之后
  async findAll(target) {
    const r = await exec(['snapshot', '--json', ...this.argvTail()], { timeout: 30000 });
    const j = parseJson(r.stdout);
    const lines = (j?.snapshot || j?.aria || r.stdout || '').split('\n');
    const want = String(target.text ?? target.ref ?? '');
    const hit = (line) => {
      if (!line.includes(want)) return false;
      if (target.exact) {
        // aria 行如  - listitem "20" [ref=@e12]：取引号内文本全等
        const texts = [...line.matchAll(/"([^"]*)"/g)].map(m => m[1]);
        return texts.some(t => t === want);
      }
      return true;
    };
    const out = [];
    let afterOk = !target.after;
    for (const line of lines) {
      if (target.after && line.includes(target.after)) { afterOk = true; continue; }
      const m = line.match(/@e\d+/);
      if (m && afterOk && hit(line)) out.push(m[0]);
    }
    return out;
  }
  // 第 n 个匹配（1 起）；日历/时间列等多实例场景用
  async findNth(target, n = 1) {
    const refs = await this.findAll(target);
    return refs[n - 1] || null;
  }
  // 逐个点击全部匹配（删标签这类「点掉若干个」的场景）；返回点掉的个数
  async clickAll(target, { max = 12 } = {}) {
    let n = 0;
    for (let i = 0; i < max; i++) {
      const ref = await this.findNth(target, 1);
      if (!ref) break;
      if (!await this.click({ ref })) break;
      n++;
      await sleep(250);
    }
    return n;
  }
  async refOf(target) {
    if (typeof target === 'string') return { selector: target };
    if (target.ref) return { ref: target.ref };
    if (target.sel) return { selector: target.sel };
    const ref = await this.find(target);
    if (!ref) throw new Error(`页面上找不到「${target.text}」`);
    return { ref };
  }
  async step(action, target, params = {}) {
    const t = await this.refOf(target);
    const payload = { ...params, ...t };
    const r = await exec(['step', '--action', action, '--params', JSON.stringify(payload), '--json', ...this.argvTail()], { timeout: 60000 });
    const j = parseJson(r.stdout) || {};
    if (r.code !== 0) throw new Error(`bsk step ${action} 失败：${(j.error || r.stderr || r.stdout || '').slice(0, 300)}`);
    if (j.effect_state === 'unknown') throw new Error(`bsk step ${action} 结果未知（effect_state=unknown），先 sync 观察再决定，不要盲重试`);
    // 动作后同步一次引用（页面可能重排）
    await exec(['sync', '--json', ...this.argvTail()], { timeout: 30000 }).catch(() => {});
    return j;
  }
  async fill(target, value, { append = false } = {}) {
    return this.step('fill', target, { value, ...(append ? { mode: 'append' } : {}) });
  }
  async press(key, target) { return this.step('press', target, { key }); }
  async click(target) {
    try { await this.step('click', target); return true; }
    catch (e) { if (/找不到/.test(e.message)) return false; throw e; }
  }
  async hover(target) { return this.step('hover', target); }
  async select(target, value) { return this.step('select', target, { value }); }
  async upload(target, file) {
    const t = await this.refOf(target);
    const args = ['upload', t.ref || t.selector, '--file', path.resolve(file), '--json', ...this.argvTail()];
    const r = await exec(args, { timeout: 120000 });
    const j = parseJson(r.stdout) || {};
    if (r.code !== 0) throw new Error(`bsk upload 失败：${(j.error || r.stderr || r.stdout || '').slice(0, 300)}`);
    if (j.reason === 'file_input_not_activated') throw new Error('上传框没有被激活（file_input_not_activated）：重新观察页面找上传按钮');
    return j;
  }
  async html(target) {
    const t = await this.refOf(target).catch(() => ({}));
    const args = ['get-html', t.ref || t.selector || 'body', '--json', ...this.argvTail()];
    const r = await exec(args, { timeout: 30000 });
    const j = parseJson(r.stdout);
    return j?.html || j?.content || r.stdout || '';
  }
  async text(target) {
    // 用 read 拿语义文本；失败退化 get-html 剥标签
    const t = await this.refOf(target).catch(() => ({}));
    const r = await exec(['read', t.ref || t.selector || 'body', '--json', ...this.argvTail()], { timeout: 30000 }).catch(() => ({ stdout: '' }));
    const j = parseJson(r.stdout);
    const v = j?.text || j?.value || j?.fields?.text;
    if (v != null) return String(v);
    const h = await this.html(target).catch(() => '');
    return h.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  async inputValue(target) {
    const t = await this.refOf(target);
    const r = await exec(['read', t.ref || t.selector, '--json', ...this.argvTail()], { timeout: 30000 });
    const j = parseJson(r.stdout) || {};
    return j?.fields?.value ?? j?.value ?? '';
  }
  async closeTab() { /* Agent Window 的 tab 由 session close 统一归还 */ }
  async close() { if (this.session) { await exec(['close', '--session', this.session], { timeout: 30000 }).catch(() => {}); this.session = null; } }
}

// ---------------------------------------------------------------------------
// mock 后端：页面状态机。页面定义见 test/mocks/；适配器离线跑通全靠它。
// 页面经 registerMockPages() 注册到全局（hubops.createBridge() 不带参也能拿到）。
// ---------------------------------------------------------------------------
export const mockRegistry = { pages: {}, log: [] };
export function registerMockPages(pages) { Object.assign(mockRegistry.pages, pages); }

class MockBridge {
  constructor({ pages, log } = {}) {
    this.pages = pages || mockRegistry.pages;   // url 前缀 → page 定义
    this.opsLog = log || mockRegistry.log;      // 测试断言用：[{op, target, value}]
    this.scope = 'mock';
    this.session = 'mock';
    this.tab = 'mock';
    this.page = null;
    this._refs = new Map();  // ref 令牌 → 元素（模拟真机 snapshot 的 @eN）
    this._refSeq = 0;
  }
  refOfEl(el) {
    if (!el._mockRef) { el._mockRef = '@m' + (++this._refSeq); this._refs.set(el._mockRef, el); }
    return el._mockRef;
  }
  findEl(target) {
    if (target && target.ref) return this._refs.get(target.ref) || null;
    const want = typeof target === 'string' ? target : (target.sel || '');
    if (want) {
      // 最长匹配：'input[type=file][accept*=image]' 应命中封面输入而不是视频输入
      let best = null;
      for (const [pat, el] of Object.entries(this.page.elements)) if (want.includes(pat) && (!best || pat.length > best[0].length)) best = [pat, el];
      if (best) return { ...best[1], _pat: best[0], state: best[1].state };
      return null;
    }
    if (target.text) {
      for (const el of Object.values(this.page.elements)) {
        const hay = typeof el.text === 'function' ? el.text(el.state) : (el.text || '');
        if (el.text && hay.includes(target.text)) return el;
      }
    }
    return null;
  }
  // 与 real 后端 findAll 同语义：按文本找全部元素（保持定义顺序）；选择器目标取最长匹配
  async findAll(target) {
    const want = typeof target === 'string' ? target : (target.sel || target.text || '');
    if (!want) return [];
    const out = [];
    if (typeof target !== 'string') {
      for (const el of Object.values(this.page.elements)) {
        const hay = typeof el.text === 'function' ? el.text(el.state) : (el.text || '');
        if (!el.text) continue;
        if (target.exact ? hay === want : hay.includes(want)) out.push(el);
      }
    } else {
      let best = '';
      for (const pat of Object.keys(this.page.elements)) if (want.includes(pat) && pat.length > best.length) best = pat;
      if (best) out.push(this.page.elements[best]);
    }
    return out.map(el => this.refOfEl(el));
  }
  async findNth(target, n = 1) {
    return (await this.findAll(target))[n - 1] || null;
  }
  async clickAll(target, { max = 12 } = {}) {
    let n = 0;
    for (let i = 0; i < max; i++) {
      const ref = await this.findNth(target, 1);
      if (!ref) break;
      const el = this._refs.get(ref);
      if (!el || !el.effect) break;
      el.effect(el.state);
      n++;
      // 选择器目标点击后移除（模拟元素被点掉消失，避免同一元素重复点击死循环）
      if (typeof target === 'string' && el._pat) delete this.page.elements[el._pat];
    }
    return n;
  }
  async open(url) {
    const key = Object.keys(this.pages).find(k => url.startsWith(k));
    if (!key) throw new Error(`mock：没有 ${url} 的页面定义`);
    this.page = typeof this.pages[key] === 'function' ? this.pages[key]() : this.pages[key];
    for (const el of Object.values(this.page.elements)) el.state = this.page.state;   // 元素共享页面状态
    this.opsLog.push({ op: 'open', url });
    return { session: 'mock', tab: 'mock' };
  }
  async tabUrl() { return this.page?.url || ''; }
  async waitFor(target, timeoutMs = 20000) {
    this.opsLog.push({ op: 'waitFor', target: typeof target === 'string' ? target : target.text || target.sel });
    // mock 语义：页面已加载 = 就绪；元素显式 visible=false 才算未就绪（真实页面的网络加载不模拟）
    if (!this.page) return false;
    const el = this.findEl(target);
    if (!el) return true;
    const vis = typeof el.visible === 'function' ? el.visible(el.state) : el.visible;
    return vis === false ? false : true;
  }
  async fill(target, value, { append = false } = {}) {
    const el = this.findEl(target);
    this.opsLog.push({ op: 'fill', target: el?._pat || target.text, value });
    if (!el) throw new Error(`mock：找不到填写目标 ${typeof target === 'string' ? target : target.text}`);
    if (el.kind === 'tagInput') {
      el.state.pendingTag = value;   // 只暂存，回车才提交进 tags 数组
    } else if (el.kind === 'input' || el.kind === 'editor') {
      el.state[el.field] = append ? (el.state[el.field] || '') + value : value;
    }
    el.effect?.(el.state, { value, append });
    return {};
  }
  async press(key, target) {
    const el = this.findEl(target);
    this.opsLog.push({ op: 'press', key, target: el?._pat || target?.text });
    if (key === 'Enter' && el?.kind === 'tagInput' && el.state.pendingTag) {
      const t = el.state.pendingTag.trim();
      if (t && !el.state[el.field].includes(t)) el.state[el.field].push(t);
      el.state.pendingTag = '';
    }
    el?.effect?.(el.state, { key });
    return {};
  }
  async click(target) {
    const el = this.findEl(target);
    this.opsLog.push({ op: 'click', target: el?._pat || target?.text || target });
    if (!el) return false;
    el.effect?.(el.state);
    return true;
  }
  async hover(target) { this.opsLog.push({ op: 'hover', target: typeof target === 'string' ? target : target.text }); return {}; }
  async select(target, value) {
    const el = this.findEl(target);
    this.opsLog.push({ op: 'select', target: el?._pat, value });
    if (el) el.state[el.field] = value;
    return {};
  }
  async upload(target, file) {
    const el = this.findEl(target);
    this.opsLog.push({ op: 'upload', target: el?._pat || target, file });
    if (!el) throw new Error(`mock：找不到上传目标 ${typeof target === 'string' ? target : ''}`);
    el.state[el.field || 'uploaded'] = file;
    el.effect?.(el.state, { file });
    return {};
  }
  async text(target) {
    const el = this.findEl(target);
    if (!el) return '';
    return typeof el.text === 'function' ? el.text(el.state) : (el.text || '');
  }
  async html(target) {
    const el = this.findEl(target) || {};
    const body = typeof el.html === 'function' ? el.html(el.state) : Object.entries(el.state || {}).map(([k, v]) => `<div class="${k}">${Array.isArray(v) ? v.join('|') : v ?? ''}</div>`).join('');
    return `<html><body>${body}</body></html>`;
  }
  async inputValue(target) {
    const el = this.findEl(target);
    return el ? (el.state[el.field] ?? '') : '';
  }
  async closeTab() {}
  async close() { this.page = null; }
}

export function createBridge(opts = {}) {
  if (MOCK()) return new MockBridge(opts);
  return new RealBridge(opts);
}
export { RealBridge, MockBridge };
