// 视频号上传页填写。表单在 wujie 微前端的 Shadow DOM 里 —— CSS 选择器穿不进去，
// 全部用 bsk snapshot 的 ref 定位（aria 快照会遍历 shadow root）。与 publisher
// lib/platforms/channels.js（Apache-2.0）同序同校验。
// ⚠️ 本适配器是四个平台里校准量最大的：shadow 内元素在 snapshot 里的呈现形态要真机核对。
import { sleep } from '../bsk.js';
import { checkTitle, typeText, bodyText } from './common.js';

// shadow 内定位：先拿整个页面快照，再按 placeholder/文本找 ref
const P_SHORT = '填写短标题有机会获得更多流量';
const P_TIME = '请选择发表时间';
const P_CLOCK = '请选择时间';

async function shadow(br, text) {
  const ref = await br.findNth({ text }, 1);
  if (!ref) throw new Error(`视频号：页面上找不到「${text}」（shadow DOM 快照里没有这一行，需要校准 finder）`);
  return { ref };
}

// 定时发表：选「定时」→ 点开日期框 → 日历里点日期（跨月翻页）→ 时、分两列各点一下
async function schedule(br, ctx, s) {
  const 定时 = await shadow(br, '定时').catch(() => null);
  if (!定时) { ctx.fail('找不到定时发表的选项'); return; }
  await br.click(定时);
  const timeBox = await shadow(br, P_TIME).catch(() => null);
  if (!timeBox) { ctx.fail('找不到定时发表的时间框'); return; }
  await br.click(timeBox); await sleep(500);

  const want = `${s.y}年${s.m}月`;
  for (let i = 0; i < 3; i++) {
    const title = await br.text({ text: want }).catch(() => '');
    if (title.includes(want)) break;
    await br.click({ text: '下个月' }).catch(() => {});   // ⚠️校准：翻页按钮的真实文本
    await sleep(300);
  }
  const day = await shadow(br, `${s.m}月${s.d}日`).catch(() => null) || await shadow(br, String(s.d)).catch(() => null);
  if (!day) { ctx.note(`日历里没找到 ${s.d} 号，请手动设`); return; }
  await br.click(day); await sleep(400);

  const clock = await shadow(br, P_CLOCK).catch(() => null);
  if (clock) { await br.click(clock); await sleep(400); }
  // 时、分两列：exact 全等避免撞上页面其它数字（⚠️校准：列头文本出来后改用 after 锚定）
  const h = await br.findAll({ text: String(s.hh).padStart(2, '0'), exact: true });
  if (h[0]) { await br.click({ ref: h[0] }); await sleep(250); }
  const m = await br.findAll({ text: String(s.mm).padStart(2, '0'), exact: true });
  if (m[0]) { await br.click({ ref: m[0] }); await sleep(400); }

  const got = (await br.text({ text: `${s.ymd}` }).catch(() => '')) + ' ' + (await br.text({ text: s.hm }).catch(() => ''));
  if (got.includes(s.ymd) && got.includes(s.hm)) ctx.log(`定时发表：${s.text}`);
  else ctx.fail(`定时没设对：页面上能读到「${got.trim()}」，应该是「${s.text}」`);
}

