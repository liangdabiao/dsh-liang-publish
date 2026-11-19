// 适配器单测：四平台填写在 mock 页面上跑，验证填写顺序、读回校验、状态转移。
process.env.BSK_MODE = 'mock';   // 必须在任何 createBridge 之前（import 提升不影响：bsk.js 在调用时才读）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBridge, registerMockPages } from '../lib/bsk.js';
import { bjTime } from '../lib/adapters/common.js';
import { bilibiliPage, xhsPage, douyinPage, channelsPage, SCHED } from './mocks.mjs';
import bilibili from '../lib/adapters/bilibili.js';
import xhs from '../lib/adapters/xhs.js';
import douyin from '../lib/adapters/douyin.js';
import channels from '../lib/adapters/channels.js';

const pad = (n) => String(n).padStart(2, '0');
const SCHEDULE_ISO = `${SCHED.y}-${pad(SCHED.m)}-${pad(SCHED.d)}T${pad(SCHED.hh)}:${pad(SCHED.mm)}:00+08:00`;

function ctxFor(p, scheduleIso) {
  const ctx = {
    p, video: 'D:/视频导出/系列/成片.mp4',
    cover: (k) => `D:/视频导出/系列/封面/cover-${k}.png`,
    logs: [], failed: false,
    log: (m) => ctx.logs.push(['ok', m]),
    note: (m) => ctx.logs.push(['info', m]),
    fail: (m) => { ctx.failed = true; ctx.logs.push(['err', m]); },
    schedule: scheduleIso ? bjTime(scheduleIso) : null,
  };
  return ctx;
}
const errs = (ctx) => ctx.logs.filter(l => l[0] === 'err').map(l => l[1]).join('；');

test('B站：填写标题/简介/标签/分区/定时，读回全部通过', async () => {
  const br = createBridge({ pages: { [bilibili.url]: bilibiliPage } });
  await br.open(bilibili.url);
  const ctx = ctxFor({ title: '测试标题一二三', desc: '这是简介', tags: ['梁工学AI', 'Agent'], category: '人工智能' }, SCHEDULE_ISO);
  await bilibili.fill(br, ctx);
  const st = br.page.state;
  assert.equal(st.title, '测试标题一二三');
  assert.equal(st.desc, '这是简介');
  assert.deepEqual(st.tags, ['梁工学AI', 'Agent']);
  assert.equal(st.category, '人工智能');
  assert.equal(st.coverSet, true);
  assert.equal(st.dateText, SCHED.ymd);
  assert.equal(st.hh, SCHED.hh);
  assert.equal(st.mm, SCHED.mm);
  assert.equal(ctx.failed, false, `不应有 fail：${errs(ctx)}`);
  assert.equal(await bilibili.uploadDone(br), true);
  await br.close();
});

test('小红书：标题/正文/话题/定时/补封面', async () => {
  const br = createBridge({ pages: { [xhs.url]: xhsPage } });
  await br.open(xhs.url);
  const ctx = ctxFor({ title: '小红书标题试试', body: '第一段正文\n第二段正文', topics: ['话题甲', '话题乙'] }, SCHEDULE_ISO);
  await xhs.fill(br, ctx);
  const st = br.page.state;
  assert.equal(st.title, '小红书标题试试');
  assert.ok(st.body.includes('第一段正文') && st.body.includes('第二段正文'));
  assert.deepEqual(st.topics, ['话题甲', '话题乙']);
  assert.equal(st.schedText, SCHED.text);
  assert.equal(ctx.failed, false, `不应有 fail：${errs(ctx)}`);
  assert.equal(await xhs.uploadDone(br), true);
  await xhs.afterUpload(br, ctx);
  assert.equal(st.coverSet, true);
  await br.close();
});

test('抖音：标题/正文/话题真实点击/双封面/定时', async () => {
  const br = createBridge({ pages: { [douyin.url]: douyinPage } });
  await br.open(douyin.url);
  const ctx = ctxFor({ title: '抖音标题', body: '抖音正文', topics: ['话题丙'] }, SCHEDULE_ISO);
  await douyin.fill(br, ctx);
  const st = br.page.state;
  assert.equal(st.title, '抖音标题');
  assert.ok(st.body.includes('抖音正文'));
  assert.deepEqual(st.topics, ['话题丙']);
  assert.equal(st.coverH, true);
  assert.equal(st.coverV, true);
  assert.equal(st.schedText, SCHED.text);
  assert.equal(ctx.failed, false, `不应有 fail：${errs(ctx)}`);
  assert.equal(await douyin.uploadDone(br), true);
  await br.close();
});

test('视频号：文本锚点定位，短标题/描述/话题/定时/双封面', async () => {
  const br = createBridge({ pages: { [channels.url]: channelsPage } });
  await br.open(channels.url);
  const ctx = ctxFor({ shortTitle: '短标题测试用力', body: '描述第一行', topics: ['话题丁'] }, SCHEDULE_ISO);
  await channels.fill(br, ctx);
  const st = br.page.state;
  assert.equal(st.shortTitle, '短标题测试用力');
  assert.ok(st.body.includes('描述第一行'));
  assert.equal(st.dateText, SCHED.ymd);
  assert.equal(st.hh, SCHED.hh);
  assert.equal(st.mm, SCHED.mm);
  assert.equal(ctx.failed, false, `不应有 fail：${errs(ctx)}`);
  assert.equal(await channels.uploadDone(br), true);
  await channels.afterUpload(br, ctx);
  assert.equal(st.coverSet, true);
  await br.close();
});

test('标题读回不一致 → fail 标记（不中断后续步骤）', async () => {
  const pages = { [xhs.url]: xhsPage };
  const br = createBridge({ pages });
  await br.open(xhs.url);
  const ctx = ctxFor({ title: '想要的标题', body: '正文', topics: [] }, null);
  const origFill = br.fill.bind(br);
  br.fill = async (target, value, opts) => {
    const r = await origFill(target, value, opts);
    const el = br.findEl(target);
    if (el && el.kind === 'input' && el.field === 'title') br.page.state.title = '被平台改掉的标题';
    return r;
  };
  await xhs.fill(br, ctx);
  assert.equal(ctx.failed, true);
  assert.ok(ctx.logs.some(l => l[0] === 'err' && l[1].includes('标题异常')), `应有标题异常：${JSON.stringify(ctx.logs)}`);
  await br.close();
});
