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
import { startFileBridge } from './filebridge.js';

export const sleep = (ms) => new Promise(r => setTimeout(r, MOCK() ? Math.min(ms, 5) : ms));   // mock 下快进
const BSK = process.env.BSK_BIN || 'bsk';
const MOCK = () => process.env.BSK_MODE === 'mock';

// ---------------------------------------------------------------------------
// real 后端：spawn bsk CLI
// ---------------------------------------------------------------------------
export function exec(args, { timeout = 60000 } = {}) {
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

let GLOBAL_SCOPE_SEQ = 0;   // 守护级 scope 必须全局唯一：同名 scope 复用会被扩展拒绝
class RealBridge {
  constructor({ scope = 'liang-publish' } = {}) {
    this.scopeBase = `${scope}:${Date.now().toString(36)}:${++GLOBAL_SCOPE_SEQ}`;
    this.scopeSeq = 0;
    this.session = null;      // bsk session id
    this.contextId = null;    // cooperate sync 的控制上下文（target 策略）
    this.observationId = null;
    this.tab = null;
    this.url = '';
    this.vomText = '';        // 最近一次观察的 VOM 全文（@eN ref 都在这里）
  }
  static common() { return []; }

  // 每次 open 用全新 scope，并先归还上一个会话（旧会话的 tab 不关会让新 open 被「frame changed」拒绝）。
  async open(url) {
    if (this.session) await exec(['close', '--session', this.session], { timeout: 20000 }).catch(() => {});
    this.session = null;
    const attempt = async (scope) => {
      const r = await exec(['open', url, '--scope', scope, '--no-focus', '--json'], { timeout: 60000 });
      return { r, j: parseJson(r.stdout) || {} };
    };
    let scope = `${this.scopeBase}:${++this.scopeSeq}`;
    let { r, j } = await attempt(scope);
    if (r.code !== 0 && /frame changed|Document changed|synchronize|observation/i.test(r.stdout + r.stderr) && (j.session_id || j.session)) {
      this.session = j.session_id || j.session;
      await this.sync().catch(() => {});
      scope = `${this.scopeBase}:${++this.scopeSeq}`;
      ({ r, j } = await attempt(scope));
    }
    if (!j.session_id && !j.session) throw new Error(`bsk open 失败：${(j.message || j.error || r.stderr || r.stdout || '').slice(0, 300)}`);
    this.session = j.session_id || j.session;
    this.tab = j.tab_id || j.tabId || null;
    this.url = j.url || url;
    this.vomText = j.vom || '';
    this.observationId = j.observation_id || null;
    this.contextId = j.context_id || null;   // open 返回的初始上下文；后续用 sync 刷新
    await this.sync().catch(() => {});       // open 完成先建立一次新鲜观察（ref/url 就位）
    return { session: this.session, tab: this.tab, url: this.url };
  }

  // cooperate sync：刷新控制上下文 + 观察（target 策略下 DOM 动作都要带 --context）
  async sync() {
    const r = await exec(['cooperate', 'sync', '--session', this.session, '--json'], { timeout: 45000 });
    const j = parseJson(r.stdout) || {};
    if (j.error || j.code) throw new Error(`bsk cooperate sync 失败：${(j.message || j.error || r.stderr || '').slice(0, 240)}`);
    this.contextId = j.context_id || this.contextId;
    this.observationId = j.observation_id || this.observationId;
    if (j.url) this.url = j.url;
    if (j.observation?.text) this.vomText = j.observation.text;
    else if (j.observation?.vom) this.vomText = j.observation.vom;
    return j;
  }

  async tabUrl() { return this.url; }

  // 账本解冻：upload 派发后 outcome UNKNOWN 会让账本 frozen、拦截一切后续写入动作。
  // 调用前必须由调用方确认页面没收到文件（表单没出现）——resolve 后重传是安全的。
  async unfreeze() {
    const s = await exec(['ledger', 'status', '--json'], { timeout: 20000 }).catch(() => ({ stdout: '{}' }));
    const j = parseJson(s.stdout) || {};
    const pending = j.pending_unknown || [];
    if (!pending.length) return 0;
    for (const p of pending) {
      await exec(['ledger', 'resolve', '--operation-id', p.operation_id, '--json'], { timeout: 20000 }).catch(() => {});
    }
    return pending.length;
  }

  argvTail(extra = []) {
    const t = ['--session', this.session];
    if (this.contextId) t.push('--context', this.contextId);
    if (this.tab != null) t.push('--tab-id', String(this.tab));
    return t;
  }

  async waitFor(target, timeoutMs = 20000) {
    // 统一走「轮询 sync + VOM 判定」：wait-for-element 与 cooperate sync 的观察视图可能不一致
    // （B站稿件表单在 micro-app 里，wait-for-element 能看到但 sync 常抓不到）——以 sync 的 VOM 为准。
    const sel = typeof target === 'string' ? target : target.sel;
    const feat = sel ? (sel.match(/placeholder="([^"]+)"/)?.[1] || '') : (target?.text || '');
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      try { await this.sync(); } catch { await sleep(1200); continue; }
      if (feat ? this.vomText.includes(feat) : await this.find(target)) return true;
      await sleep(1500);
    }
    return false;
  }
  async find(target) {
    return (await this.findAll(target))[0] || null;
  }
  // 在最近一次观察的 VOM 里按可见文本找 ref（保持页面顺序）。
  // {text, exact}：VOM 行内引号字段全等；{text, after}：要求出现在锚文本之后；{ref}：直接给
  async findAll(target) {
    const lines = (this.vomText || '').split('\n');
    const want = String(target.text ?? target.ref ?? '');
    // {after} 且无 text：返回锚文本之后第一个带 ref 的行（定位「某标题下面的第一个输入框」）
    if (!want && target.after) {
      let afterOk = false;
      for (const line of lines) {
        if (!afterOk) { if (line.includes(target.after)) afterOk = true; continue; }
        const m = line.match(/@e\d+/);
        if (m) return [m[0]];
      }
      return [];
    }
    const hit = (line) => {
      // 只匹配可访问名（VOM 行的第一个引号字段）——面包屑 ctx: 长文本会让整行匹配撞上无关按钮
      const name = line.match(/"([^"]*)"/)?.[1] || '';
      if (!name) return false;
      if (target.exact) return name === want;
      return name.includes(want);
    };
    const out = [];
    let afterOk = !target.after;
    for (const line of lines) {
      if (target.after && !afterOk) {
        // 锚定要求可访问名字段全等：聚合行（整页 main）的名字段是拼起来的长文本，不会全等
        const nm = line.match(/"([^"]*)"/)?.[1] || '';
        if (nm && nm === target.after) afterOk = true;
        continue;
      }
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
    if (typeof target === 'string') {
      // CSS 选择器优先转 VOM ref（placeholder 特征）；micro-app/shadow 里的元素只能走 ref
      const pm = target.match(/placeholder="([^"]+)"/);
      if (pm) {
        const ref = await this.find({ text: pm[1] });
        if (ref) return { ref };
      }
      return { selector: target };
    }
    if (target.ref) return { ref: target.ref };
    if (target.sel) return { selector: target.sel };
    const ref = await this.find(target);
    if (!ref) throw new Error(`页面上找不到「${target.text}」`);
    return { ref };
  }
  // DOM 动作：带控制上下文；页面变化导致的拒绝自动 sync 重试一次（bsk target 策略的标准恢复路径）
  async step(action, target, params = {}) {
    const attempt = async () => {
      const t = await this.refOf(target);
      const payload = { ...params, ...t };
      const r = await exec(['step', '--action', action, '--params', JSON.stringify(payload), '--json', ...this.argvTail()], { timeout: 90000 });
      return { r, j: parseJson(r.stdout) || {} };
    };
    let { r, j } = await attempt();
    if (r.code !== 0 && /observation|context|observed_change|stale/i.test(r.stdout + r.stderr)) {
      await this.sync();
      ({ r, j } = await attempt());
    }
    if (r.code !== 0) {
      const msg = (j.message || j.error || r.stderr || r.stdout || '').slice(0, 300);
      if (/找不到|missing|ambiguous|not found/i.test(msg)) throw new Error(`页面上找不到「${typeof target === 'string' ? target : target.text || target.sel || ''}」（bsk step ${action}）`);
      throw new Error(`bsk step ${action} 失败：${msg}`);
    }
    if (j.effect_state === 'unknown') throw new Error(`bsk step ${action} 结果未知（effect_state=unknown），先 sync 观察再决定，不要盲重试`);
    // 动作后刷新观察（ref 随页面重排而失效，sync 保持引用新鲜）
    await this.sync().catch(() => {});
    return j;
  }
  async fill(target, value, { append = false } = {}) {
    // bsk fill 对 contenteditable/输入框是整块替换；append 语义真机不做（多行直接整块填入）
    return this.step('fill', target, { value });
  }
  async press(key, target) { return this.step('press', target, { key }); }
  async click(target) {
    try { await this.step('click', target); return true; }
    catch (e) { if (/找不到/.test(e.message)) return false; throw e; }
  }
  async hover(target) { return this.step('hover', target); }
  async select(target, value) { return this.step('select', target, { value }); }
  async upload(target, file) {
    const attempt = async () => {
      const t = await this.refOf(target);
      const args = ['upload', t.ref || t.selector, '--file', path.resolve(file), '--json', ...this.argvTail()];
      const r = await exec(args, { timeout: 180000 });
      return { r, j: parseJson(r.stdout) || {} };
    };
    let { r, j } = await attempt();
    if (r.code !== 0 && /observation|context|observed_change|coverage|stale/i.test(r.stdout + r.stderr)) {
      // 账本可能被上次 UNKNOWN 冻结：确认页面没收到文件后解冻重试一次
      await this.sync().catch(() => {});
      await this.unfreeze().catch(() => {});
      await sleep(800);
      ({ r, j } = await attempt());
    }
    if (r.code !== 0) {
      // CDP setFileInputFiles 被拒（FS API 类上传组件）：走 evaluate+本地文件桥——页面 JS 自己
      // fetch 字节、new File() 塞 input.files，Chrome 无权拒绝。
      try {
        await this.uploadViaEvaluate(file);
        return { via: 'evaluate' };
      } catch (e2) {
        throw new Error(`bsk upload 失败：${(j.message || j.error || r.stderr || r.stdout || '').slice(0, 200)}；evaluate 通道也没成：${e2.message.slice(0, 160)}`);
      }
    }
    if (j.reason === 'file_input_not_activated') throw new Error('上传框没有被激活（file_input_not_activated）：重新观察页面找上传按钮');
    await this.sync().catch(() => {});
    return j;
  }

  // evaluate+本地文件桥上传：起一次性本地服务 → 页面 JS fetch 字节 → File → DataTransfer → input.files。
  // fire-and-forget：evaluate 立即返回（fetch 在页面里异步跑，14MB 不能挤 60s 的 evaluate 超时），
  // 结果挂在 window.__liangUpload，调用方轮询 readUploadResult。
  async uploadViaEvaluate(file) {
    const bridge = await startFileBridge(path.resolve(file));
    this._bridge = bridge;
    try {
      const script = `(() => {
        const URL_ = ${JSON.stringify(bridge.url)};
        const NAME = ${JSON.stringify(bridge.name)};
        const collect = (root, out) => {
          for (const el of root.querySelectorAll('input[type=file]')) out.push(el);
          for (const el of root.querySelectorAll('*')) if (el.shadowRoot) collect(el.shadowRoot, out);
        };
        const inputs = [];
        collect(document, inputs);
        const input = inputs.find(i => !i.disabled) || inputs[0];
        if (!input) return 'no-input';
        window.__liangUpload = fetch(URL_).then(r => { if (!r.ok) throw new Error('bridge http ' + r.status); return r.arrayBuffer(); }).then((buf) => {
          const file = new File([buf], NAME, { type: 'video/mp4' });
          const dt = new DataTransfer();
          dt.items.add(file);
          input.files = dt.files;
          input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
          input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
          window.__liangUploadResult = 'set:' + input.files.length;
          return window.__liangUploadResult;
        }).catch(e => { window.__liangUploadResult = 'err:' + e.message; return window.__liangUploadResult; });
        return 'started';
      })()`;
      const res = String(await this.evaluate(script));
      if (res === 'no-input') throw new Error('页面里没有 input[type=file]');
      if (res !== 'started') throw new Error('注入失败：' + res);
      return res;
    } catch (e) {
      await bridge.close().catch(() => {});
      this._bridge = null;
      throw e;
    }
  }

  // 轮询 uploadViaEvaluate 的结果；context 失效时 sync 重建；表单出现/结果为 set 时关闭文件桥
  async readUploadResult({ timeoutMs = 120000 } = {}) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      await sleep(3000);
      let v = '';
      try {
        v = String(await this.evaluate('window.__liangUploadResult || ""'));
      } catch (e) {
        if (/context|changed|synchronize/i.test(e.message)) { await this.sync().catch(() => {}); continue; }
        continue;
      }
      if (v && v !== 'undefined' && v !== 'null') {
        if (this._bridge) { await this._bridge.close().catch(() => {}); this._bridge = null; }
        if (v.startsWith('set:')) return v;
        throw new Error('evaluate 上传失败：' + v);
      }
    }
    if (this._bridge) { await this._bridge.close().catch(() => {}); this._bridge = null; }
    throw new Error('evaluate 上传等待超时');
  }
  async html(target) {
    // get-html 只收 --ref（子树）或不带 ref（整页）；CSS 选择器目标退化为整页 dump
    const t = await this.refOf(target).catch(() => ({}));
    const args = ['get-html', '--json', ...this.argvTail()];
    if (t.ref) args.push('--ref', t.ref);
    const r = await exec(args, { timeout: 45000 }).catch(() => ({ stdout: '' }));
    const j = parseJson(r.stdout);
    return j?.html || j?.content || '';
  }
  async text(target) {
    // {sel:'body'}：整页文本直接从最近一次 VOM 观察提取（read 不收裸选择器，省一次往返）
    const isBody = typeof target === 'string' ? target === 'body' : (target.sel === 'body');
    if (isBody) {
      return (this.vomText || '')
        .split('\n')
        .map(l => [...l.matchAll(/"([^"]*)"/g)].map(m => m[1]).join(' '))
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
    }
    // 有 ref 的目标：VOM 里那一行就是它的可见文本
    const t = await this.refOf(target).catch(() => ({}));
    if (t.ref) {
      const line = (this.vomText || '').split('\n').find(l => l.includes(t.ref));
      if (line) {
        const quoted = [...line.matchAll(/"([^"]*)"/g)].map(m => m[1]);
        if (quoted.length) return quoted.join(' ').trim();
      }
    }
    const r = await exec(['read', '--selector', t.ref || t.selector || 'body', '--fields-json', JSON.stringify([{ key: 'text', read: 'text' }, { key: 'value', read: 'value' }]), '--json', ...this.argvTail()], { timeout: 30000 }).catch(() => ({ stdout: '' }));
    const j = parseJson(r.stdout);
    // read 返回 nodes 数组：[{key:'text', value:...}, ...] 或 {fields:{...}}
    const node = (j?.nodes || [])[0] || j?.fields || j;
    const v = node?.text ?? node?.value ?? j?.text ?? j?.value;
    if (v != null) return String(v);
    const h = await this.html(target).catch(() => '');
    return h.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  // 读输入框当前值：VOM 优先（textbox 行尾 ="值"；read 的 CSS 查询穿不进 micro-app/shadow）
  async inputValue(target) {
    await this.sync().catch(() => {});
    const lines = (this.vomText || '').split('\n');
    // {ref} 目标：VOM 里该 ref 行的 ="值"
    if (target?.ref) {
      const line = lines.find(l => l.includes(target.ref));
      if (line) {
        if (/\[empty\]/.test(line)) return '';
        const vm = line.match(/="([^"]*)"\s*$/) || line.match(/="([^"]*)"/);
        if (vm) return vm[1];
      }
    }
    const sel = typeof target === 'string' ? target : (target.sel || '');
    const pm = sel.match(/placeholder="([^"]+)"/);
    const want = target?.text || (pm && pm[1]) || '';
    if (want) {
      const line = lines.find(l => l.includes(want) && /textbox/i.test(l));
      if (line) {
        if (/\[empty\]/.test(line)) return '';
        const vm = line.match(/="([^"]*)"\s*$/) || line.match(/="([^"]*)"/);
        if (vm) return vm[1];
      }
    }
    const t = await this.refOf(target).catch(() => ({}));
    if (!t.selector && !t.ref) return '';
    const r = await exec(['read', '--selector', t.selector || 'body', '--fields-json', JSON.stringify([{ key: 'value', read: 'value' }]), '--max-nodes', '3', '--json', ...this.argvTail()], { timeout: 30000 }).catch(() => ({ stdout: '' }));
    const j = parseJson(r.stdout) || {};
    const node = (j?.nodes || [])[0] || j?.fields || j;
    return node?.value ?? '';
  }
  async closeTab() { /* Agent Window 的 tab 由 session close 统一归还 */ }
  // 页面内 JS（协议 1.9）：unverified 模式——脚本必须自检前提条件（弹窗在不在等），页面动画不受限。
  async evaluate(script) {
    const r = await exec(['evaluate', script, '--session', this.session, '--context', this.contextId, '--unverified', '--json'], { timeout: 60000 });
    const j = parseJson(r.stdout) || {};
    if (r.code !== 0) throw new Error(`bsk evaluate 失败：${(j.message || j.error || r.stderr || '').slice(0, 300)}`);
    return j.value;
  }
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
  // 与 real 桥同接口的空实现/简单实现（适配器真机化后新增的调用点）
  async sync() { /* mock 页面状态即时生效，无需刷新 */ }
  async evaluate() { return 'mock'; }
  async unfreeze() { return 0; }
  get vomText() {
    if (!this.page) return '';
    const body = Object.values(this.page.elements).find(el => el._pat === 'body' || el.kind === 'text');
    return typeof body?.text === 'function' ? body.text(this.page.state) : (body?.text || '');
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
      // 最短匹配优先：聚合 body 的长文本也会包含按钮文本，不能让它抢先
      let best = null, bestLen = Infinity;
      for (const el of Object.values(this.page.elements)) {
        const hay = typeof el.text === 'function' ? el.text(el.state) : (el.text || '');
        if (el.text && hay.includes(target.text) && hay.length < bestLen) { best = el; bestLen = hay.length; }
      }
      return best;
    }
    return null;
  }
  // 与 real 后端 findAll 同语义：按文本找全部元素（保持定义顺序）；支持 after 锚定（锚元素后的第一个有 effect 元素）
  async findAll(target) {
    const want = typeof target === 'string' ? target : (target.sel || target.text || '');
    const entries = Object.entries(this.page.elements);
    if (!want && target.after) {
      let afterOk = false;
      for (const [, el] of entries) {
        const hay = typeof el.text === 'function' ? el.text(el.state) : (el.text || '');
        if (!afterOk) { if (hay === target.after || hay.includes(target.after)) afterOk = true; continue; }
        if (el.kind !== 'text') return [this.refOfEl(el)];
      }
      return [];
    }
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
