// 梁工发布中控 · Host 半边（liang_publish / liang_data 工具 + 技能提供方 + 工作流注入 + 面板数据面）。
// 浏览器侧的活（打开页面、填写、读数）由 lib/bsk.js 派 bsk CLI 干；这里只编排和落库。
import Schema from '@deepseek-ai/schemastery'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSkillProvider } from './skills.js'
import { systemSection } from './systemPrompt.js'
import { registerApi } from '../lib/api.js'
import { db, NAMES, STATE_CN, episodes, getEpisode, getTasks, recentLogs, V1_PLATFORMS } from '../lib/db.mjs'
import { buildProject, validateProject, loadProject } from '../lib/project.mjs'
import { planDir, adoptDir, runEpisode, syncEpisode, collectEpisodeMetrics, collectFollowers, doctor } from '../lib/hubops.js'
import { startJob, jobStatus, recentJobs } from '../lib/jobs.js'
import { checkEnv } from '../lib/bsk.js'
import { review, weekly } from '../lib/review.js'

export const name = 'liang-publish' // = cordis.patch.yml 的 id

export const inject = ['tools', 'skills', 'systemPrompt', 'webServer']

export const Config = Schema.object({
  rootPath: Schema.string().default('').description('发布工程根目录（各期子目录里放 成片.mp4/封面/发布素材.md），如 D:\\视频导出'),
  bskBin: Schema.string().default('').description('bsk 可执行文件路径（留空用 PATH 里的 bsk；装在别处就填全路径）'),
})

function check(args, spec) {
  const problems = []
  for (const key of spec.required || []) {
    if (args?.[key] === undefined) problems.push(`缺少必填参数 ${key}`)
  }
  for (const [key, rule] of Object.entries(spec.properties || {})) {
    const value = args?.[key]
    if (value === undefined) continue
    if (rule.enum && !rule.enum.includes(value)) problems.push(`${key} 只能是 ${rule.enum.join(' / ')} 之一`)
  }
  if (problems.length) throw new Error(`参数有误：${problems.join('；')}。`)
}

const str = (description, extra = {}) => ({ type: 'string', description, ...extra })
const num = (description, extra = {}) => ({ type: 'number', description, ...extra })
const text = (value) => [{ type: 'text', text: value }]

const OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['ok', 'summary'],
    properties: {
      ok: { type: 'boolean' },
      summary: { type: 'string', description: '给模型看的回执' },
      data: { type: 'string', description: '可选：状态表/复盘文字等' },
      hints: { type: 'string', description: '可选：下一步提示' },
    },
  },
  render: (_args, value) => text([value.summary, value.data, value.hints].filter(Boolean).join('\n\n')),
}
const result = (ok, summary, data = '', hints = '') => ({ ok, summary, data, hints })

// 工程目录解析：给绝对路径就直接用；给相对路径就在配置的 rootPath 下找
const dirOf = (cfg, dir) => {
  if (!dir) return ''
  const p = resolve(String(dir))
  return p
}

function stateTable(eid) {
  return getTasks(eid).map(t => `${NAMES[t.platform] || t.platform}：${STATE_CN[t.state] || t.state}${t.detail ? `（${t.detail.slice(0, 60)}）` : ''}${t.url ? ` ${t.url}` : ''}`).join('\n')
}

// 长任务的统一出口：开后台 job，回执指向面板
function runAsJob(name, fn) {
  const started = startJob(name, fn)
  if (started.error) return result(false, started.error, '', '等上一个任务结束（面板「梁工发布中控」能看到进度），再重试。')
  return result(true,
    `${name} 已在后台开跑（任务 ${started.id}）。`,
    '面板入口：侧栏「梁工发布中控」，任务进度实时刷新。',
    '告诉用户：填写期间浏览器会自己动，别关 Chrome；国内四平台填好就停，最后一下「发布/定时发布」由用户自己点。')
}

