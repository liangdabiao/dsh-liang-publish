// 适配器共用小工具。移植自 publisher lib/platforms/common.js（Apache-2.0）， evaluate 版改 bsk 桥版。
import { sleep } from '../bsk.js';

// 读回输入框值，和期望不一致就标记失败（不中断，跑完统一「异常」）
export async function checkTitle(br, ctx, target, expected, label = '标题') {
  const got = await br.inputValue(target).catch(() => '');
  if ((got || '').trim() !== expected.trim()) ctx.fail(`${label}异常：期望「${expected}」，页面上是「${got || '空'}」`);
  else ctx.log(`${label}：${expected}`);
}

// 富文本编辑器逐行输入：首行 fill，后续行「回车 + 追加」，保留分段
export async function typeText(br, ctx, target, text) {
  const lines = String(text || '').split('\n');
  if (!lines.length) return;
  await br.fill(target, lines[0]);
  for (let i = 1; i < lines.length; i++) {
    await br.press('Enter', target);
    await sleep(150);
    if (lines[i]) await br.fill(target, lines[i], { append: true });
  }
}

// 输入「#话题」，从联想列表里点「完全同名」的那一项；没有同名就保留成普通文字并记提示。
// douyin 的联想项只认真实点击（bsk click 本来就是真实输入事件，天然满足）。
// 联想弹层在 DOM 主体之后渲染（aria snapshot 同序），所以同文本多匹配时取最后一个。
export async function pickTopics(br, ctx, editor, topics, { suggestText } = {}) {
  const picked = [], plain = [];
  for (const t of topics) {
    await br.fill(editor, '#' + t, { append: true });
    // 联想列表会滞后刷新：等到出现同名项，最多 4 秒
    let ref = null;
    for (let i = 0; i < 8 && !ref; i++) {
      await sleep(500);
      const refs = await br.findAll({ text: '#' + t, ...(suggestText ? { after: suggestText } : {}) });
      ref = refs[refs.length - 1] || null;   // 弹层在主体后：取最后一个匹配
    }
    let ok = false;
    if (ref) { try { ok = await br.click({ ref }); } catch { ok = false; } }
    if (ok) picked.push(t);
    else { plain.push(t); await br.fill(editor, ' ', { append: true }); }
    await sleep(300);
  }
  if (plain.length) ctx.note(`没有同名话题，保留为普通文字：${plain.join('、')}`);
  return picked;
}

// 定时发布时间（ISO，带时区）→ 北京时间的各个字段
export function bjTime(iso) {
  const d = new Date(Date.parse(iso) + 8 * 3600e3);
  const p = (n) => String(n).padStart(2, '0');
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1, day = d.getUTCDate(), hh = d.getUTCHours(), mm = d.getUTCMinutes();
  return { y, m, d: day, hh, mm, ymd: `${y}-${p(m)}-${p(day)}`, hm: `${p(hh)}:${p(mm)}`, text: `${y}-${p(m)}-${p(day)} ${p(hh)}:${p(mm)}` };
}

// 页面全文（剥标签后的可见文本），用于「页面上有没有 XX 字样」类判断
export async function bodyText(br) {
  return br.text({ sel: 'body' }).catch(() => '');
}

// 自动点发布（用户明确授权 autoPublish 时）：点发布按钮 → 等成功信号 → 有确认弹窗就点确认。
// texts 用 exact 全等匹配（避免撞侧边栏「发布视频」这类菜单项）；成功信号按平台给。
export async function clickSubmit(br, ctx, { texts, successTexts, confirmTexts = ['确定', '确认'], timeoutMs = 120000 } = {}) {
  let clicked = null;
  for (const t of texts) {
    if (await br.click({ text: t, exact: true })) { clicked = t; break; }
  }
  if (!clicked) return { ok: false, detail: `找不到发布按钮（${texts.join('/')}）` };
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    await sleep(2000);
    await br.sync().catch(() => {});
    const t = await bodyText(br).catch(() => '');
    if (successTexts.some(s => t.includes(s))) return { ok: true, detail: t.match(new RegExp(successTexts.join('|')))?.[0] || '' };
    for (const c of confirmTexts) {
      try { if (await br.click({ text: c, exact: true })) break; } catch { /* 没有弹窗 */ }
    }
  }
  return { ok: false, detail: `点了「${clicked}」但 ${Math.round(timeoutMs / 1000)}s 内没看到成功提示（可能仍在平台审核/转码），请去作品管理页确认` };
}
