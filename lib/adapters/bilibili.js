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
    // B站会记住上次未提交的视频并弹「继续编辑 / 不用了」遮罩：点「继续编辑」直接复用已传视频。
    // 上传走 evaluate 直塞隐藏 input（chooser 按钮会被弹窗/遮罩挡成 pointer covered）。
    await br.sync().catch(() => {});
    if (await br.findNth({ text: '继续编辑' }, 1)) {
      await br.click({ text: '继续编辑' });
      ctx.log('检测到未提交的视频，已复用继续编辑');
    } else {
      let upOk = false;
      try {
        await br.uploadViaEvaluate(ctx.video);
        await br.readUploadResult({ timeoutMs: 90000 });
        upOk = true;
        ctx.log('视频开始上传（evaluate 通道）');
      } catch (e) {
        ctx.note(`evaluate 直塞没成（${e.message.slice(0, 60)}），试 chooser 通道`);
      }
      if (!upOk) {
        try {
          await br.upload({ text: '选择文件' }, ctx.video);
          upOk = true;
          ctx.log('视频开始上传（chooser 通道）');
        } catch (e) {
          if (/uncertain|unknown/i.test(e.message)) {
            ctx.note('上传结果未确认（bsk uncertain），观察页面判断');
            if (!await br.waitFor('input[placeholder="请输入稿件标题"]', 30000)) throw e;
            ctx.log('稿件表单已出现，确认上传已触发');
          } else { throw e; }
        }
      }
    }
    if (!await br.waitFor(TITLE, 30000)) throw new Error('上传后没有出现稿件表单');
    await sleep(1200);

    const cover = ctx.cover('4x3');
    if (cover) await setCover(br, ctx, cover);

    await br.fill(TITLE, p.title);
    await sleep(200);
    await checkTitle(br, ctx, TITLE, p.title);

    // 简介：Quill 富文本在 micro-app 里，VOM 里简介框 = heading「简介」后第一个元素（有内容时行名就是内容本身）
    if (p.desc) {
      await br.sync().catch(() => {});
      const descRef = await br.findNth({ after: '简介' }, 1);
      if (!descRef) ctx.fail('简介编辑器没找到，简介没有填');
      else {
        await br.fill({ ref: descRef }, p.desc);
        ctx.log(`简介：${p.desc.length} 字`);
      }
    }

    // 标签：逐个输入 + 回车；B 站拒收的（和活动标签冲突等）看 VOM 里没出现就跳过
    for (const t of p.tags || []) {
      await br.fill(TAG_INPUT, t);
      await sleep(300);
      await br.press('Enter', TAG_INPUT);
      await sleep(800);
      await br.sync().catch(() => {});
      const inVom = br.vomText.includes(`"${t}"`);
      if (!inVom) {
        ctx.note(`B 站可能拒收标签「${t}」，提交前请看一眼标签区`);
        await br.fill(TAG_INPUT, '');
      }
    }
    ctx.log(`标签已输入：${(p.tags || []).join('、')}`);

    // 分区：控件在 micro-app 不可见层（VOM 里只有 heading），best-effort 尝试，失败降级人工确认
    const cat = p.category || '人工智能';
    await br.sync().catch(() => {});
    const catRef = await br.findNth({ after: '分区' }, 1);
    let catOk = false;
    if (catRef) {
      try {
        await br.click({ ref: catRef }); await sleep(800);
        await br.sync().catch(() => {});
        catOk = await br.click({ text: cat });
      } catch { catOk = false; }
    }
    if (catOk) { await sleep(600); ctx.log(`分区：${cat}`); }
    else ctx.note(`分区没自动选成「${cat}」，请提交前手动确认分区`);

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