// ---------------------------------------------------------------------------
// 工具：liang_publish —— make / plan / run / sync / mark / adopt / status / doctor
// ---------------------------------------------------------------------------
export const liangPublishTool = {
  name: 'liang_publish',
  description:
    '梁工发布中控：一期视频发四平台（B站/小红书/抖音/视频号，只填写不点发布，用 bsk 驱动本机 Chrome）。' +
    '流程：make（发布素材.md → publish.json + 校验）→ plan（进分发计划）→ run（后台自动填写上传页）→ 用户点发布 → sync（取链接回填）。' +
    '另有 status 看状态、adopt 登记往期、doctor 体检登录态、mark 人工标记已发布。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['action'],
    properties: {
      action: str('make 生成发布工程并校验；plan 进计划；run 开跑；sync 取链接；mark 标已发布；adopt 登记往期；status 状态；doctor 登录体检', {
        enum: ['make', 'plan', 'run', 'sync', 'mark', 'adopt', 'status', 'doctor'],
      }),
      mdPath: str('make：发布素材.md 的绝对路径'),
      dir: str('make/plan/run/adopt：工程目录（绝对路径，或在配置 rootPath 下的相对路径）'),
      id: str('sync/mark/status：期 id（status 缺省列最近 5 期）'),
      only: str('run/sync：只跑这些平台，逗号分隔（bilibili,xhs,douyin,channels）'),
      force: str('run：库里已到位的平台也重跑（危险，默认 false）'),
      platform: str('mark：平台 id'),
      url: str('mark：作品链接'),
      note: str('mark：备注'),
    },
  },
  output: OUTPUT,
  async execute(args, ctxConfig) {
    check(args, this.parameters)
    const cfg = ctxConfig || {}

    if (args.action === 'make') {
      if (!args.mdPath || !args.dir) throw new Error('make 需要 mdPath + dir')
      const dir = dirOf(cfg, args.dir)
      const r = buildProject(args.mdPath, dir, { requireTag: args.note })
      return result(r.ok,
        r.ok ? `publish.json 已生成并通过校验：${dir}` : `publish.json 已生成，但校验没通过（${r.errors.length} 个问题）。把下面的错误逐条改掉：改发布素材 md 后重新 make，直到通过。`,
        r.text,
        r.ok ? '下一步：plan 进分发计划，跟用户确认后 run。' : '')
    }
    if (args.action === 'plan') {
      if (!args.dir) throw new Error('plan 需要 dir')
      const name = planDir(dirOf(cfg, args.dir))
      return name
        ? result(true, `已登记分发计划：${name}。面板「梁工发布中控」能看到这一期（平台都是「计划中」）。`, '', '到点前：doctor 查登录态 → run 开跑。')
        : result(false, '这一期已经登记过了。用 status 看。')
    }
    if (args.action === 'run') {
      if (!args.dir) throw new Error('run 需要 dir')
      const dir = dirOf(cfg, args.dir)
      const v = validateProject(dir)
      if (!v.ok) return result(false, `校验没过，先改：\n${v.text.slice(-600)}`, '', '改发布素材 md → 重新 make。')
      return runAsJob(`开跑：${dir.split(/[\\/]/).pop()}`, async ({ write }) => {
        const r = await runEpisode(dir, { only: args.only ? args.only.split(',') : null, force: !!args.force, onState: (st) => write(`${st.name}：${st.status}`) })
        if (r.skippedLocked) write(`这些平台已到位、跳过：${r.skippedLocked.map(i => NAMES[i]).join('、')}（要重跑加 force=true）`)
        return r
      })
    }
    if (args.action === 'sync') {
      const ep = getEpisode(args.id)
      if (!ep) throw new Error('没有这一期，先用 status 查 id')
      return runAsJob(`取链接：${ep.name}`, async ({ write }) => {
        const r = await syncEpisode(ep.dir, args.only ? args.only.split(',') : null)
        write(Object.entries(r).map(([id, v]) => `${NAMES[id]}：${v.status}${v.url ? ' ' + v.url : ''}`).join('\n'))
        return r
      })
    }
    if (args.action === 'mark') {
      if (!args.id || !args.platform) throw new Error('mark 需要 id + platform')
      if (!NAMES[args.platform]) throw new Error(`不认识的平台 ${args.platform}`)
      const { setTask, log: dbLog } = await import('../lib/db.mjs')
      setTask(args.id, args.platform, 'published', args.note || '人工标记', { url: args.url || undefined })
      dbLog(args.id, args.platform, 'mark', '人工标记已发布')
      return result(true, `${NAMES[args.platform]} 已标记为「已发布」${args.url ? `：${args.url}` : ''}。`, stateTable(args.id))
    }
    if (args.action === 'adopt') {
      if (!args.dir) throw new Error('adopt 需要 dir')
      const dir = dirOf(cfg, args.dir)
      const id = adoptDir(dir)
      return runAsJob(`登记往期并取链接：${id}`, async ({ write }) => {
        const r = await syncEpisode(dir)
        write(JSON.stringify(r))
        return r
      })
    }
    if (args.action === 'status') {
      const list = args.id ? [getEpisode(args.id)].filter(Boolean) : episodes().slice(0, 5)
      if (!list.length) return result(false, '还没有登记的期数。先按技能流程 make + plan。')
      let out = ''
      for (const e of list) out += `\n【${e.id}】${e.name}  定时 ${e.schedule || '立即'}\n${stateTable(e.id)}\n`
      return result(true, `共 ${list.length} 期${args.id ? '' : '（最近优先）'}：`, out.trim(), '开跑用 run；取链接用 sync。')
    }
    if (args.action === 'doctor') {
      return runAsJob('登录体检（四平台上传页）', async ({ write }) => {
        const r = await doctor()
        const lines = V1_PLATFORMS.map(id => `${NAMES[id]}：${r[id] && r[id].ok ? '✅ 已登录，上传页正常' : `❌ ${r[id] ? r[id].reason : '没有结果'}`}`)
        write(lines.join('\n'))
        return lines
      })
    }
    throw new Error(`未知 action：${args.action}`)
  },
}

