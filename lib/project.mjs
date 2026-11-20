// 发布工程：发布素材 md → publish.json → 校验。
// 移植自 mdldm-maitian src/make-publish.mjs + src/validate.mjs（MIT）/ publisher tools/make-publish.mjs（Apache-2.0）。
// md 约定（见 skills/liang-publish/SKILL.md）：
//   头部：「> 序号：31」「> 定时发布：2026-11-05 18:00」
//   ## 二、B站     **标题：** / **简介：** / **标签：**（#标签 空格分隔）
//   ## 三、小红书   **标题：** / **正文：**（正文最后一行是 #话题）
//   ## 四、抖音     **标题：** / **正文：**
//   ## 五、视频号   **短标题：** / **描述：**
// 工程目录里：成片.mp4、封面/cover-3x4.png、cover-4x3.png（有哪个用哪个）
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { validate, PLATFORMS, len } from './vendor/bundle.mjs';

const clean = (s) => s.split('\n').map(l => l.replace(/\s+$/, '')).join('\n').trim();

// 按「## 一、xxx」切节，节名去掉序号
function sections(md) {
  const out = {};
  md.split(/\n(?=## )/).forEach(chunk => {
    const m = chunk.match(/^## (?:[一二三四五六七八九十〇]+、)?(.+)\n/);
    if (m) out[m[1].trim()] = chunk.slice(m[0].length).replace(/\n---\s*$/, '').trim();
  });
  return out;
}
const pickSec = (secs, name) => {
  const k = Object.keys(secs).find(x => x.startsWith(name));
  return k ? secs[k] : null;
};
// 取 **标签：** 后到下一个 **xx：** 之前的内容
function field(text, label) {
  const re = new RegExp(`\\*\\*${label}：\\*\\*[^\\n]*\\n([\\s\\S]*?)(?=\\n\\*\\*[^*\\n]+：\\*\\*|$)`);
  const m = text.match(re);
  return m ? clean(m[1]) : null;
}
const hashTags = (line) => (line.match(/#[^\s#]+/g) || []).map(t => t.slice(1));
// 正文最后一行如果全是 #话题，拆出来
function splitTopics(body) {
  const lines = body.split('\n');
  const last = lines[lines.length - 1].trim();
  if (last && last.split(/\s+/).every(w => w.startsWith('#'))) return { body: clean(lines.slice(0, -1).join('\n')), topics: hashTags(last) };
  return { body, topics: [] };
}

// moov 必须在文件头，否则小红书报「无视频流信息」、抖音不出表单
export function isFaststart(file) {
  try {
    const fd = openSync(file, 'r'); const buf = Buffer.alloc(1 << 16); readSync(fd, buf, 0, buf.length, 0); closeSync(fd);
    let off = 0, first = null;
    while (off + 8 <= buf.length) {
      const size = buf.readUInt32BE(off), type = buf.toString('latin1', off + 4, off + 8);
      if (type === 'moov' || type === 'mdat') { first = type; break; }
      if (size < 8) break;
      off += size;
    }
    return first !== 'mdat';
  } catch { return true; }   // 读不了就不拦，交给平台
}

export function listProjectFiles(dir) {
  const files = new Set();
  const walk = (d) => readdirSync(d).forEach(n => { const p = join(d, n); statSync(p).isDirectory() ? walk(p) : files.add(relative(dir, p).replace(/\\/g, '/')); });
  walk(dir);
  return files;
}

// 发布素材 md → publish.json，写进工程目录并校验。opts: { requireTag, schedule }
export function buildProject(mdPath, dir, opts = {}) {
  const md = readFileSync(mdPath, 'utf8').replace(/\r\n/g, '\n');
  const secs = sections(md);
  const header = (k) => { const m = md.match(new RegExp(`^> ${k}：\\s*(.+?)\\s*$`, 'm')); return m ? m[1] : null; };
  const title = (md.match(/^# (.+)$/m) || [])[1] || basename(dir);
  const episode = +(header('序号') || 0) || undefined;

  let schedule = opts.schedule || header('定时发布');
  if (schedule && !/T/.test(schedule)) schedule = schedule.trim().replace(' ', 'T') + ':00+08:00';

  const files = listProjectFiles(dir);
  const video = files.has('成片.mp4') ? '成片.mp4' : null;
  const covers = {};
  for (const [k, n] of [['3x4', 'cover-3x4.png'], ['4x3', 'cover-4x3.png'], ['16x9', 'cover-16x9.jpg']]) if (files.has(`封面/${n}`)) covers[k] = `封面/${n}`;
  const has = (k) => !!covers[k];
  const pick = (...ks) => ks.filter(has);

  const platforms = {};
  let s;
  if ((s = pickSec(secs, 'B站'))) platforms.bilibili = { covers: pick('4x3'), title: field(s, '标题'), desc: field(s, '简介'), tags: hashTags(field(s, '标签') || '') };
  if ((s = pickSec(secs, '小红书'))) { const b = splitTopics(field(s, '正文') || ''); platforms.xhs = { covers: pick('3x4'), title: field(s, '标题'), body: b.body, topics: b.topics }; }
  if ((s = pickSec(secs, '抖音'))) { const b = splitTopics(field(s, '正文') || ''); platforms.douyin = { covers: pick('4x3', '3x4'), title: field(s, '标题'), body: b.body, topics: b.topics }; }
  if ((s = pickSec(secs, '视频号'))) { const b = splitTopics(field(s, '描述') || ''); platforms.channels = { covers: pick('4x3', '3x4'), shortTitle: field(s, '短标题'), body: b.body, topics: b.topics }; }

  // 成片时长（秒）：有 ffprobe 就读出来
  let durationSec;
  if (video) {
    try { durationSec = Math.round(+execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', join(dir, video)]).toString().trim()); } catch { /* 没装 ffprobe */ }
  }

  const out = {
    version: 1,
    id: basename(dir),
    ...(episode ? { episode } : {}),
    name: title,
    video,
    ...(durationSec ? { durationSec } : {}),
    ...(files.has('字幕.srt') ? { subtitle: '字幕.srt' } : {}),
    requiredTags: opts.requireTag ? [opts.requireTag] : [],
    ...(schedule ? { schedule } : {}),
    covers,
    platforms,
  };
  // 重新生成时保留手动加的 skip（比如某平台这期不发）
  const target = join(dir, 'publish.json');
  if (existsSync(target)) {
    try {
      const old = JSON.parse(readFileSync(target, 'utf8'));
      for (const [k, p] of Object.entries(old.platforms || {})) if (p.skip && out.platforms[k]) out.platforms[k].skip = p.skip;
    } catch { /* 旧文件坏了就不管 */ }
  }
  writeFileSync(target, JSON.stringify(out, null, 2) + '\n');
  return { project: out, files, ...validateProjectData(out, dir, files) };
}

export function validateProjectData(b, dir, filesArg = null) {
  // 文章工程：轻校验（标题/正文），不走视频规则
  if (b.type === 'article') {
    const errors = [], warnings = [];
    const p = (b.platforms || {}).bilibili || {};
    if (!p.title || !p.title.trim()) errors.push('缺少文章标题');
    if (!p.content || !p.content.trim()) errors.push('缺少文章正文');
    if (p.title && p.title.length > 40) errors.push(`标题 ${p.title.length} 字，B站专栏建议 30 字以内、上限 40 字`);
    const lines = [`文章工程：${b.name}（${b.id}）`, `  B站专栏：标题 ${(p.title || '').length}/40，正文 ${(p.content || '').length} 字（markdown→HTML 自动转换）`];
    const wx = (b.platforms || {}).weixin;
    if (wx) lines.push(`  微信公众号：标题 ${(wx.title || '').length}/64，正文 ${(wx.content || '').length} 字（UEditor）`);
    warnings.forEach(w => lines.push(`⚠️  ${w}`));
    errors.forEach(e => lines.push(`❌ ${e}`));
    lines.push(errors.length ? `校验未通过：${errors.length} 个问题` : '✅ 校验通过');
    return { ok: !errors.length, errors, warnings, text: lines.join('\n') };
  }
  const files = filesArg || listProjectFiles(dir);
  const { errors, warnings } = validate(b, files);
  if (dir && b.video && files.has(b.video) && !isFaststart(join(dir, b.video))) {
    errors.push(`成片 ${b.video} 不是 faststart（moov 在文件尾），用 ffmpeg -c copy -movflags +faststart 重新封装`);
  }
  const lines = [`工程：${b.name}（${b.id}）`];
  for (const [id, p] of Object.entries(b.platforms || {})) {
    const spec = PLATFORMS[id]; if (!spec || p.skip) continue;
    lines.push(`  ${spec.name}：${Object.keys(spec.fields).map(k => `${k} ${len(p[k])}/${spec.fields[k][1]}`).join('，')}；封面 ${(p.covers || []).join('+') || '无'}`);
  }
  warnings.forEach(w => lines.push(`⚠️  ${w}`));
  errors.forEach(e => lines.push(`❌ ${e}`));
  lines.push(errors.length ? `校验未通过：${errors.length} 个问题` : '✅ 校验通过');
  return { ok: !errors.length, errors, warnings, text: lines.join('\n') };
}

// 校验工程目录里已有的 publish.json
export function validateProject(dir) {
  const b = JSON.parse(readFileSync(join(dir, 'publish.json'), 'utf8'));
  return validateProjectData(b, dir);
}

export const loadProject = (dir) => JSON.parse(readFileSync(join(dir, 'publish.json'), 'utf8'));

// ─── 文章工程：markdown 文件 → 文章 publish.json（type=article，B站专栏）───
// 文章 = markdown 文件本身（标题 = 第一个 # 行，正文 = 其余全部）。
// 平台：B站专栏（唯一真文章平台；xhs/douyin 图文属视频配套，v2）。
import { mdTitleBody } from './md2html.mjs';

export function buildArticleProject(mdPath, dir) {
  const md = readFileSync(mdPath, 'utf8').replace(/\r\n/g, '\n');
  const { title, body } = mdTitleBody(md);
  if (!title) throw new Error('文章没有一级标题（第一行 # 标题）');
  const name = title.slice(0, 80);
  // 文章副本进工程目录（作为存档与后续 sync 依据）
  const articleName = '文章.md';
  writeFileSync(join(dir, articleName), md, 'utf8');

  const files = listProjectFiles(dir);
  const out = {
    version: 1,
    type: 'article',
    id: basename(dir),
    name,
    article: articleName,
    platforms: {
      bilibili: { title: title.slice(0, 40), content: body },
      weixin: { title: title.slice(0, 64), author: '', content: body },
    },
  };
  writeFileSync(join(dir, 'publish.json'), JSON.stringify(out, null, 2) + '\n');
  const lines = [`文章工程：${name}（${out.id}）`, `  B站专栏：标题 ${title.length}/40，正文 ${body.length} 字（markdown→HTML 自动转换）`];
  return { project: out, files, ok: true, errors: [], warnings: [], text: lines.join('\n') };
}
