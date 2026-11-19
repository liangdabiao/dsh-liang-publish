// 数据采集：作品管理页 DOM 读数（取链接、流量）+ 创作者后台（粉丝）。
// 原版（mdldm-maitian MIT / publisher Apache-2.0）走页面内 fetch/React fiber；bsk 桥没有 evaluate，
// 全部改为读页面文本/HTML 再解析。标注 ⚠️校准 的解析规则验收时对着真实页面核对。
import { sleep } from './bsk.js';
import { bodyText } from './adapters/common.js';

// "1.2万" "6,017" "5.3K" → 数字
export function num(s) {
  if (s == null) return null;
  s = String(s).replace(/,/g, '').trim();
  const m = s.match(/^([\d.]+)\s*(万|亿|K|M|w)?/i);
  if (!m) return null;
  const k = { '万': 1e4, 'w': 1e4, '亿': 1e8, 'k': 1e3, 'm': 1e6 }[(m[2] || '').toLowerCase()] || 1;
  return Math.round(parseFloat(m[1]) * k);
}
const strip = (h) => h.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

// ---------------------------------------------------------------------------
// 取链接：作品管理页找到这一期 → 状态 + 链接
// ---------------------------------------------------------------------------
export const linkReaders = {
  // ⚠️校准：稿件管理列表行里 BV 号的呈现形态（html 属性或链接）
  async bilibili(br, p) {
    const html = await br.html({ sel: '.sp-list-wrapper, .list-wrp, body' });
    const row = findRow(strip(html), html, p.title);
    if (!row) return null;
    const m = row.html.match(/BV([A-Za-z0-9]{10})/) || html.match(new RegExp(`${escape(p.title)}[\\s\\S]{0,600}?BV([A-Za-z0-9]{10})`));
    const bvid = m ? (m[1] || m[2]) : '';
    const sched = /定时发布|待发布/.test(row.text);
    return {
      status: sched ? '定时' : /审核/.test(row.text) ? '审核中' : /已发布|公开/.test(row.text) ? '已发布' : row.text.slice(0, 20),
      url: bvid ? `https://www.bilibili.com/video/BV${bvid}` : '',
      time: (row.text.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/) || [''])[0],
    };
  },
  // 笔记管理卡片埋着 noteId（data-impression）——纯 DOM 就能拿
  async xhs(br, p) {
    const html = await br.html({ sel: '.note-card, body' });
    const cards = html.split(/(?=<div[^>]*class="note-card[ "])/).filter(c => c.includes(p.title));
    if (!cards.length) return null;
    const c = cards[0];
    const id = (c.match(/noteId\\?"?\s*:\s*\\?"?([a-f0-9]{24})/) || (c.match(/data-impression="[^"]*noteId[^"]*"/) || []))[1] || (c.match(/([a-f0-9]{24})/g) || [])[0];
    const text = strip(c);
    const time = (text.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/) || [''])[0];
    return {
      status: /定时发布/.test(text) ? '定时' : /审核/.test(text) ? '审核中' : '已发布',
      url: id ? `https://www.xiaohongshu.com/explore/${id}` : '',
      time,
    };
  },
  // 作品管理卡片 DOM 里有 /video/<id> 链接（⚠️校准：链接是否出现在 DOM）
  async douyin(br, p) {
    const html = await br.html({ sel: '[class*=video-card], body' });
    const block = html.includes(p.title) ? html.slice(Math.max(html.indexOf(p.title) - 1500, 0), html.indexOf(p.title) + 2500) : '';
    if (!block) return null;
    const id = (block.match(/video\/(\d{15,})/) || [])[1] || '';
    const text = strip(block);
    return {
      status: /定时发布|定时/.test(text) ? '定时' : /审核/.test(text) ? '审核中' : '已发布',
      url: id ? `https://www.douyin.com/video/${id}` : '',
      time: (text.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/) || [''])[0],
    };
  },
  // 视频号作品没有网页链接，只记状态和时间
  async channels(br, p) {
    const first = (p.body || p.shortTitle || '').split('\n')[0].trim().slice(0, 30);
    const text = await bodyText(br);
    const i = text.indexOf(first);
    if (i < 0) return null;
    const seg = text.slice(i, i + 300);
    const m = seg.match(/将于\s*(\d{4}年\d{2}月\d{2}日\s*\d{2}:\d{2})/) || seg.match(/(\d{4}年\d{2}月\d{2}日\s*\d{2}:\d{2})/);
    return { status: /将于/.test(seg) ? '定时' : '已发布', url: '', time: m ? m[1] : '', note: '视频号作品没有网页链接' };
  },
};

