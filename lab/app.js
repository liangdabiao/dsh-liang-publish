// 梁工发布中控面板：概览（粉丝+期数列表）+ 任务进度轮询 + 操作按钮。
// 数据面走 /liang-publish/api/*；「在对话里发起发布」通过 postMessage 交宿主开新对话。
const $ = (id) => document.getElementById(id)
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const P_NAMES = { bilibili: 'B站', xhs: '小红书', douyin: '抖音', channels: '视频号' }
const P_COLORS = { bilibili: '#fb7299', xhs: '#ff2442', douyin: '#323232', channels: '#07c160' }
const fmt = (n) => n == null ? '–' : Number(n).toLocaleString('en-US')

async function api(path, opts) {
  const r = await fetch(`/liang-publish/api/${path}`, opts)
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error || r.statusText)
  return j
}
async function postAction(body) {
  const r = await fetch('/liang-publish/api/action', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) { alert(j.error || '操作失败'); throw new Error(j.error) }
  return j
}

// ── 主题 ─────────────────────────────────────────────
addEventListener('message', (e) => {
  if (e.origin !== location.origin) return
  const m = e.data
  if (m && m.type === 'liang-publish:scheme' && m.scheme) {
    document.documentElement.dataset.scheme = m.scheme === 'light' ? 'light' : 'dark'
  }
})

// ── 概览 ─────────────────────────────────────────────
async function loadOverview() {
  let d
  try { d = await api('overview') } catch (e) { $('epList').innerHTML = `<div class="muted pad">加载失败：${esc(e.message)}</div>`; return }
  $('engineVersion').textContent = d.engineVersion || ''
  const fans = $('fansGrid')
  const items = Object.entries(d.fans || {})
  fans.innerHTML = items.length
    ? items.map(([p, v]) => `<div class="fan"><span class="dot" style="background:${P_COLORS[p] || '#888'}"></span>${P_NAMES[p] || p} <b>${fmt(v)}</b></div>`).join('')
    : '<span class="muted">还没有粉丝数据，先点「采粉丝」</span>'

  const list = d.episodes || []
  $('epCount').textContent = list.length ? `${list.length} 期` : ''
  $('epList').innerHTML = list.length ? list.map(epCard).join('') : '<div class="muted pad">还没有登记的期数——在对话里给 AI 文章资料，按技能流程「make → plan」后出现在这里。</div>'
  bindEpActions()
}

function epCard(ep) {
  const chips = (ep.tasks || []).map(t => `
    <div class="task">
      <span class="t-name"><span class="dot" style="width:7px;height:7px;border-radius:50%;background:${P_COLORS[t.platform] || '#888'};display:inline-block"></span>${esc(t.name)}</span>
      <span class="t-state"><span class="chip ${esc(t.state)}">${esc(t.stateCn)}</span></span>
      ${t.m ? `<span class="t-metric">▶ ${fmt(t.m.views)} · ♥ ${fmt((t.m.likes || 0) + (t.m.comments || 0) + (t.m.favorites || 0) + (t.m.shares || 0))}</span>` : ''}
      ${t.detail ? `<span class="t-detail" title="${esc(t.detail)}">${esc(t.detail)}</span>` : ''}
    </div>`).join('')
  const sched = ep.schedule ? ` · 定时 ${esc(ep.schedule.replace('T', ' ').slice(0, 16))}` : ''
  const canSync = (ep.tasks || []).some(t => ['awaiting_user', 'scheduled', 'published', 'filled'].includes(t.state))
  return `<div class="ep card" data-id="${esc(ep.id)}" data-dir="${esc(ep.dir)}">
    <div class="ep-head">
      ${ep.episode ? `<span class="ep-no">第 ${ep.episode} 期</span>` : ''}
      <b>${esc(ep.name)}</b>
      <span class="ep-sched">${sched}</span>
      <span class="ep-actions">
        <button class="btn" data-act="sync" ${canSync ? '' : 'disabled'}>🔗 取链接</button>
        <button class="btn" data-act="metrics">📊 采流量</button>
        <button class="btn" data-act="review">📝 复盘</button>
        <button class="btn" data-act="detail">详情</button>
      </span>
    </div>
    <div class="tasks">${chips || '<span class="muted">没有平台任务</span>'}</div>
  </div>`
}

function bindEpActions() {
  document.querySelectorAll('.ep [data-act]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const card = e.target.closest('.ep')
      const id = card.dataset.id, dir = card.dataset.dir, act = e.target.dataset.act
      if (act === 'sync') await postAction({ type: 'sync', id })
      if (act === 'metrics') await postAction({ type: 'metrics', id })
      if (act === 'review') openReview(id, card.querySelector('b').textContent)
      if (act === 'detail') openDetail(id)
      pollJob()
      loadOverview()
    })
  })
}

