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
    await br.upload({ text: '上传视频' }, ctx.video).catch(async () => { await br.upload('input[type=file]', ctx.video); });   // ⚠️校准：shadow 里上传入口的真实文本
    ctx.log('视频开始上传');
    // shadow 里表单就绪的信号：短标题输入框的 placeholder 出现在快照里
    let ready = false;
    for (let i = 0; i < 30 && !ready; i++) { await sleep(1000); ready = !!(await br.findNth({ text: P_SHORT }, 1)); }
    if (!ready) throw new Error('上传后没有出现表单（快照里找不到短标题输入框）');
    await sleep(1200);

    const shortBox = await shadow(br, P_SHORT);
    await br.fill(shortBox, p.shortTitle);
    await sleep(200);
    await checkTitle(br, ctx, shortBox, p.shortTitle, '短标题');

    // 描述编辑器：placeholder 不可靠，用「输入描述」文案锚（⚠️校准）
    const editor = (await shadow(br, '输入描述').catch(() => null)) || (await shadow(br, P_SHORT));
    await typeText(br, ctx, editor, p.body);
    // 话题直接输入「#话题 」就会高亮，不用选联想
    if (p.topics && p.topics.length) {
      await br.press('Enter', editor);
      for (const t of p.topics) { await br.fill(editor, '#' + t + ' ', { append: true }); await sleep(300); }
      const got = (await br.text({ sel: 'body' }).catch(() => '')).match(/#[^\s#]+/g) || [];
      ctx.log(`话题：${got.slice(0, p.topics.length).join(' ')}`);
    }
    ctx.log(`描述：${p.body.length} 字`);
    if (ctx.schedule) await schedule(br, ctx, ctx.schedule);
    ctx.note('封面要等视频上传完才能设置，传完会自动补上');
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
