// 进程内任务队列：面板/工具发起的长任务（run/sync/metrics/followers/doctor）在这里跑，
// 面板 2s 轮询 /api/job 看进度。同一时间只跑一个（采集和填写抢同一个浏览器会话）。

const jobs = new Map();   // id -> { id, name, status, startedAt, endedAt, ok, log: [], states: {} }
let seq = 0;
let current = null;

export function jobStatus(id = null) {
  if (id) return jobs.get(id) || null;
  return current ? jobs.get(current) : [...jobs.values()].pop() || null;   // 缺省=最新一个
}
export function recentJobs(n = 10) {
  return [...jobs.values()].slice(-n).reverse();
}

export function startJob(name, fn, { onLog } = {}) {
  if (current && jobs.get(current)?.status === 'running') {
    return { error: `有任务还在跑：${jobs.get(current).name}。等它结束或先停掉。` };
  }
  const id = `j${++seq}_${Date.now().toString(36)}`;
  const job = { id, name, status: 'running', startedAt: new Date().toISOString(), endedAt: null, ok: null, log: [], states: {} };
  jobs.set(id, job);
  current = id;
  const write = (msg, kind = 'info') => {
    job.log.push({ ts: new Date().toISOString().slice(11, 19), kind, msg: String(msg).slice(0, 500) });
    if (job.log.length > 400) job.log.splice(0, job.log.length - 400);
    onLog && onLog(msg, kind);
  };
  fn({ job, write })
    .then((result) => { job.ok = true; job.result = result; })
    .catch((e) => { job.ok = false; job.error = String(e.message || e).slice(0, 600); write(`出错：${job.error}`, 'err'); })
    .finally(() => { job.status = 'done'; job.endedAt = new Date().toISOString(); current = null; });
  return { id };
}
