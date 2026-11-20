// 浏览器半边契约测试：不碰真实浏览器，直接把 dist/client.js 塞进一个假的 ModuleLoader + 假 React，
// 验四件事（这四件坏了用户在侧栏就看不到/点不动面板，而 Host 侧测试看不出来）：
//   1. 产物只 require react 白名单外的模块会失败（require 兜底抛错）
//   2. 侧栏 sidebar.panellist 注册成功，label() 是「梁工发布中控」
//   3. main 槽位渲染出 iframe，src 指向 /liang-publish/，主题通过 postMessage 下发
//   4. 页面发来 liang-publish:refresh 时开新对话（startSession 带 prompt），并回 start-ok
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bundle = join(root, 'dist', 'client.js')
const ORIGIN = 'http://127.0.0.1:54844'

// 一次性搭好浏览器侧的最小环境，载入产物并返回 { exports, ctx 记录 }
function loadBundle() {
  assert.ok(existsSync(bundle), 'dist/client.js 不存在，先跑 npm run build')
  const code = readFileSync(bundle, 'utf8')

  const loaded = []
  const listeners = []
  const posted = []          // 插件 postMessage 出去的报文
  const startCalls = []
  const slots = []           // slots.register 的记录
  const effects = []         // useEffect 回调

  const frame = { contentWindow: { postMessage: (msg, origin) => posted.push({ msg, origin }) } }

  const fakeReact = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useRef: () => ({ current: frame }),
    useEffect: (fn) => { effects.push(fn) },
  }

  globalThis.window = {}
  globalThis.location = { origin: ORIGIN }
  globalThis.addEventListener = (type, fn) => listeners.push({ type, fn })
  globalThis.removeEventListener = () => {}
  globalThis.window.__ModuleLoader__ = {
    load: ({ id, factory }) => loaded.push({ id, factory }),
  }

  // 产物是 CJS 包装，用函数作用域里的 require 拿 react；白名单外直接抛（顺带守 require 白名单）
  new Function('window', 'location', 'addEventListener', 'removeEventListener', code)(
    globalThis.window, globalThis.location, globalThis.addEventListener, globalThis.removeEventListener,
  )
  assert.equal(loaded.length, 1, 'ModuleLoader.load 应该只被调用一次')
  const { id, factory } = loaded[0]
  const deps = []
  const mod = factory((spec) => {
    deps.push(spec)
    if (spec === 'react') return fakeReact
    throw new Error(`产物 require 了白名单外的模块：${spec}`)
  })

  const ctx = {
    inject(names, fn) {
      fn({
        theme: { getTheme: () => ({ active: { colorScheme: 'dark' } }) },
        on: () => {},
      })
    },
    slots: {
      inject: (_name, fn) => fn(),
      register: (opts, component) => { slots.push({ opts, component }); return opts },
    },
    uiWorkspace: { startSession: (...args) => startCalls.push(args) },
  }

  return { mod, ctx, id, deps, slots, effects, posted, startCalls, listeners, frame }
}

test('client 产物：id / exports / 注入的上下文', () => {
  const { mod, id, deps } = loadBundle()
  assert.equal(id, 'dsh-liang-publish')
  assert.equal(mod.isPlugin, true)
  assert.deepEqual(mod.inject, ['slots', 'uiWorkspace'])
  assert.deepEqual(deps, ['react'], '产物只允许 require react')
})