// 在列表 html/文本里找含标题的「行」；返回 {text, html}
function findRow(text, html, title) {
  const i = text.indexOf(title);
  if (i < 0) return null;
  const j = html.indexOf(title);
  return { text: text.slice(Math.max(i - 200, 0), i + 400), html: html.slice(Math.max(j - 1500, 0), j + 2000) };
}
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------------------------------------------------------------------------
// 流量：同一批管理页/数据页读数字
// ---------------------------------------------------------------------------
export const metricReaders = {
  // ⚠️校准：稿件管理行内数据列的标签顺序
  async bilibili(br, p) {
    const html = await br.html({ sel: 'body' });
    const seg = segment(html, p.title, 400, 2500);
    if (!seg) return null;
    const t = strip(seg);
    const near = (label) => num(((t.split(label)[1] || '').match(/^\D*?([\d,.]+[万亿KMw]?)/i) || [])[1]);
    const views = near('播放');
    if (views == null) return null;
    return { views, likes: near('点赞'), comments: near('评论'), favorites: near('收藏'), shares: near('分享'), extra: { 弹幕: near('弹幕') } };
  },
  // 小红书笔记管理：卡片 stat 顺序 浏览、评论、点赞、收藏、分享（原版同序）
  async xhs(br, p) {
    const html = await br.html({ sel: 'body' });
    const seg = segment(html, p.title, 200, 2200);
    if (!seg) return null;
    const nums = (strip(seg).match(/[\d,.]+[万亿KMw]?/gi) || []).map(num).filter(v => v != null);
    if (nums.length < 5) return null;
    return { views: nums[0], comments: nums[1], likes: nums[2], favorites: nums[3], shares: nums[4] };
  },
  // 抖音作品管理卡片：播放/点赞/评论/收藏/转发（⚠️校准：卡片数据列顺序）
  async douyin(br, p) {
    const html = await br.html({ sel: 'body' });
    const seg = segment(html, p.title, 200, 3000);
    if (!seg) return null;
    const t = strip(seg);
    const near = (label) => num(((t.split(label)[1] || '').match(/^\D*?([\d,.]+[万亿KMw]?)/i) || [])[1]);
    const views = near('播放');
    if (views == null) return null;
    return { views, likes: near('点赞'), comments: near('评论'), favorites: near('收藏'), shares: near('转发') };
  },
  // 视频号 post/list：数据项带图标（eyes/like/comment/share），html 里按 svg 类名就近配对
  async channels(br, p) {
    const first = (p.body || p.shortTitle || '').split('\n')[0].trim().slice(0, 30);
    const html = await br.html({ sel: 'body' });
    const seg = segment(html, first, 100, 1600);
    if (!seg) return null;
    const o = {};
    for (const [k, re] of [['views', /data-item[^>]*>[\s\S]{0,120}?(eyes|eye)[\s\S]{0,80}?([\d,.]+[万亿KMw]?)/i], ['likes', /data-item[^>]*>[\s\S]{0,120}?(outlined-like|like)[\s\S]{0,80}?([\d,.]+[万亿KMw]?)/i], ['comments', /data-item[^>]*>[\s\S]{0,120}?comment[\s\S]{0,80}?([\d,.]+[万亿KMw]?)/i], ['shares', /data-item[^>]*>[\s\S]{0,120}?icon-share[\s\S]{0,80}?([\d,.]+[万亿KMw]?)/i]]) {
      const m = seg.match(re);
      if (m) o[k] = num(m[m.length - 1]);
    }
    return o.views != null ? { views: o.views, likes: o.likes ?? null, comments: o.comments ?? null, shares: o.shares ?? null } : null;
  },
};

function segment(html, anchor, before, after) {
  const i = html.indexOf(anchor);
  if (i < 0) return null;
  return html.slice(Math.max(i - before, 0), i + after);
}

// ---------------------------------------------------------------------------
// 粉丝：创作者后台首页/数据页的总数
// ---------------------------------------------------------------------------
export const followerReaders = {
  async bilibili(br) {
    const t = await bodyText(br);
    const m = t.match(/粉丝[^\d]{0,10}([\d,.]+[万亿]?)/) || t.match(/([\d,.]+[万亿]?)\s*粉丝/);
    return m ? { total: num(m[1]) } : null;
  },
  async douyin(br) {
    const t = await bodyText(br);
    const m = t.match(/粉丝[^\d]{0,10}([\d,.]+[万亿]?)/);
    return m ? { total: num(m[1]) } : null;
  },
  async xhs(br) {
    const t = await bodyText(br);
    const m = t.match(/粉丝总数[^\d]{0,10}([\d,.]+[万亿]?)/) || t.match(/([\d,.]+[万亿]?)\s*粉丝/);
    return m ? { total: num(m[1]) } : null;
  },
  async channels(br) {
    const t = await bodyText(br);
    const m = t.match(/关注者总数[^\d]{0,10}([\d,.]+[万亿]?)/);
    return m ? { total: num(m[1]) } : null;
  },
};

export const FOLLOWER_PAGES = {
  bilibili: 'https://member.bilibili.com/platform/home',
  douyin: 'https://creator.douyin.com/creator-micro/home',
  xhs: 'https://creator.xiaohongshu.com/statistics/fans-data',
  channels: 'https://channels.weixin.qq.com/platform/statistic/follower',
};