export default {
  id: 'channels',
  name: '视频号',
  url: 'https://channels.weixin.qq.com/platform/post/create',
  ready: 'wujie-app',   // shadow 内容要等快照里有 P_SHORT 才算就绪（见 fill 里的 waitFor）

  async fill(br, ctx) {
    const { p } = ctx;
    // 视频号会把上次未发表的编辑弹成「将此次编辑保留?」遮罩（按钮在 shadow DOM，VOM 不可 ref）：
    // evaluate 走 shadow 树点「不保存」（composed 事件），点完验证弹窗真消失；不行再试「保存」和关闭 X。
    const DISMISS_SCRIPT = `(() => {
      let node = null;
      const walk = (root) => {
        const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let n; while ((n = w.nextNode())) if (/将此次编辑保留/.test(n.textContent)) node = n;
        for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot);
      };
      walk(document);
      if (!node) return 'no-dialog';
      let el = node.parentElement;
      for (let k = 0; k < 10 && el; k++) { if (el.classList && el.classList.contains('weui-desktop-dialog__wrp')) break; el = el.parentElement; }
      if (!el) return 'no-container';
      const fire = (b) => { try { b.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, cancelable: true })); return true; } catch (e) { try { b.click(); return true; } catch (e2) { return false; } } };
      const save = [...el.querySelectorAll('button')].find(b => b.textContent.trim() === '保存');
      const close = el.querySelector('.weui-desktop-icon-btn');
      if (save && fire(save)) return 'saved';
      if (close && fire(close)) return 'closed';
      return 'no-button';
    })()`;
    for (let i = 0; i < 3; i++) {
      let r = '';
      try { r = String(await br.evaluate(DISMISS_SCRIPT)); } catch { r = 'evaluate-err'; }
      await sleep(2500);
      await br.sync().catch(() => {});
      if (!br.vomText.includes('将此次编辑保留')) { ctx.note('已处理「将此次编辑保留?」弹窗'); break; }
      if (r === 'no-dialog') break;
    }
    if (br.vomText.includes('将此次编辑保留')) ctx.note('「将此次编辑保留?」弹窗没能自动关掉，上传区可能被挡住——如自动上传失败请手动关掉该弹窗再拖视频');

    // 上传：shadow 里的 input[type=file] 用 evaluate+本地文件桥直塞（CDP setFileInputFiles 被拒），
    // 失败引导手动拖拽。
    try {
      await br.uploadViaEvaluate(ctx.video);
      await br.readUploadResult({ timeoutMs: 90000 });
      ctx.log('视频开始上传（evaluate 通道）');
    } catch (e) {
      ctx.note(`自动上传没成功（${e.message.slice(0, 70)}）：请把视频拖进上传区，程序会自动接管`);
    }
    // 短标题框出现（表单就绪，无论视频是自动传的还是原有草稿）
    if (!await br.waitFor({ text: P_SHORT }, 60000)) throw new Error('上传后没有出现表单（等待手动操作超时）');
    ctx.log('表单就绪，接管填写');
    await sleep(1000);

    // wujie shadow 深层：bsk fill 的 ref 通道写不进，全部走 evaluate 直写（设值+原生 input 事件）
    const SET_INPUT = (placeholder, value) => `(() => {
      const found = [];
      const walk = (root) => {
        for (const el of root.querySelectorAll('input, textarea')) {
          const ph = el.getAttribute('placeholder') || '';
          if (ph.includes(${JSON.stringify(placeholder)}) || (el.value && el.value.includes(${JSON.stringify(placeholder)}))) found.push(el);
        }
        for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot);
      };
      walk(document);
      const el = found[0];
      if (!el) throw new Error('input not found: ${placeholder}');
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      return el.value;
    })()`;
    try {
      const got = String(await br.evaluate(SET_INPUT(P_SHORT, p.shortTitle)));
      if (got === p.shortTitle) ctx.log(`短标题：${p.shortTitle}`);
      else {
        // evaluate 通道不可用（mock/受限）：退化 bsk fill 通道
        const shortBox = await shadow(br, P_SHORT);
        await br.fill(shortBox, p.shortTitle);
        await sleep(200);
        await checkTitle(br, ctx, shortBox, p.shortTitle, '短标题');
      }
    } catch (e) { ctx.fail(`短标题写入失败：${e.message.slice(0, 80)}`); }

    // 描述编辑器：contenteditable（添加描述区域），设 innerText 后触发 input
    const SET_EDITOR = (text) => `(() => {
      const found = [];
      const walk = (root) => {
        for (const el of root.querySelectorAll('[contenteditable=true], .ql-editor, [class*=editor]')) found.push(el);
        for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot);
      };
      walk(document);
      const el = found.find(e => /添加描述|description|editor/i.test(e.className + ' ' + (e.getAttribute('placeholder') || ''))) || found[0];
      if (!el) throw new Error('editor not found');
      el.focus();
      el.textContent = ${JSON.stringify(text)};
      el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      return el.textContent.length;
    })()`;
    if (p.body) {
      let evOk = false;
      try {
        const n = Number(await br.evaluate(SET_EDITOR(p.body))) || 0;
        if (n === p.body.length) { ctx.log(`描述：${p.body.length} 字（编辑器 ${n}）`); evOk = true; }
      } catch { /* 走 fallback */ }
      if (!evOk) {
        // evaluate 通道不可用（mock/受限）：退化 bsk fill 通道
        const editor = (await shadow(br, '添加描述').catch(() => null)) || (await shadow(br, P_SHORT));
        await typeText(br, ctx, editor, p.body);
        ctx.log(`描述：${p.body.length} 字`);
      }
    }
    // 话题直接在描述里输入「#话题 」就会高亮，不用选联想
    if (p.topics && p.topics.length) {
      try {
        const n = Number(await br.evaluate(SET_EDITOR(p.body + '\n' + p.topics.map(t => '#' + t + ' ').join('')))) || 0;
        if (n) ctx.log(`话题：${p.topics.join('、')}（已在描述中标注）`);
        else throw new Error('mock');
      } catch {
        const editor = (await shadow(br, '添加描述').catch(() => null)) || (await shadow(br, P_SHORT));
        await br.press('Enter', editor);
        for (const t of p.topics) { await br.fill(editor, '#' + t + ' ', { append: true }); await sleep(200); }
        ctx.log(`话题：${p.topics.join('、')}`);
      }
    }
    if (ctx.schedule) await schedule(br, ctx, ctx.schedule);
    ctx.note('封面要等视频上传完才能设置，传完会自动补上');
  },

  // 自动点发表（发表按钮 + 确认弹窗）
  async submit(br, ctx) {
    const { clickSubmit } = await import('./common.js');
    return clickSubmit(br, ctx, {
      texts: ['发表'],
      successTexts: ['发表成功', '已发表', '视频管理'],
      confirmTexts: ['确定', '确认'],
      timeoutMs: 120000,
    });
  },

  async uploadDone(br) {
    const t = await bodyText(br);
    return !t.includes('取消上传');
  },

  // 视频传完后：个人主页卡片 3:4、分享卡片 4:3（⚠️校准：编辑入口的文本形态）
  async afterUpload(br, ctx) {
    const set = async (label, file) => {
      const edit = await shadow(br, `${label} 编辑`).catch(() => null) || await shadow(br, '编辑').catch(() => null);
      if (!edit) throw new Error(`找不到${label}的「编辑」`);
      await br.click(edit); await sleep(1000);
      await br.click({ text: '直接编辑' }).catch(() => {});   // 分享卡片会先问「使用此素材作为封面？」
      await sleep(800);
      await br.upload({ text: '上传封面' }, file).catch(async () => { await br.upload('input[type=file]', file); });
      await sleep(2500);
      if (!await br.click({ text: '确认' })) throw new Error(`${label}编辑框里找不到「确认」`);
      await sleep(1500);
      ctx.log(`${label}：已设置`);
    };
    const v = ctx.cover('3x4'), h = ctx.cover('4x3');
    if (v) await set('个人主页', v);
    if (h) await set('分享卡片', h);
  },

  links: {
    url: 'https://channels.weixin.qq.com/platform/post/list',
    ready: 'post-feed',
  },
};
