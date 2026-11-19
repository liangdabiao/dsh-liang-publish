// 小红书上传页填写。与 publisher lib/platforms/xhs.js（Apache-2.0）同序同校验，原语换 bsk 桥。
import { sleep } from '../bsk.js';
import { checkTitle, typeText, pickTopics, bodyText } from './common.js';

const TITLE = 'input[placeholder="填写标题会有更多赞哦"]';
const EDITOR = '.tiptap.ProseMirror';

// 定时发布：打开开关，在日期框里直接输入「2026-11-05 18:00」
async function schedule(br, ctx, s) {
  const SW = '.post-time-switch-container .d-switch-simulator';
  const IN = '.post-time-wrapper .d-datepicker-input-filter input';
  if (!await br.waitFor(SW, 5000)) { ctx.fail('找不到定时发布开关'); return; }
  await br.click({ sel: SW });
  if (!await br.waitFor(IN, 5000)) { ctx.fail('定时发布的时间框没出现'); return; }
  await br.fill(IN, s.text);
  await br.press('Enter', IN);
  await sleep(400);
  const got = await br.inputValue(IN).catch(() => '');
  if (got === s.text) ctx.log(`定时发布：${got}`);
  else ctx.fail(`定时没设对：页面上是「${got}」，应该是「${s.text}」`);
}

export default {
  id: 'xhs',
  name: '小红书',
  url: 'https://creator.xiaohongshu.com/publish/publish?source=official&target=video',
  ready: 'input[type=file]',

  async fill(br, ctx) {
    const { p } = ctx;
    // 小红书上传组件用 File System Access API，CDP 注入不了文件：自动尝试一次，失败引导手动拖拽，
    // 表单一出现（无论自动还是手动）立即接管填写。
    try {
      await br.upload({ text: '上传视频', after: '拖拽视频到此或点击上传' }, ctx.video);
      ctx.log('视频开始上传');
    } catch (e) {
      ctx.note(`自动上传没成功（${e.message.slice(0, 80)}）：请把视频拖进「拖拽视频到此或点击上传」区域，程序会自动接管`);
    }
    if (!await br.waitFor(TITLE, 120000)) throw new Error('上传后没有出现笔记表单（等待手动拖拽超时）');
    ctx.log('笔记表单已出现，接管填写');
    await sleep(1200);
    await br.click({ text: '我知道了' });   // 「PK 封面」引导弹窗，有就关掉

    await br.fill(TITLE, p.title);
    await sleep(200);
    await checkTitle(br, ctx, TITLE, p.title);

    await typeText(br, ctx, EDITOR, p.body);
    if (p.topics && p.topics.length) {
      await br.press('Enter', EDITOR); await br.press('Enter', EDITOR);
      const picked = await pickTopics(br, ctx, EDITOR, p.topics);
      ctx.log(`话题：${picked.join('、') || '无'}`);
    }
    const len = (await br.text({ sel: EDITOR }).catch(() => '')).length;
    ctx.log(`正文：${p.body.length} 字${len ? `（编辑器 ${len}）` : ''}`);
    if (ctx.schedule) await schedule(br, ctx, ctx.schedule);
    ctx.note('封面要等视频上传完才能设置，传完会自动补上');
  },

  async uploadDone(br) {
    const t = await bodyText(br);
    return !t.includes('上传中') && !t.includes('取消上传') && t.includes('封面');
  },

  // 视频传完后：悬停封面 → 编辑封面 → 上传 3:4 → 裁剪比例 3:4 → 完成
  async afterUpload(br, ctx) {
    const cover = ctx.cover('3x4');
    if (!cover) return;
    await br.hover({ sel: '.cover .default' });
    await sleep(500);
    if (!await br.click({ sel: '.cover-edit-entry-text' })) throw new Error('找不到「编辑封面」');
    const IMG = 'input[type=file][accept*="image"]';
    if (!await br.waitFor(IMG, 20000)) throw new Error('封面编辑器没有打开');
    await sleep(1200);
    await br.upload(IMG, cover);
    await sleep(2500);
    await br.click({ text: '裁剪' }); await sleep(800);
    await br.click({ text: '3:4' }); await sleep(1000);
    if (!await br.click({ text: '完成' })) throw new Error('封面编辑器里找不到「完成」');
    await sleep(1500);
    const ok = (await bodyText(br)).includes('封面效果评估通过');
    ctx.log(`封面：3:4${ok ? '（平台评估通过）' : ''}`);
  },

  links: {
    url: 'https://creator.xiaohongshu.com/new/note-manager',
    ready: 'note-card',
  },
};
