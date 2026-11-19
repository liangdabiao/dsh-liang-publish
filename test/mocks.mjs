// 四平台 mock 页面状态机：元素键 = 选择器子串（最长匹配）或文本锚点。
// 语义与真实上传页对齐（同一个字段被写入后，读回校验才能通过）；
// 真机校准只改 lib/bsk.js 的 real 后端，这里的结构保持稳定作为离线回归基准。
const pad = (n) => String(n).padStart(2, '0');

const now = new Date(Date.now() + 8 * 3600e3 + 3 * 3600e3);   // 默认定时：北京时间 3 小时后
export const SCHED = {
  y: now.getUTCFullYear(), m: now.getUTCMonth() + 1, d: now.getUTCDate(), hh: 20, mm: 30,
};
SCHED.ymd = `${SCHED.y}-${pad(SCHED.m)}-${pad(SCHED.d)}`;
SCHED.text = `${SCHED.ymd} ${pad(SCHED.hh)}:${pad(SCHED.mm)}`;
const DAY_TEXT = `${SCHED.m}月${SCHED.d}日`;

export function bilibiliPage() {
  const st = { videoDone: false, title: '', desc: '', tags: [], pendingTag: '', category: '', coverModal: false, coverSet: false, schedOn: false, calOpen: false, timeOpen: false, dateText: '', hh: null, mm: null, catOpen: false };
  return {
    url: 'https://member.bilibili.com/platform/upload/video/frame',
    state: st,
    elements: {
      'body': {
        kind: 'text',
        text: (s) => `上传视频 ${s.videoDone ? '上传完成' : '上传中'} 稿件标题${s.title} 标签${s.tags.join(' ')} 分区${s.category || '请选择'} ${s.schedOn ? `定时发布 ${s.dateText} ${s.hh != null ? `${pad(s.hh)}:${pad(s.mm)}` : ''}` : '立即发布'}${s.coverSet ? ' 封面已设置' : ''}`,
      },
      '.bcc-upload-wrapper input[type=file]': { kind: 'upload', field: 'videoFile', effect: (s) => { s.videoDone = true; } },
      '.tag-pre-wrp': { kind: 'text', text: (s) => `标签${s.tags.join(' ')}`, html: (s) => `<div class="tag-pre-wrp">${s.tags.map(t => `<span class="label-item-v2-content">${t}</span>`).join('')}</div>` },
      'input[placeholder="请输入稿件标题"]': { kind: 'input', field: 'title' },
      '.ql-editor': { kind: 'editor', field: 'desc' },
      'input[placeholder="按回车键Enter创建标签"]': { kind: 'tagInput', field: 'tags' },
      'svg.close': { kind: 'button', text: 'close-icon', effect: (s) => { s.tags.pop(); } },
      '.cover-module-main .cover-empty': { kind: 'button', text: '添加主封面', effect: (s) => { s.coverModal = true; } },
      '.cover-module-main': { kind: 'text', text: (s) => (s.coverSet ? '主封面' : ''), html: (s) => `<div class="cover-module-main">${s.coverSet ? '<img class="cover-img">' : '<div class="cover-empty">添加主封面</div>'}</div>` },
      'input[type=file][accept*="image"]': { kind: 'upload', field: 'coverFile', visible: (s) => s.coverModal, effect: (s) => { s.coverSet = true; s.coverModal = false; } },
      '完成': { kind: 'button', text: '完成', effect: (s) => { s.coverModal = false; } },
      '.video-human-type .select-controller': { kind: 'button', text: '请选择分区', effect: (s) => { s.catOpen = true; } },
      '人工智能': { kind: 'button', text: '人工智能', visible: (s) => s.catOpen, effect: (s) => { s.category = '人工智能'; s.catOpen = false; } },
      '.video-human-type .select-item-cont': { kind: 'text', text: (s) => s.category },
      '.time-container .switch-container': { kind: 'button', text: '定时发布开关', effect: (s) => { s.schedOn = true; } },
      '.time-container .date-picker-date': { kind: 'button', text: '请选择日期', visible: (s) => s.schedOn, effect: (s) => { s.calOpen = true; } },
      '.time-container .date-picker-nav-title': { kind: 'text', text: (s) => (s.schedOn ? `${SCHED.y}年${SCHED.m}月` : '') },
      '.next-btn-day': { kind: 'button', text: '下个月', effect: () => {} },
      'hour20': { kind: 'button', text: String(SCHED.hh).padStart(2, '0'), visible: (s) => s.timeOpen, effect: (s) => { s.hh = SCHED.hh; } },
      'min30': { kind: 'button', text: String(SCHED.mm).padStart(2, '0'), visible: (s) => s.timeOpen, effect: (s) => { s.mm = SCHED.mm; } },
      '2026-11-18': { kind: 'button', text: DAY_TEXT, visible: (s) => s.calOpen, effect: (s) => { s.dateText = SCHED.ymd; s.calOpen = false; s.timeOpen = true; } },
      '.time-container .date-show': { kind: 'text', text: (s) => (s.hh != null && s.mm != null && s.dateText ? `${s.dateText} ${pad(s.hh)}:${pad(s.mm)}` : '') },
    },
  };
}