test('client 产物：侧栏入口 + 主区域 iframe + 主题下发', () => {
  const { mod, ctx, slots, effects, posted, frame } = loadBundle()
  mod.apply(ctx)

  const ids = slots.map((s) => s.opts.name)
  assert.deepEqual(ids, ['sidebar.panellist', 'main'], `槽位注册不对：${ids.join(',')}`)

  const sidebar = slots[0].opts
  assert.equal(sidebar.id, 'liang-publish')
  assert.equal(sidebar.order, 16)
  assert.equal(sidebar.label(), '梁工发布中控')

  const main = slots[1]
  assert.equal(main.opts.key, 'liang-publish')
  const tree = main.component()
  assert.equal(tree.type, 'iframe')
  assert.equal(tree.props.src, '/liang-publish/')
  assert.equal(tree.props.title, '梁工发布中控')

  effects.forEach((fn) => fn())
  tree.props.onLoad({ currentTarget: frame })
  const scheme = posted.find((p) => p.msg.type === 'liang-publish:scheme')
  assert.ok(scheme, 'onLoad 后应把主题方案 postMessage 给 iframe')
  assert.equal(scheme.msg.scheme, 'dark')
  assert.equal(scheme.origin, ORIGIN)
})

test('client 产物：页面发 refresh → 开新对话并回 start-ok', () => {
  const { mod, ctx, slots, effects, posted, startCalls, listeners, frame } = loadBundle()
  mod.apply(ctx)
  slots[1].component()                  // 渲染主区域：useEffect 才会挂 message 监听
  effects.forEach((fn) => fn())
  assert.equal(listeners.length, 1, '应该只挂一个 message 监听')

  const onMessage = listeners[0].fn
  onMessage({ source: frame.contentWindow, origin: ORIGIN, data: { type: 'liang-publish:refresh', prompt: '帮我发布这一期' } })
  assert.equal(startCalls.length, 1, 'refresh 应触发 startSession')
  const [sessionArg, opts] = startCalls[0]
  assert.equal(sessionArg, undefined)
  assert.equal(opts.prompt, '帮我发布这一期')
  assert.equal(opts.whenDraftExists, 'replace')
  assert.ok(posted.some((p) => p.msg.type === 'liang-publish:start-ok'), '成功后应回 start-ok')

  // 非本 iframe 来源的报文必须忽略（防别的页面/攻击者乱开对话）
  posted.length = 0
  onMessage({ source: { contentWindow: {} }, origin: ORIGIN, data: { type: 'liang-publish:refresh', prompt: 'x' } })
  onMessage({ source: frame.contentWindow, origin: 'https://evil.example', data: { type: 'liang-publish:refresh', prompt: 'x' } })
  assert.equal(startCalls.length, 1, '来源不对的报文不该开对话')
})

// 这条是补的真实事故：面板一打开就整个点不动——#modal 带 hidden 属性，但 .modal 自己写了
// display:flex（作者样式赢过 UA 的 [hidden]{display:none}），于是 inset:0 + z-index:30 的
// 空弹窗遮罩从第一秒就盖满整页，什么按钮都点不到；右下角同时露出一个空任务卡。
test('面板样式：hidden 必须压得住 .modal / .job 的 display', () => {
  // 先去掉注释再匹配：注释里本身就写着 "[hidden]{display:none}" 这句话，不去掉会误判成已有规则
  const css = readFileSync(join(root, 'lab', 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const html = readFileSync(join(root, 'lab', 'index.html'), 'utf8')

  const rule = css.match(/\[hidden\]\s*\{[^}]*\}/)
  assert.ok(rule, 'style.css 缺 [hidden] 规则')
  assert.match(rule[0], /display\s*:\s*none/, '[hidden] 必须是 display:none')
  assert.match(rule[0], /!important/, '[hidden] 必须 !important，否则浮层自己的 display 会赢')

  // 这两个浮层默认靠 hidden 属性藏起来
  assert.match(html, /id="modal"[^>]*\shidden/)
  assert.match(html, /id="jobCard"[^>]*\shidden/)

  // 它们各自写了 display，所以上面那条 !important 不是多余的
  for (const cls of ['fans', 'modal', 'job']) {
    const m = css.match(new RegExp(`\\n\\.${cls}\\b[^{]*\\{[^}]*\\}`))
    if (!m) continue
    if (cls !== 'fans') assert.match(m[0], /display\s*:\s*flex/, `.${cls} 应自带 display:flex`)
  }
})
