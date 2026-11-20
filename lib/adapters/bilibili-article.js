// B站专栏文章适配器（文章发布）。
// 编辑器结构（真机侦查 2026-11-20）：
//   - 管理页/新建入口：member.bilibili.com/platform/upload/text/new-article（草稿箱+文章列表）
//   - 新文章编辑器：member.bilibili.com/platform/upload/text/new-edit（空白，无需参数）
//   - 编辑器在 iframe (york/read-editor)：标题 .title-input__inner；正文 .tiptap.ProseMirror.eva3-editor
//   - 发布/保存为草稿/发布设置按钮在父文档
// 正文注入：tiptap 粘贴 HTML（ClipboardEvent paste + text/html）——tiptap 自己解析成文档节点。
import { sleep } from '../bsk.js';
import { bodyText } from './common.js';
import { md2html } from '../md2html.mjs';

// 等编辑器 iframe 就绪（标题框 + tiptap 出现）。evaluate 报 context 失效时 sync 重建——
// run 流程里 useSession 后 context 常是过期的，不能把「通道错误」当「编辑器未加载」。
async function waitEditor(br, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    let r = '';
    try {
      r = await br.evaluate(`(() => {
        for (const f of document.querySelectorAll('iframe')) {
          try {
            const d = f.contentDocument;
            if (!d || !d.body) continue;
            if (d.querySelector('.title-input__inner') && d.querySelector('.tiptap.ProseMirror')) return 'ready';
          } catch {}
        }
        return 'no';
      })()`);
    } catch (e) {
      if (/context|changed|synchronize/i.test(e.message)) { await br.sync().catch(() => {}); continue; }
      r = 'no';
    }
    if (r === 'ready') return true;
    await sleep(1500);
  }
  return false;
}

export default {
  id: 'bilibili',
  name: 'B站专栏',
  url: 'https://member.bilibili.com/platform/upload/text/new-edit',

  // 文章填写：标题 + 正文（markdown→HTML 粘贴进 tiptap）
  async fill(br, ctx) {
    const { p } = ctx;
    if (!await waitEditor(br, 30000)) throw new Error('专栏编辑器没有加载（iframe 未就绪）');

    const contentHtml = md2html(p.content || p.body || '');

    const script = `(() => {
      let doc = null, win = null;
      for (const f of document.querySelectorAll('iframe')) {
        try { if (f.contentDocument && f.contentDocument.querySelector('.tiptap.ProseMirror')) { doc = f.contentDocument; win = f.contentWindow; break; } } catch {}
      }
      if (!doc) throw new Error('编辑器 iframe 未找到');
      const title = doc.querySelector('.title-input__inner');
      const editorEl = doc.querySelector('.tiptap.ProseMirror');
      if (!title || !editorEl) throw new Error('标题框/正文编辑器未找到');
      const setter = Object.getOwnPropertyDescriptor((title.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype), 'value').set;
      setter.call(title, ${JSON.stringify(p.title || '')});
      title.dispatchEvent(new Event('input', { bubbles: true }));
      // tiptap 实例存在 el.__tiptap 或 closest；用 setContent 注入 HTML（官方 API，直接更新文档）
      const editorApi = editorEl.__tiptap || (win && win.editor) || null;
      const html = ${JSON.stringify(contentHtml)};
      if (editorApi && editorApi.commands && editorApi.commands.setContent) {
        editorApi.commands.setContent(html);
      } else {
        // 兜底：execCommand insertHTML（对 tiptap 生成标准节点）
        editorEl.focus();
        doc.execCommand('insertHTML', false, html);
      }
      return JSON.stringify({ title: title.value, len: editorEl.textContent.length });
    })()`;
    const r = String(await br.evaluate(script));
    let got = {};
    try { got = JSON.parse(r); } catch { /* 解析失败走读回校验 */ }

    // 读回校验：等待最多 10 秒（粘贴后 tiptap 解析需要一点时间），标题/正文长度都确认
    const end = Date.now() + 10000;
    let st = {};
    while (Date.now() < end) {
      const check = await br.evaluate(`(() => {
        let doc = null;
        for (const f of document.querySelectorAll('iframe')) {
          try { if (f.contentDocument && f.contentDocument.querySelector('.tiptap.ProseMirror')) { doc = f.contentDocument; break; } } catch {}
        }
        if (!doc) return '{}';
        const t = doc.querySelector('.title-input__inner');
        const e = doc.querySelector('.tiptap.ProseMirror');
        return JSON.stringify({ title: t ? t.value : '', len: e ? e.textContent.length : 0 });
      })()`).catch(() => '{}');
      try { st = JSON.parse(check); } catch { st = {}; }
      if ((st.title || '').trim() === (p.title || '').trim() && st.len > 100) break;
      await sleep(1500);
    }
    if ((st.title || '').trim() === (p.title || '').trim()) ctx.log(`标题：${p.title}`);
    else ctx.fail(`标题异常：期望「${p.title}」，页面上是「${st.title || '空'}」`);
    ctx.log(`正文：${(p.content || '').length} 字${st.len ? `（编辑器 ${st.len}）` : ''}`);
  },

  // 自动发布：点「发布」（exact 匹配，父文档）→ 确认弹窗 → 等成功信号
  async submit(br, ctx) {
    const { clickSubmit } = await import('./common.js');
    return clickSubmit(br, ctx, {
      texts: ['发布'],
      successTexts: ['发布成功', '审核中', '已发布', '提交成功'],
      confirmTexts: ['确定', '确认'],
      timeoutMs: 120000,
    });
  },
};