export function xhsPage() {
  const st = { videoDone: false, title: '', body: '', lastHash: '', suggest: '', topics: [], coverModal: false, coverSet: false, schedOn: false, schedText: '' };
  return {
    url: 'https://creator.xiaohongshu.com/publish/publish?source=official&target=video',
    state: st,
    elements: {
      'body': {
        kind: 'text',
        text: (s) => `上传视频${s.videoDone ? '（已完成）' : '（上传中）'} 笔记标题${s.title} ${s.body} ${s.schedOn ? `定时发布于 ${s.schedText}` : ''}${s.coverSet ? ' 封面效果评估通过' : ' 封面'}`,
      },
      'input[type=file]': { kind: 'upload', field: 'videoFile', effect: (s) => { s.videoDone = true; } },
      'input[placeholder="填写标题会有更多赞哦"]': { kind: 'input', field: 'title' },
      '我知道了': { kind: 'button', text: '我知道了', effect: () => {} },
      '.tiptap.ProseMirror': {
        kind: 'editor', field: 'body',
        effect: (s, { value } = {}) => {
          if (value && value.startsWith('#')) { s.lastHash = value.slice(1).trim(); s.suggest = `推荐：#${s.lastHash}`; }
          else s.suggest = '';
        },
      },
      'press:editor': { kind: 'hidden' },
      '话题联想': { kind: 'button', text: (s) => s.suggest, effect: (s) => { if (s.lastHash) { s.topics.push(s.lastHash); s.suggest = ''; } } },
      '.post-time-switch-container .d-switch-simulator': { kind: 'button', text: '定时开关', effect: (s) => { s.schedOn = true; } },
      '.post-time-wrapper .d-datepicker-input-filter input': { kind: 'input', field: 'schedText', visible: (s) => s.schedOn },
      '.cover .default': { kind: 'text', text: '封面' },
      '.cover-edit-entry-text': { kind: 'button', text: '编辑封面', effect: (s) => { s.coverModal = true; } },
      'input[type=file][accept*="image"]': { kind: 'upload', field: 'coverFile', visible: (s) => s.coverModal, effect: (s) => { s.coverSet = true; } },
      '裁剪': { kind: 'button', text: '裁剪', effect: () => {} },
      '3:4': { kind: 'button', text: '3:4', visible: (s) => s.coverModal, effect: () => {} },
      '完成': { kind: 'button', text: '完成', effect: (s) => { s.coverModal = false; } },
    },
  };
}