// ---------------------------------------------------------------------------
// 工具：liang_data —— metrics / followers / review / weekly
// ---------------------------------------------------------------------------
export const liangDataTool = {
  name: 'liang_data',
  description:
    '梁工发布中控·数据反馈：metrics 采各期流量（播放/点赞/评论/收藏/分享）、followers 采四平台粉丝、' +
    'review 出某期发布第 N 天复盘（和上一期同龄对比）、weekly 出周报。需要本机 Chrome 开着且已登录各平台。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['action'],
    properties: {
      action: str('metrics 采流量；followers 采粉丝；review 单期复盘；weekly 周报', { enum: ['metrics', 'followers', 'review', 'weekly'] }),
      id: str('metrics/review：期 id（metrics 缺省=近 30 天全部已发布期）'),
      d: num('review：发布后第几天，默认 1（常规 1/3/7）'),
    },
  },
  output: OUTPUT,
  async execute(args, ctxConfig) {
    check(args, this.parameters)
    if (args.action === 'metrics') {
      const ep = args.id ? getEpisode(args.id) : null
      if (args.id && !ep) throw new Error('没有这一期，先用 liang_publish status 查 id')
      return runAsJob(ep ? `采流量：${ep.name}` : '采流量（近 30 天）', async ({ write }) => {
        const list = ep ? [ep] : episodes().filter(e => Date.now() - Date.parse(e.created_at) < 30 * 86400e3)
        const parts = []
        for (const e of list) {
          try { const r = await collectEpisodeMetrics(e.dir); if (r) { parts.push(r); write(r) } } catch (e2) { write(`【${e.name}】采集出错：${e2.message}`, 'err') }
        }
        return parts
      })
    }
    if (args.action === 'followers') {
      return runAsJob('采粉丝（四平台）', async ({ write }) => {
        const r = await collectFollowers()
        write(Object.entries(r).map(([p, v]) => `${NAMES[p]}：${v.total != null ? v.total.toLocaleString('en-US') : v.error}`).join('\n'))
        return r
      })
    }
    if (args.action === 'review') {
      const ep = getEpisode(args.id)
      if (!ep) throw new Error('没有这一期，先用 liang_publish status 查 id')
      const r = review(ep, args.d || 1)
      return result(true, `${ep.name} 发布第 ${args.d || 1} 天复盘：`, r.text, '第 1/3/7 天的复盘建议用 dsh 定时任务在采集后自动出。')
    }
    if (args.action === 'weekly') {
      const w = weekly()
      return result(true, '周报：', w.text)
    }
    throw new Error(`未知 action：${args.action}`)
  },
}

// ---------------------------------------------------------------------------
// 装配
// ---------------------------------------------------------------------------
export function apply(ctx, config) {
  const skillDirs = [join(dirname(fileURLToPath(import.meta.url)), '..', 'skills')]
  if (config.bskBin) process.env.BSK_BIN = config.bskBin

  const withCfg = (tool) => ({ ...tool, execute(args) { return tool.execute(args, config) } })

  ctx.effect(() => ctx.tools.register(withCfg(liangPublishTool)), `${name}: tool liang_publish`)
  ctx.effect(() => ctx.tools.register(withCfg(liangDataTool)), `${name}: tool liang_data`)
  ctx.effect(() => ctx.skills.registerProvider(() => createSkillProvider(skillDirs)), `${name}: skills`)
  ctx.effect(() => ctx.systemPrompt.section(systemSection()), `${name}: workflow`)
  ctx.effect(() => registerApi(ctx, { config }), `${name}: routes`)
}
