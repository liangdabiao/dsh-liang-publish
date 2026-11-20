// 真机校准脚本：小红书 evaluate 文件桥上传（node scripts/calib-xhs.mjs）
process.env.BSK_AUTO_START = '0';
const { createBridge } = await import('../lib/bsk.js');
const { startFileBridge } = await import('../lib/filebridge.js');

const FILE = process.argv[2] || 'D:/1120test/成片.mp4';
const bridge = await startFileBridge(FILE);
console.log('[桥]', bridge.url);
const br = createBridge();
await br.open('https://creator.xiaohongshu.com/publish/publish?source=official&target=video');
await br.sync();

const setScript = `(() => {
  const collect = (root, out) => { for (const el of root.querySelectorAll('input[type=file]')) out.push(el); for (const el of root.querySelectorAll('*')) if (el.shadowRoot) collect(el.shadowRoot, out); };
  const inputs = []; collect(document, inputs);
  const input = inputs.find(i => !i.disabled && /mp4/.test(i.accept || '')) || inputs[0];
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
  return 'started';
})()`;
let set;
try { set = await br.evaluate(setScript); } catch (e) { set = 'SET-ERR: ' + e.message.slice(0, 100); }
console.log('[SET]', set);
for (let i = 0; i < 25; i++) {
  await new Promise(r => setTimeout(r, 3000));
  let v = 'eval-err';
  try { v = await br.evaluate('window.__liangUploadResult || "pending"'); } catch (e) { await br.sync().catch(() => {}); continue; }
  console.log('[轮询]', i, v);
  if (v !== 'pending') break;
}
await br.waitFor('input[placeholder="填写标题会有更多赞哦"]', 60000);
console.log('表单出现:', br.vomText.includes('填写标题会有更多赞哦'));
for (const l of br.vomText.split('\n')) if (/标题|上传|textbox|封面/.test(l)) console.log(' ', l.trim().slice(0, 130));
await bridge.close();
await br.close();
process.exit(0);