export function douyinPage() {
  const st = { videoDone: false, title: '', body: '', lastHash: '', suggest: '', topics: [], coverModal: false, vTab: false, coverH: false, coverV: false, schedOn: false, schedText: '' };
  return {
    url: 'https://creator.douyin.com/creator-micro/content/upload',
    state: st,
    elements: {
      'body': {
        kind: 'text',
        text: (s) => `上传视频${s.videoDone ? '（已上传）' : '（上传过程中）'} 作品标题${s.title} ${s.body} 话题${s.topics.join(' ')} ${s.schedOn ? `定时发布 ${s.schedText}` : '立即发布'}${s.coverH ? ' 横封面已设置' : ''}${s.coverV ? ' 竖封面已设置' : ''}`,
      },
      'input[type=file]': { kind: 'upload', field: 'videoFile', effect: (s) => { s.videoDone = true; } },
      'input[placeholder="填写作品标题': { kind: 'input', field: 'title' },
      '.editor-kit-container': {
        kind: 'editor', field: 'body',
        effect: (s, { value } = {}) => { if (value && value.startsWith('#')) { s.lastHash = value.slice(1).trim(); s.suggest = `推荐话题 #${s.lastHash}`; } else s.suggest = ''; },
      },
      '话题联想': { kind: 'button', text: (s) => s.suggest, effect: (s) => { if (s.lastHash) { s.topics.push(s.lastHash); s.suggest = ''; } } },
      '选择封面': { kind: 'button', text: '选择封面', effect: (s) => { s.coverModal = true; s.vTab = false; } },
      '上传封面': { kind: 'upload', text: '上传封面', field: 'coverFile', visible: (s) => s.coverModal, effect: (s) => { if (s.vTab) s.coverV = true; else s.coverH = true; } },
      '设置竖封面': { kind: 'button', text: '设置竖封面', visible: (s) => s.coverModal, effect: (s) => { s.vTab = true; } },
      '完成': { kind: 'button', text: '完成', effect: (s) => { s.coverModal = false; } },
      '定时发布': { kind: 'button', text: '定时发布', effect: (s) => { s.schedOn = true; } },
      'schedule-part': { kind: 'input', field: 'schedText', visible: (s) => s.schedOn },
    },
  };
}

export function channelsPage() {
  const st = { videoDone: false, shortTitle: '', body: '', topics: [], schedOn: false, calOpen: false, timeOpen: false, dateText: '', hh: null, mm: null, coverModal: false, coverSet: false, coverFile: null };
  return {
    url: 'https://channels.weixin.qq.com/platform/post/create',
    state: st,
    elements: {
      'body': {
        kind: 'text',
        text: (s) => `发布页${s.videoDone ? '（视频已上传）' : '（视频上传中，可取消上传）'} 短标题${s.shortTitle} ${s.body} ${s.schedOn && s.dateText ? `定时 于 ${s.dateText} ${s.hh != null ? `${pad(s.hh)}:${pad(s.mm)}` : ''}` : '立即发表'}${s.coverSet ? ' 封面已设置' : ''}`,
      },
      '上传视频': { kind: 'upload', text: '上传视频', field: 'videoFile', effect: (s) => { s.videoDone = true; } },
      'wujie-app': { kind: 'text', text: () => '视频号助手' },
      '填写短标题有机会获得更多流量': { kind: 'input', field: 'shortTitle', text: '填写短标题有机会获得更多流量' },
      '输入描述': { kind: 'editor', field: 'body', text: '输入描述' },
      '定时': { kind: 'button', text: '定时', effect: (s) => { s.schedOn = true; } },
      '请选择发表时间': { kind: 'button', text: '请选择发表时间', visible: (s) => s.schedOn, effect: (s) => { s.calOpen = true; } },
      '下个月': { kind: 'button', text: '下个月', effect: () => {} },
      'hour20': { kind: 'button', text: String(SCHED.hh).padStart(2, '0'), visible: (s) => s.timeOpen, effect: (s) => { s.hh = SCHED.hh; } },
      'min30': { kind: 'button', text: String(SCHED.mm).padStart(2, '0'), visible: (s) => s.timeOpen, effect: (s) => { s.mm = SCHED.mm; } },
      '2026-11-18': { kind: 'button', text: DAY_TEXT, visible: (s) => s.calOpen, effect: (s) => { s.dateText = SCHED.ymd; s.calOpen = false; s.timeOpen = true; } },
      '请选择时间': { kind: 'button', text: '请选择时间', visible: (s) => s.calOpen, effect: (s) => { s.timeOpen = true; } },
      '编辑封面入口': { kind: 'button', text: (s) => '个人主页 编辑 分享卡片 编辑', effect: (s) => { s.coverModal = true; } },
      '直接编辑': { kind: 'button', text: '直接编辑', effect: () => {} },
      '上传封面': { kind: 'upload', text: '上传封面', field: 'coverFile', visible: (s) => s.coverModal, effect: (s) => { s.coverSet = true; } },
      '确认': { kind: 'button', text: '确认', effect: (s) => { s.coverModal = false; } },
    },
  };
}

