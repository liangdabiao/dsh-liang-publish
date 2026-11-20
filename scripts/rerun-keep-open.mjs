// 四平台保留标签页重跑 + 常驻保活（node scripts/rerun-keep-open.mjs <工程目录> [平台逗号分隔]）
// 跑完后进程不退出：每 4 分钟 sync 一次所有会话，防止 bsk 闲置回收待发布页（最多 3 小时）。
process.env.BSK_AUTO_START = '0';
const { exec } = await import('../lib/bsk.js');
const hubops = await import('../lib/hubops.js');

const dir = process.argv[2] || 'D:/1120test';
const only = process.argv[3] ? process.argv[3].split(',') : null;
const r = await hubops.runEpisode(dir, { force: true, only, autoPublish: true, onState: (st) => {
  const tail = (st.logs || []).slice(-1)[0];
  if (tail) console.log('[状态]', st.name, '→', st.status, '｜', tail.kind + ': ' + tail.msg.slice(0, 110));
} });
console.log('run 结果:', JSON.stringify(Object.fromEntries(Object.values(r.states || {}).map(s => [s.id, s.status]))));
const tabs = r.keptTabs || [];
const ready = (r.states ? Object.values(r.states) : []).filter(s => s.status === '待你发布');
console.log('\n=== 请去点发布（Chrome 里 BrowserSkill Agent 窗口的这些标签页）===');
for (const s of ready) {
  const tab = tabs.find(t => t.url.includes(platformHost(s.id)));
  console.log(`  ${s.name}: ${tab ? tab.url : '(tab 未保留)'}`);
}
if (tabs.length) {
  const sessions = [...new Set(tabs.map(t => t.session))];
  console.log(`\n[保活] ${sessions.length} 个会话每 4 分钟 sync 一次，本进程保持运行（Ctrl+C 停止）`);
  const fails = new Map();   // session → 连续失败次数（瞬时 sync 报错不算失效，连续 3 次才放弃）
  setInterval(async () => {
    for (const s of [...sessions]) {
      const rr = await exec(['cooperate', 'sync', '--session', s, '--json'], { timeout: 30000 }).catch(() => ({ code: 1 }));
      if (rr.code === 0) { fails.set(s, 0); console.log(`[保活] ${s} OK`); continue; }
      const n = (fails.get(s) || 0) + 1;
      fails.set(s, n);
      console.log(`[保活] ${s} sync 失败 ${n}/3`);
      if (n >= 3) {
        const i = sessions.indexOf(s);
        if (i >= 0) sessions.splice(i, 1);
        console.log(`[保活] ${s} 连续 3 次失败，移出名单`);
      }
    }
    if (!sessions.length) { console.log('[保活] 全部会话已失效，退出'); process.exit(0); }
  }, 4 * 60 * 1000);
} else {
  process.exit(0);
}
// 常驻：保活 interval 持有事件循环

function platformHost(id) {
  return { bilibili: 'member.bilibili.com', xhs: 'creator.xiaohongshu.com', douyin: 'creator.douyin.com', channels: 'channels.weixin.qq.com' }[id] || '';
}
