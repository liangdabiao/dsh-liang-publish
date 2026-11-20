// 填写完成后的会话保活：bsk 对无人触摸的 task 页有闲置回收（约 10 分钟自动清理），
// 「待你发布」期间必须定期 sync 保住页面，直到用户点完发布或超时上限。
const timers = new Map();   // key → interval

export function startKeepAlive(key, sessions, { intervalMs = 4 * 60 * 1000, maxHours = 3, exec } = {}) {
  stopKeepAlive(key);
  if (!sessions.length) return;
  const alive = new Set(sessions);
  const tick = async () => {
    for (const s of alive) {
      const r = await exec(['cooperate', 'sync', '--session', s, '--json'], { timeout: 30000 }).catch(() => ({ code: 1 }));
      if (r.code !== 0) alive.delete(s);   // 会话已被平台/用户关闭，从保活名单移除
    }
    if (!alive.size) stopKeepAlive(key);
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  timers.set(key, timer);
  return { watching: alive.size, intervalMs, maxHours };
}

export function stopKeepAlive(key) {
  const t = timers.get(key);
  if (t) { clearInterval(t); timers.delete(key); }
}
