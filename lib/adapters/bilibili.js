// B 站上传页填写。填写顺序与校验点和 mdldm-maitian-publisher lib/platforms/bilibili.js（Apache-2.0）保持一致，
// 操作原语从 evaluate 换成 bsk 桥。标注 ⚠️校准 的行依赖真机观察（bsk snapshot 的结构），验收时核对。
import { sleep } from '../bsk.js';
import { checkTitle, bjTime } from './common.js';

const TITLE = 'input[placeholder="请输入稿件标题"]';
const TAG_INPUT = 'input[placeholder="按回车键Enter创建标签"]';
const DESC = '.ql-editor[data-placeholder^="填写更全面"]';
const IMG_INPUT = 'input[type=file][accept*="image"]';
const COVER_SLOT = '.cover-module-main .cover-empty, .cover-module-main .cover-slot';
const TC = '.time-container';

async function setCover(br, ctx, file) {
  // 封面编辑器要渲染画布：后台标签页做不成，短暂把页面带到前台（bsk：activate 窗口由校准决定；
  // v1 直接尝试，失败给出人工提示）
  if (!await br.click({ sel: COVER_SLOT })) ctx.note('没找到封面空位，可能封面已设置');
  if (!await br.waitFor(IMG_INPUT, 15000)) { ctx.fail('封面弹窗没有打开'); return; }
  await sleep(800);
  await br.upload(IMG_INPUT, file);
  await sleep(3000);
  if (!await br.click({ text: '完成' })) { ctx.fail('封面编辑器里找不到「完成」'); return; }
  await sleep(1500);
  const ok = await br.html({ sel: '.cover-module-main' }).then(h => !h.includes('cover-empty')).catch(() => false);
  if (ok) ctx.log('封面：4:3（16:9 同步）');
  else ctx.fail('封面没设上，请手动上传 4:3 封面');
}

// 定时发布：打开开关 → 日历里点日期（跨月就翻页）→ 时间面板点小时、分钟
async function schedule(br, ctx, s) {
  await br.click({ sel: `${TC} .switch-container` });
  if (!await br.waitFor(`${TC} .date-picker-date`, 5000)) { ctx.fail('定时发布的开关没打开'); return; }
  const tz = await br.text({ sel: `${TC} .bcc-select-input-inner` }).catch(() => '');
  if (tz && !tz.includes('UTC+08:00')) ctx.note(`B 站定时的时区是「${tz}」，不是北京时间，请检查`);

  await br.click({ sel: `${TC} .date-picker-date` }); await sleep(400);
  const want = `${s.y}年${s.m}月`;
  for (let i = 0; i < 3; i++) {
    const title = await br.text({ sel: `${TC} .date-picker-nav-title` }).catch(() => '');
    if (title.trim() === want) break;
    await br.click({ sel: `${TC} .next-btn-day` }); await sleep(300);
  }
  if (!await br.click({ text: `${s.m}月${s.d}日` }) && !await br.click({ text: String(s.d) })) ctx.note(`日历里没找到 ${s.d} 号（可能跨月翻页失败），请手动设`);
  await sleep(300);

  await br.click({ sel: `${TC} .date-picker-timer` }); await sleep(400);
  // ⚠️校准：时间两列都是数字文本，用 exact 全等避免撞上页面其它数字
  const hours = await br.findAll({ text: String(s.hh).padStart(2, '0'), exact: true });
  if (hours[0]) { await br.click({ ref: hours[0] }); await sleep(300); }
  const minutes = await br.findAll({ text: String(s.mm).padStart(2, '0'), exact: true });
  if (minutes[0]) { await br.click({ ref: minutes[0] }); await sleep(300); }
  await br.click({ sel: `${TC} .date-picker-timer` }); await sleep(300);

  const got = await br.text({ sel: `${TC} .date-show` }).catch(() => '');
  if (got.replace(/\s+/g, ' ').includes(s.text.replace(/\s+/g, ' '))) ctx.log(`定时发布：${got}`);
  else ctx.fail(`定时没设对：页面上是「${got}」，应该是「${s.text}」`);
}