// 作品管理页（取链接 + 采流量读数）
export function managePage(id, { title, bvid, noteId, awemeId, body }) {
  const stats = { views: 12300, likes: 456, comments: 89, favorites: 77, shares: 33 };
  const day = new Date().toISOString().slice(0, 10);
  const items = {
    bilibili: () => `
      <div class="sp-list-wrapper">
        <div class="item">
          <div class="title">${title}</div>
          <div class="meta">2026-11-19 12:00 已发布 播放${stats.views} 弹幕21 点赞${stats.likes} 评论${stats.comments} 收藏${stats.favorites} 分享${stats.shares}</div>
          <a href="https://www.bilibili.com/video/BV${bvid}">查看</a>
        </div>
      </div>`,
    xhs: () => `
      <div class="note-card" data-impression='{"noteTarget":{"value":{"noteId":"${noteId}"}}}'>
        <div class="note-card__title">${title}</div>
        <div class="note-card__stat">${stats.views}</div>
        <div class="note-card__stat">${stats.comments}</div>
        <div class="note-card__stat">${stats.likes}</div>
        <div class="note-card__stat">${stats.favorites}</div>
        <div class="note-card__stat">${stats.shares}</div>
        <div class="time">${day} 12:00 已发布</div>
      </div>`,
    douyin: () => `
      <div class="video-card-info">
        <div class="title">${title}</div>
        <div class="stats">播放${stats.views} 点赞${stats.likes} 评论${stats.comments} 收藏${stats.favorites} 转发${stats.shares}</div>
        <a href="https://www.douyin.com/video/${awemeId}">链接</a>
        <div class="time">${day} 12:00 已发布</div>
      </div>`,
    channels: () => `
      <div class="post-feed-item">
        <div class="title">${title}</div>
        <div class="data-item"><svg class="icon-eyes"></svg>${stats.views}</div>
        <div class="data-item"><svg class="outlined-like"></svg>${stats.likes}</div>
        <div class="data-item"><svg class="icon-comment"></svg>${stats.comments}</div>
        <div class="data-item"><svg class="icon-share"></svg>${stats.shares}</div>
      </div>`,
  }[id];
  return {
    url: `https://mock.manage/${id}`,
    state: { title, body, day },
    elements: {
      body: { kind: 'text', text: (s) => `作品管理 ${title}`, html: (s) => items() },
    },
  };
}

// 粉丝页
export function followerPage(id, total) {
  const labels = { bilibili: '粉丝', douyin: '粉丝', xhs: '粉丝总数', channels: '关注者总数' };
  return {
    url: `https://mock.fans/${id}`,
    state: { total },
    elements: { body: { kind: 'text', text: (s) => `${labels[id]} ${s.total} 昨日净增 +12` } },
  };
}
