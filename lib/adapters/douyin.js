// 抖音上传页填写。与 publisher lib/platforms/douyin.js（Apache-2.0）同序同校验，原语换 bsk 桥。
// 话题联想只认真实点击——bsk click 就是真实输入事件，天然满足。
import { sleep } from '../bsk.js';
import { checkTitle, typeText, pickTopics, bodyText } from './common.js';

const TITLE = 'input[placeholder="填写作品标题，为作品获得更多流量"]';
const EDITOR = '.editor-kit-container[contenteditable=true]';
// 封面弹窗里「上传封面」那个输入框（同一弹窗里还有「生成参考图」的输入框，别传错）
const COVER_INPUT = 'input.semi-upload-hidden-input';

// 定时发布：选「定时发布」，日期框输入「2026-11-05 18:00」，Esc 收起日历
async function schedule(br, ctx, s) {
  const IN = '[class*=schedule-part] input.semi-input';
  if (!await br.click({ text: '定时发布' })) { ctx.fail('找不到定时发布的选项'); return; }
  if (!await br.waitFor(IN, 5000)) { ctx.fail('定时发布的时间框没出现'); return; }
  await br.fill(IN, s.text);
  await sleep(300);
  await br.press('Enter', IN);
  await sleep(300);
  await br.press('Escape', IN);
  await sleep(300);
  const got = await br.inputValue(IN).catch(() => '');
  if (got === s.text) ctx.log(`定时发布：${got}`);
  else ctx.fail(`定时没设对：页面上是「${got}」，应该是「${s.text}」`);
}

export default {
  id: 'douyin',
  name: '抖音',
  url: 'https://creator.douyin.com/creator-micro/content/upload',
  ready: 'input[type=file]',

  async fill(br, ctx) {
    const { p } = ctx;
    // 抖音上传：click「点击上传」（组件创建 input）→ evaluate+本地文件桥直塞 input.files（CDP setFileInputFiles
    // 被组件拒，页面 JS fetch 字节构造 File 完全合法）→ 轮询结果。失败兜底手动拖拽。
    try {
      await br.click({ text: '点击上传' });
      await sleep(2000);
      await br.uploadViaEvaluate(ctx.video);
      await br.readUploadResult({ timeoutMs: 120000 });
      ctx.log('视频开始上传（evaluate 通道）');
    } catch (e) {
      ctx.note(`自动上传没成功（${e.message.slice(0, 70)}）：请把视频拖进「点击上传」区域，程序会自动接管`);
    }
    if (!await br.waitFor(TITLE, 120000)) throw new Error('上传后没有出现作品表单（等待手动拖拽超时）');
    ctx.log('作品表单已出现，接管填写');
    await sleep(1200);

    await br.fill(TITLE, p.title);
    await sleep(200);
    await checkTitle(br, ctx, TITLE, p.title);

    // 正文与话题：内容可能不在 VOM（微前端层），走 evaluate 直写 + 联想点击
    await typeText(br, ctx, EDITOR, p.body);
    if (p.topics && p.topics.length) {
      await br.press('Enter', EDITOR);
      const picked = await pickTopics(br, ctx, EDITOR, p.topics, { suggestText: '推荐话题' });
      ctx.log(`话题：${picked.join('、') || '无'}`);
    }
    ctx.log(`简介：${p.body.length} 字`);

    // 封面：横 4:3、竖 3:4 在同一个弹窗的两个页签里
    const h = ctx.cover('4x3'), v = ctx.cover('3x4');
    if (h || v) {
      if (!await br.click({ text: '选择封面' })) throw new Error('找不到「选择封面」');
      if (!await br.waitFor(COVER_INPUT, 15000)) throw new Error('封面弹窗没有打开');
      await sleep(1200);
      if (h) { await br.upload({ text: '上传封面' }, h); await sleep(2000); ctx.log('横封面：4:3'); }
      if (v) {
        await br.click({ text: '设置竖封面' }); await sleep(1200);
        await br.upload({ text: '上传封面' }, v); await sleep(2000); ctx.log('竖封面：3:4');
      }
      if (!await br.click({ text: '完成' })) throw new Error('封面弹窗里找不到「完成」');
      await sleep(1200);
    }
    if (ctx.schedule) await schedule(br, ctx, ctx.schedule);
  },

  async uploadDone(br) {
    const t = await bodyText(br);
    return !t.includes('上传过程中');
  },

  links: {
    url: 'https://creator.douyin.com/creator-micro/content/manage',
    ready: 'video-card',
  },
};