export default {
  id: 'bilibili',
  name: 'B 站',
  url: 'https://member.bilibili.com/platform/upload/video/frame',
  ready: '.bcc-upload-wrapper input[type=file]',

  async fill(br, ctx) {
    const { p } = ctx;
    // B站会记住上次未提交的视频并弹「继续编辑 / 不用了」遮罩：点「继续编辑」直接复用已传视频；
    // 没有「继续编辑」（首传）就走正常 upload。mutating 动作绝不重试（bsk 防重放报 uncertain）：
    // 一次 upload，outcome unknown 时用「稿件表单出现」确认是否已触发。
    await br.sync().catch(() => {});
    if (await br.findNth({ text: '继续编辑' }, 1)) {
      await br.click({ text: '继续编辑' });
      ctx.log('检测到未提交的视频，已复用继续编辑');
    } else {
      try {
        await br.upload({ text: '选择文件' }, ctx.video);
        ctx.log('视频开始上传');
      } catch (e) {
        if (/uncertain|unknown/i.test(e.message)) {
          ctx.note('上传结果未确认（bsk uncertain），观察页面判断');
          if (!await br.waitFor('input[placeholder="请输入稿件标题"]', 30000)) throw e;
          ctx.log('稿件表单已出现，确认上传已触发');
        } else { throw e; }
      }
    }
    if (!await br.waitFor(TITLE, 30000)) throw new Error('上传后没有出现稿件表单');
    await sleep(1200);

    const cover = ctx.cover('4x3');
    if (cover) await setCover(br, ctx, cover);

    await br.fill(TITLE, p.title);
    await sleep(200);
    await checkTitle(br, ctx, TITLE, p.title);

    // 简介：Quill 富文本（bsk fill 对 contenteditable 是整块替换）
    if (p.desc) {
      await br.fill(DESC, p.desc);
      const n = (await br.text({ sel: DESC }).catch(() => '')).length;
      ctx.log(`简介：${p.desc.length} 字${n ? `（编辑器 ${n}）` : ''}`);
    }

    // 标签：先删掉自动生成的（best-effort：真机上关闭按钮的 snapshot 形态要校准），再逐个输入；被拒收的直接跳过
    const closed = await br.clickAll({ sel: 'svg.close' }, { max: 12 }).catch(() => 0);
    if (!closed) ctx.note('自动生成的标签没能自动清理，请提交前看一眼标签区');
    for (const t of p.tags || []) {
      await br.fill(TAG_INPUT, t);
      await sleep(300);
      await br.press('Enter', TAG_INPUT);
      await sleep(600);
      const got = await br.html({ sel: '.tag-pre-wrp' }).catch(() => '');
      if (!got || !got.includes(t)) {
        ctx.note(`B 站拒收标签「${t}」，已跳过`);
        await br.fill(TAG_INPUT, '');
      }
    }
    const gotTags = (await br.html({ sel: '.tag-pre-wrp' }).catch(() => '') || '');
    ctx.log(`标签区：${gotTags.replace(/<[^>]+>/g, ' ').trim().slice(0, 120)}`);

    // 分区：固定「人工智能」，publish.json 可用 p.category 覆盖
    const cat = p.category || '人工智能';
    const cur = await br.text({ sel: '.video-human-type .select-item-cont' }).catch(() => '');
    if (cur.trim() !== cat) {
      await br.click({ sel: '.video-human-type .select-controller' }); await sleep(600);
      if (!await br.click({ text: cat })) ctx.note(`分区列表里没有「${cat}」，请手动选`);
      await sleep(600);
    }
    const gotCat = await br.text({ sel: '.video-human-type .select-item-cont' }).catch(() => '');
    if (gotCat.trim() === cat) ctx.log(`分区：${cat}`);
    else ctx.fail(`分区没选上：页面上是「${gotCat}」，应该是「${cat}」`);

    if (ctx.schedule) await schedule(br, ctx, ctx.schedule);
    ctx.note('还需要你选「创作声明」（必填）');
  },

  // 页面全文判断上传完成
  async uploadDone(br) {
    const t = await br.text({ sel: 'body' }).catch(() => '');
    return t.includes('上传完成');
  },

  // 发布后取链接：稿件管理页（collect 见 lib/collectors.js）
  links: {
    url: 'https://member.bilibili.com/platform/upload-manager/article',
    ready: 'member.bilibili.com',
  },
};
