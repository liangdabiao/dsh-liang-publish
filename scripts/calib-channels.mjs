// 真机校准脚本：视频号 evaluate 文件桥上传（node scripts/calib-channels.mjs）
process.env.BSK_AUTO_START = '0';
const { createBridge } = await import('../lib/bsk.js');
const { startFileBridge } = await import('../lib/filebridge.js');

const FILE = process.argv[2] || 'D:/1120test/成片.mp4';
const bridge = await startFileBridge(FILE);
console.log('[桥]', bridge.url);
const br = createBridge();
await br.open('https://channels.weixin.qq.com/platform/post/create');
for (let i = 0; i < 20; i++) { try { await br.sync(); if (br.vomText.includes('发表动态')) break; } catch { await new Promise(r => setTimeout(r, 3000)); } }

// 移除「将此次编辑保留?」遮罩（若有）
try {
  await br.evaluate(`(() => {
    let node = null;
    const walk = (root) => {
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let n; while ((n = w.nextNode())) if (/将此次编辑保留/.test(n.textContent)) node = n;
      for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot);
    };
    walk(document);
    if (!node) return 'no-dialog';
    let el = node.parentElement;
    for (let k = 0; k < 12 && el; k++) { if (/weui-desktop-dialog/.test(el.className || '')) break; el = el.parentElement; }
    const dialog = el ? (el.closest('.weui-desktop-dialog__wrp') || el) : null;
    const mask = dialog && dialog.parentElement && /mask|wrp/i.test(dialog.parentElement.className || '') ? dialog.parentElement : dialog;
    if (mask) mask.remove();
    return 'removed';
  })()`);
  console.log('[遮罩] 已移除');
} catch (e) { console.log('[遮罩] 无'); }
await new Promise(r => setTimeout(r, 2000));
await br.sync().catch(() => {});

// shadow 里找 input[type=file]，evaluate 塞文件
const setScript = `(() => {
  const collect = (root, out) => { for (const el of root.querySelectorAll('input[type=file]')) out.push(el); for (const el of root.querySelectorAll('*')) if (el.shadowRoot) collect(el.shadowRoot, out); };
  const inputs = []; collect(document, inputs);
  const input = inputs.find(i => !i.disabled && /video/.test(i.accept || '')) || inputs.find(i => !i.disabled) || inputs[0];
  if (!input) return 'no-input';
  window.__liangUpload = fetch(${JSON.stringify(bridge.url)}).then(r => { if (!r.ok) throw new Error('http ' + r.status); return r.arrayBuffer(); }).then(buf => {
    const f = new File([buf], '成片.mp4', { type: 'video/mp4' });
    const dt = new DataTransfer(); dt.items.add(f);
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    window.__liangUploadResult = 'set:' + input.files.length;
    return window.__liangUploadResult;
  }).catch(e => { window.__liangUploadResult = 'err:' + (e.message || e); return window.__liangUploadResult; });
  return 'started:inputs=' + inputs.length;
})()`;
let set;
try { set = await br.evaluate(setScript); } catch (e) { set = 'SET-ERR: ' + e.message.slice(0, 100); }
console.log('[SET]', set);
for (let i = 0; i < 20; i++) {
  await new Promise(r => setTimeout(r, 3000));
  let v = 'eval-err';
  try { v = await br.evaluate('window.__liangUploadResult || "pending"'); } catch (e) { await br.sync().catch(() => {}); continue; }
  console.log('[轮询]', i, v);
  if (v !== 'pending') break;
}
await new Promise(r => setTimeout(r, 5000));
await br.sync().catch(() => {});
for (const l of br.vomText.split('\n')) if (/上传|成片|进度|取消/.test(l)) console.log(' ', l.trim().slice(0, 120));
await bridge.close();
await br.close();
process.exit(0);
