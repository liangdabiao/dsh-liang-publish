// ============================================================================
// 梁工发布中控 · 浏览器半边
//   - 侧栏加「梁工发布中控」入口，主区域是插件页面（/liang-publish/，iframe）
//   - 页面发 liang-publish:refresh：postMessage 一段指令，这里开新对话填进输入框（不自动发送）
//   - 明暗跟随 dsh 主题
//
// 注意：不要自己写 window.__ModuleLoader__.load(...)——scripts/build.mjs 的 banner 已包一层。
// ============================================================================
const React = require('react')
const h = React.createElement

const PANEL = 'liang-publish'
const SRC = '/liang-publish/'

function PanelIcon(props) {
  const s = (props && props.size) || 18
  return h('svg', { width: s, height: s, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' },
    h('path', { d: 'M3 11.5 21 4l-7.5 17-2.8-6.7L3 11.5z' }),
    h('path', { d: 'M10.7 14.3 21 4' }),
    h('path', { d: 'M4 19.5h3.2M9.4 21h4.8M16.4 19.5H20', strokeWidth: 1.4 }))
}

function apply(ctx) {
  const frames = new Set()
  let scheme = null
  const post = (frame) => {
    try { if (scheme && frame.contentWindow) frame.contentWindow.postMessage({ type: 'liang-publish:scheme', scheme }, location.origin) } catch {}
  }
  ctx.inject(['theme'], (c) => {
    const push = (snap) => { scheme = snap.active.colorScheme; frames.forEach(post) }
    try { push(c.theme.getTheme()) } catch {}
    c.on('theme/change', push)
  })

  function LiangPanel() {
    const ref = React.useRef(null)
    React.useEffect(() => {
      const self = ref.current
      if (self) frames.add(self)
      function onMessage(e) {
        const frame = ref.current
        if (!frame || e.source !== frame.contentWindow || e.origin !== location.origin) return
        const m = e.data
        if (!m || m.type !== 'liang-publish:refresh' || typeof m.prompt !== 'string') return
        try {
          ctx.uiWorkspace.startSession(undefined, { prompt: m.prompt, whenDraftExists: 'replace' })
          try { frame.contentWindow.postMessage({ type: 'liang-publish:start-ok' }, location.origin) } catch {}
        } catch (err) {
          console.error('[liang-publish] 开新对话失败', err)
          try { frame.contentWindow.postMessage({ type: 'liang-publish:start-failed', message: String((err && err.message) || err) }, location.origin) } catch {}
        }
      }
      addEventListener('message', onMessage)
      return () => { removeEventListener('message', onMessage); frames.delete(self) }
    }, [])
    return h('iframe', {
      ref,
      src: SRC,
      title: '梁工发布中控',
      allow: 'fullscreen',
      onLoad: (e) => post(e.currentTarget),
      style: { width: '100%', height: '100%', border: 0, display: 'block' },
    })
  }

  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register({ name: 'sidebar.panellist', id: PANEL, order: 16, label: () => '梁工发布中控' }, PanelIcon))
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL }, LiangPanel))
}

exports.isPlugin = true
exports.inject = ['slots', 'uiWorkspace']
exports.apply = apply