// ── 详情 / 复盘弹窗 ─────────────────────────────────
function openModal(title, body, actionsHtml = '') {
  $('modalTitle').textContent = title
  $('modalBody').textContent = body
  $('modalActions').innerHTML = actionsHtml
  $('modal').hidden = false
  bindModalActions()
}
function closeModal() { $('modal').hidden = true }
window.closeModal = closeModal
function bindModalActions() {
  document.querySelectorAll('#modalActions [data-mact]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const act = btn.dataset.mact
      if (act === 'mark') {
        const id = btn.dataset.id, platform = btn.dataset.platform
        const url = prompt('作品链接（可留空）：') || ''
        await postAction({ type: 'mark', id, platform, url, note: '面板人工标记' })
        closeModal(); loadOverview()
      }
    })
  })
}

async function openDetail(id) {
  const ep = await api(`episode?id=${encodeURIComponent(id)}`)
  const logs = (ep.logs || []).slice(-14).map(l => `${l.ts.slice(11, 19)} ${l.platform || ''} ${l.action} ${l.result}`).join('\n')
  const copy = (ep.tasks || []).map(t => t.copy && (t.copy.title || t.copy.body) ? `—— ${t.name} ——\n${t.copy.title}\n${t.copy.body}\n标签：${(t.copy.tags || []).join('、')}` : '').filter(Boolean).join('\n\n')
  openModal(`${ep.name}（${ep.id}）`,
    `目录：${ep.dir}\n定时：${ep.schedule || '立即'}\n\n${copy || '（没有文案快照）'}\n\n—— 最近日志 ——\n${logs || '无'}`,
    (ep.tasks || []).filter(t => ['filled', 'awaiting_user'].includes(t.state)).map(t =>
      `<button class="btn" data-mact="mark" data-id="${esc(id)}" data-platform="${esc(t.platform)}">标「${esc(t.name)}」已发布</button>`).join(''))
}

async function openReview(id, name) {
  try {
    const d1 = await api(`review?id=${encodeURIComponent(id)}&d=1`)
    let d3 = '', d7 = ''
    try { d3 = (await api(`review?id=${encodeURIComponent(id)}&d=3`)).text } catch {}
    try { d7 = (await api(`review?id=${encodeURIComponent(id)}&d=7`)).text } catch {}
    openModal(`${name} · 复盘`, [d1, d3 && d3 !== d1 ? d3 : '', d7 && d7 !== d1 ? d7 : ''].filter(Boolean).join('\n\n———\n\n'))
  } catch (e) { openModal('复盘', `出错：${e.message}`) }
}

// ── 全局按钮 ────────────────────────────────────────
$('btnDoctor').addEventListener('click', async () => { await postAction({ type: 'doctor' }); pollJob() })
$('btnFollowers').addEventListener('click', async () => { await postAction({ type: 'followers' }); pollJob() })
$('btnMetrics').addEventListener('click', async () => { await postAction({ type: 'metrics' }); pollJob() })
$('btnNew').addEventListener('click', () => {
  parent.postMessage({ type: 'liang-publish:refresh', prompt: '帮我发布一期视频。我准备了文章资料和成片，按 liang-publish 技能流程来：先问我要资料和成片位置，然后写四平台发布素材、建工程、生成 publish.json 校验、进分发计划。' }, location.origin)
})
$('jobClose').addEventListener('click', () => { $('jobCard').hidden = true })

// ── 任务进度轮询（2s，可见才拉）────────────────────
let lastLogLen = -1
let shownJobId = null
async function pollJob() {
  let d
  try { d = await api('job') } catch { return }
  const job = d.job
  if (!job) return
  if (job.status === 'running') { renderJob(job); shownJobId = job.id; return }
  // 刚完成且这轮还没展示过：展示一次结果卡（用户点 ✕ 关掉，之后不再弹旧任务）
  if (job.id !== shownJobId && (job.log || []).length) { renderJob(job); shownJobId = job.id }
}
function renderJob(job) {
  $('jobCard').hidden = false
  $('jobName').textContent = job.name
  $('jobState').textContent = job.status === 'running' ? '进行中' : job.ok ? '完成 ✅' : '失败 ❌'
  $('jobState').className = `chip ${job.status === 'running' ? 'running' : job.ok ? 'published' : 'failed'}`
  const logs = job.log || []
  if (logs.length !== lastLogLen) {
    $('jobLog').textContent = logs.map(l => `${l.ts} ${l.msg}`).join('\n')
    $('jobLog').scrollTop = $('jobLog').scrollHeight
    lastLogLen = logs.length
  }
}

setInterval(pollJob, 2000)
document.addEventListener('visibilitychange', () => { if (!document.hidden) { pollJob(); loadOverview() } })
loadOverview()
pollJob()
