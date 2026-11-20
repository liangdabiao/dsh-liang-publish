// 真机校准脚本 v2：抖音 click→input→evaluate 塞文件（node scripts/calib-douyin.mjs）
process.env.BSK_AUTO_START = '0';
const { createBridge } = await import('../lib/bsk.js');
const { startFileBridge } = await import('../lib/filebridge.js');

const FILE = process.argv[2] || 'D:/1120test/成片.mp4';
const bridge = await startFileBridge(FILE);
console.log('[桥]', bridge.url);
const br = createBridge();
await br.open('https://creator.douyin.com/creator-micro/content/upload');
await br.sync();

// ① 真实点击上传按钮
try {
  await br.click({ text: '点击上传' });
  console.log('[click] OK');
} catch (e) { console.log('[click] ERR:', e.message.slice(0, 100)); }
await new Promise(r => setTimeout(r, 3000));

// ② input 是否出现
const probe = await br.evaluate(`(() => {
  const collect = (root, out) => { for (const el of root.querySelectorAll('input[type=file]')) out.push({ vis: !!el.offsetParent, dis: el.disabled }); for (const el of root.querySelectorAll('*')) if (el.shadowRoot) collect(el.shadowRoot, out); };
  const out = []; collect(document, out);
  return JSON.stringify({ inputs: out.length });
})()`).catch(e => 'eval-err: ' + e.message.slice(0, 80));
console.log('[input 侦查]', probe);

// ③ evaluate 塞文件
const setScript = `(() => {
  const collect = (root, out) => { for (const el of root.querySelectorAll('input[type=file]')) out.push(el); for (const el of root.querySelectorAll('*')) if (el.shadowRoot) collect(el.shadowRoot, out); };
  const inputs = []; collect(document, inputs);
  const input = inputs.find(i => !i.disabled) || inputs[0];
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
for (let i = 0; i < 20; i++) {
  await new Promise(r => setTimeout(r, 3000));
  let v = 'eval-err';
  try { v = await br.evaluate('window.__liangUploadResult || "pending"'); } catch (e) {
    await br.sync().catch(() => {});
    continue;
  }
  console.log('[轮询]', i, v);
  if (v !== 'pending') break;
}
await new Promise(r => setTimeout(r, 5000));
await br.sync().catch(() => {});
for (const l of br.vomText.split('\n')) if (/上传|textbox|标题|成片|进度/.test(l)) console.log(' ', l.trim().slice(0, 120));
await bridge.close();
await br.close();
process.exit(0);
