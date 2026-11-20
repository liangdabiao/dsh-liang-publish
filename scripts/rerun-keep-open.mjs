// 四平台保留标签页重跑（node scripts/rerun-keep-open.mjs <工程目录> [平台逗号分隔]）
process.env.BSK_AUTO_START = '0';
const hubops = await import('../lib/hubops.js');

const dir = process.argv[2] || 'D:/1120test';
const only = process.argv[3] ? process.argv[3].split(',') : null;
const r = await hubops.runEpisode(dir, { force: true, only, onState: (st) => {
  const tail = (st.logs || []).slice(-1)[0];
  if (tail) console.log('[状态]', st.name, '→', st.status, '｜', tail.kind + ': ' + tail.msg.slice(0, 110));
} });
console.log('run 结果:', JSON.stringify(Object.fromEntries(Object.values(r.states || {}).map(s => [s.id, s.status]))));
console.log('保留标签页:');
for (const t of (r.keptTabs || [])) console.log('  ', t.url);
process.exit(0);
