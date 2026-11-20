// 微信公众号文章适配器（mp.weixin.qq.com）。
// 编辑器结构（真机侦查 2026-11-21）：
//   - 新建：直接开 https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&type=77&lang=zh_CN&token=<TOKEN>
//     （token 会话相关——从用户给的 home URL 里提取）
//   - 标题 #title（TEXTAREA）；作者 #author（INPUT）；摘要 #digest
//   - 正文：UEditor（#ueditor_0 iframe，跨域不可直入 DOM，但父页面有 window.UE 官方 API）
//   - 正文注入：UE.getEditor('ueditor_0').setContent(html)——官方 API，支持 HTML（图片需素材库，外链会被过滤）
//   - 封面：需从正文图选择或本地上传（v1 依赖自动抓取正文首图；无图文章用平台默认）
//   - 发表：#js_send（发表，每订阅号 1 次/天）→ 确认弹窗；#js_submit 保存为草稿
import { sleep } from '../bsk.js';
import { md2html } from '../md2html.mjs';

// 从用户给的 home URL 或配置里提取 token
function extractToken(url) {
  const m = String(url).match(/token=(\d+)/);
  return m ? m[1] : '';
}

export default {
  id: 'weixin',
  name: '微信公众号',
  url: 'https://mp.weixin.qq.com/cgi-bin/home?t=home/index&lang=zh_CN',

  // 从 ctx.p.token 或 ctx.homeUrl 里取 token；没有就要求配置
  buildEditorUrl(ctx) {
    const token = ctx.token || (ctx.homeUrl ? extractToken(ctx.homeUrl) : '');
    if (!token) throw new Error('缺少公众号 token：把后台首页 URL（含 token=数字）配到工程 publish.json 的 homeUrl 里');
    return `https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&type=77&lang=zh_CN&token=${token}`;
  },

  // 文章填写：标题 + 作者 + 正文（markdown→HTML→UEditor setContent）
  async fill(br, ctx) {
    const { p } = ctx;
    const editorUrl = this.buildEditorUrl(ctx);
    await br.open(editorUrl);
    await sleep(3000);
    // 等编辑器就绪：新版公众号是 mock-iframe（#ueditor_0 是 div，内含 .mock-iframe-body 可编辑区）
    const end = Date.now() + 30000;
    let ready = false;
    while (Date.now() < end) {
      const r = await br.evaluate(`(() => {
        const body = document.querySelector('#ueditor_0 .mock-iframe-body [contenteditable], #ueditor_0 .rich_media_content');
        return (document.querySelector('#title') && body) ? 'ready' : 'no';
      })()`).catch(() => 'no');
      if (r === 'ready') { ready = true; break; }
      await sleep(1500);
    }
    if (!ready) throw new Error('公众号编辑器没有加载（正文编辑区未就绪）');

    const contentHtml = md2html(p.content || p.body || '');

    const script = `(() => {
      const title = document.querySelector('#title');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(title, ${JSON.stringify(p.title || '')});
      title.dispatchEvent(new Event('input', { bubbles: true }));
      const author = document.querySelector('#author');
      if (author && ${JSON.stringify(p.author || '')}) {
        const as = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        as.call(author, ${JSON.stringify(p.author || '')});
        author.dispatchEvent(new Event('input', { bubbles: true }));
      }
      // 正文：mock-iframe-body 里的 contenteditable div（.rich_media_content）
      const body = document.querySelector('#ueditor_0 .mock-iframe-body [contenteditable]') || document.querySelector('#ueditor_0 .rich_media_content');
      if (!body) throw new Error('正文编辑区未找到');
      body.innerHTML = ${JSON.stringify(contentHtml)};
      body.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      return JSON.stringify({ title: title.value, len: body.textContent.length });
    })()`;
    const r = String(await br.evaluate(script));
    let got = {};
    try { got = JSON.parse(r); } catch {}

    // 读回校验（轮询 10s）
    const end2 = Date.now() + 10000;
    let st = {};
    while (Date.now() < end2) {
      const check = await br.evaluate(`(() => {
        const t = document.querySelector('#title');
        const body = document.querySelector('#ueditor_0 .mock-iframe-body [contenteditable]') || document.querySelector('#ueditor_0 .rich_media_content');
        return JSON.stringify({ title: t ? t.value : '', len: body ? body.textContent.length : 0 });
      })()`).catch(() => '{}');
      try { st = JSON.parse(check); } catch { st = {}; }
      if ((st.title || '').trim() === (p.title || '').trim() && st.len > 50) break;
      await sleep(1500);
    }
    if ((st.title || '').trim() === (p.title || '').trim()) ctx.log(`标题：${p.title}`);
    else ctx.fail(`标题异常：期望「${p.title}」，页面上是「${st.title || '空'}」`);
    if ((st.len || 0) > 50) ctx.log(`正文：${st.len} 字（编辑器已注入）`);
    else ctx.fail(`正文异常：编辑器内容 ${st.len || 0} 字`);
  },

  // 自动发表：#js_send（发表，订阅号每天 1 次）→ 确认弹窗 → 等成功信号
  async submit(br, ctx) {
    const { clickSubmit } = await import('./common.js');
    return clickSubmit(br, ctx, {
      texts: ['发表'],
      successTexts: ['发表成功', '已发表', '发送成功'],
      confirmTexts: ['确定', '确认发送', '确定发送'],
      timeoutMs: 120000,
    });
  },

  // 保存为草稿（不占用每日 1 次发表额度，适合测试）
  async saveDraft(br, ctx) {
    const r = await br.click({ text: '保存为草稿' });
    if (!r) return { ok: false, detail: '找不到「保存为草稿」' };
    const end = Date.now() + 60000;
    while (Date.now() < end) {
      await sleep(2000);
      const t = await br.evaluate(`document.body.innerText`).catch(() => '');
      if (/保存成功|已保存/.test(t)) return { ok: true, detail: '草稿已保存' };
      try { await br.click({ text: '确定' }); } catch {}
    }
    return { ok: false, detail: '保存后未见成功提示' };
  },
};
