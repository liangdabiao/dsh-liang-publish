// 发布工程（make-publish + 校验）单测：md 解析、字段校验、faststart、skip 保留。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildProject, validateProjectData } from '../lib/project.mjs';

const MD = `# AI 实战 · 第 12 期｜用 Agent 自动整理资料

> 序号：12
> 定时发布：${new Date(Date.now() + 3 * 3600e3 + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')}

## 二、B站
**标题：**
用 Agent 自动整理资料，效率翻十倍
**简介：**
这期演示怎么用 Agent 把散落的资料自动整理成文档。
**标签：**
#梁工学AI #Agent #效率工具

## 三、小红书
**标题：**
Agent 整理资料真的绝了
**正文：**
这周把资料整理全交给 Agent 了。
踩坑两个，分享给大家。
#梁工学AI #Agent

## 四、抖音
**标题：**
一条指令整理全部资料
**正文：**
资料乱成一锅粥？交给 Agent。
#梁工学AI #Agent

## 五、视频号
**短标题：**
Agent 整理资料真香
**描述：**
这期演示 Agent 整理资料的全过程。
#梁工学AI #Agent
`;

function makeProjectFiles(dir) {
  writeFileSync(join(dir, '成片.mp4'), Buffer.from('ffff'));
  mkdirSync(join(dir, '封面'), { recursive: true });
  writeFileSync(join(dir, '封面', 'cover-3x4.png'), 'x');
  writeFileSync(join(dir, '封面', 'cover-4x3.png'), 'x');
  writeFileSync(join(dir, '发布素材.md'), MD);
}

test('buildProject：md → publish.json 字段齐全', () => {
  const dir = mkdtempSync(join(tmpdir(), 'liang-proj-'));
  try {
    makeProjectFiles(dir);
    const { project, ok, errors } = buildProject(join(dir, '发布素材.md'), dir);
    assert.equal(project.version, 1);
    assert.equal(project.id, dir.split(/[\\/]/).pop());
    assert.equal(project.episode, 12);
    assert.equal(project.name.includes('Agent 自动整理资料'), true);
    const pad = (n) => String(n).padStart(2, '0');
    const d = new Date(Date.now() + 3 * 3600e3 + 8 * 3600e3);
    const wantSched = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00+08:00`;
    assert.equal(project.schedule, wantSched);
    assert.equal(project.video, '成片.mp4');
    assert.deepEqual(project.covers, { '3x4': '封面/cover-3x4.png', '4x3': '封面/cover-4x3.png' });
    assert.equal(project.platforms.bilibili.title, '用 Agent 自动整理资料，效率翻十倍');
    assert.deepEqual(project.platforms.bilibili.tags, ['梁工学AI', 'Agent', '效率工具']);
    assert.equal(project.platforms.bilibili.covers.includes('4x3'), true);
    assert.deepEqual(project.platforms.xhs.topics, ['梁工学AI', 'Agent']);
    assert.ok(project.platforms.xhs.body.includes('踩坑两个'));
    assert.deepEqual(project.platforms.douyin.topics, ['梁工学AI', 'Agent']);
    assert.equal(project.platforms.channels.shortTitle, 'Agent 整理资料真香');
    assert.equal(ok, true, `应有错误：${errors.join('；')}`);
    const saved = JSON.parse(readFileSync(join(dir, 'publish.json'), 'utf8'));
    assert.equal(saved.platforms.channels.shortTitle, 'Agent 整理资料真香');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('buildProject：重新生成保留手动 skip', () => {
  const dir = mkdtempSync(join(tmpdir(), 'liang-skip-'));
  try {
    makeProjectFiles(dir);
    buildProject(join(dir, '发布素材.md'), dir);
    const pjFile = join(dir, 'publish.json');
    const pj = JSON.parse(readFileSync(pjFile, 'utf8'));
    pj.platforms.douyin.skip = '这期不发';
    writeFileSync(pjFile, JSON.stringify(pj));
    const { project } = buildProject(join(dir, '发布素材.md'), dir);
    assert.equal(project.platforms.douyin.skip, '这期不发');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('校验规则：超长标题、国内平台带链接、模型名、缺必带标签', () => {
  const b = {
    version: 1,
    video: '成片.mp4',
    requiredTags: ['梁工学AI'],
    covers: {},
    platforms: {
      bilibili: { title: 'x'.repeat(81), desc: 'ok', tags: ['别的'] },
      douyin: { title: '标题', body: '看 https://example.com 学 Claude' },
      xhs: { title: '标题', body: '评论区领资料' },
    },
  };
  const { errors } = validateProjectData(b, null, new Set(['成片.mp4']));
  const joined = errors.join('\n');
  assert.ok(joined.includes('B 站：title'), '应报超长标题');
  assert.ok(joined.includes('缺少「梁工学AI」标签'), '应报缺必带标签');
  assert.ok(joined.includes('抖音：正文里有链接'), '应报链接');
  assert.ok(joined.includes('模型/厂商名'), '应报模型名');
  assert.ok(joined.includes('小红书：正文在引流'), '应报引流');
});

test('faststart：moov 在文件尾要报错', () => {
  const dir = mkdtempSync(join(tmpdir(), 'liang-fast-'));
  try {
    // 手造一个 mdat 在前 moov 在后的最小 mp4 头
    const box = (type, payload) => {
      const head = Buffer.alloc(8);
      head.writeUInt32BE(8 + payload.length, 0);
      head.write(type, 4, 'latin1');
      return Buffer.concat([head, payload]);
    };
    writeFileSync(join(dir, '成片.mp4'), Buffer.concat([box('mdat', Buffer.alloc(64)), box('moov', Buffer.alloc(16))]));
    const b = { version: 1, video: '成片.mp4', platforms: {} };
    const { errors } = validateProjectData(b, dir, new Set(['成片.mp4']));
    assert.ok(errors.join('\n').includes('faststart'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
