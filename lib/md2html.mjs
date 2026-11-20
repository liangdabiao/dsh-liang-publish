// 最小 Markdown → HTML 转换器（B站专栏正文用）。
// 覆盖 README 常见元素：标题、段落、粗斜体、行内代码、代码块、链接、无序/有序列表、引用、分隔线、表格（转纯文本行）。
// 图片：远程 http(s) 保留 <img>；本地/相对路径图跳过（平台需自己的图床）。
// 输出不带 <html>/<body> 包裹，直接是可粘贴进富文本编辑器的片段。

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// 行内元素：粗体、斜体、行内代码、链接、图片
function inline(s) {
  let h = escapeHtml(s);
  // 图片 ![alt](src)——远程保留，本地跳过
  h = h.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) => {
    if (/^https?:\/\//.test(src)) return `<img src="${src}" alt="${alt}">`;
    return `<em>[图: ${alt || src}]</em>`;
  });
  h = h.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
  return h;
}

export function md2html(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  let inCode = false, codeBuf = [], listMode = null, listBuf = [];

  const flushList = () => {
    if (!listMode) return;
    out.push(listMode === 'ul' ? `<ul>${listBuf.map(x => `<li>${x}</li>`).join('')}</ul>` : `<ol>${listBuf.map(x => `<li>${x}</li>`).join('')}</ol>`);
    listMode = null; listBuf = [];
  };
  const flushCode = () => {
    if (inCode) { out.push(`<pre><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`); inCode = false; codeBuf = []; }
  };

  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trimEnd();

    if (/^```/.test(line.trim())) {
      flushList();
      if (inCode) { flushCode(); }
      else { inCode = true; codeBuf = []; }
      i++; continue;
    }
    if (inCode) { codeBuf.push(raw); i++; continue; }

    const t = line.trim();
    if (!t) { flushList(); i++; continue; }

    // 标题
    const h = t.match(/^(#{1,6})\s+(.*)$/);
    if (h) { flushList(); const lv = Math.min(h[1].length + 1, 6); out.push(`<h${lv}>${inline(h[2])}</h${lv}>`); i++; continue; }

    // 分隔线
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { flushList(); out.push('<hr>'); i++; continue; }

    // 表格：转简单段落（B站专栏不支持复杂表格）
    if (/^\|/.test(t)) {
      flushList();
      const cells = t.split('|').map(c => c.trim()).filter(c => c !== '');
      if (cells.length && !cells.every(c => /^:?-{2,}:?$/.test(c))) {
        out.push(`<p>${cells.map(c => inline(c)).join(' ｜ ')}</p>`);
      }
      i++; continue;
    }

    // 引用
    if (/^>\s?/.test(t)) {
      flushList();
      const buf = [t.replace(/^>\s?/, '')];
      while (i + 1 < lines.length && /^>\s?/.test(lines[i + 1].trim())) { i++; buf.push(lines[i].replace(/^>\s?/, '')); }
      out.push(`<blockquote>${inline(buf.join(' '))}</blockquote>`);
      i++; continue;
    }

    // 列表
    const ul = t.match(/^[-*+]\s+(.*)$/);
    const ol = t.match(/^(\d+)[.)]\s+(.*)$/);
    if (ul || ol) {
      const want = ul ? 'ul' : 'ol';
      if (listMode !== want) flushList();
      listMode = want;
      listBuf.push(inline(ul ? ul[1] : ol[2]));
      i++; continue;
    }
    flushList();

    out.push(`<p>${inline(t)}</p>`);
    i++;
  }
  flushCode();
  flushList();
  return out.join('\n');
}

// 从 markdown 提取标题（第一个 # 行）与正文
export function mdTitleBody(md) {
  const m = md.replace(/\r\n/g, '\n').match(/^#\s+(.+)$/m);
  const body = m ? md.replace(m[0], '').trim() : md.trim();
  return { title: m ? m[1].trim() : '', body };
}
