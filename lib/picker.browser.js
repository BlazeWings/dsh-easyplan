/**
 * dsh-easyplan · 点选脚本（被宿主注入到每个展示页的 </body> 之前）。
 *
 * 职责（第 2 阶段「改初稿」）：
 *  1. 悬停高亮任何「可点名」的元素，并显示它的名字；
 *  2. 点击弹出表态气泡：判定词（同意 / 要改 / 不要 / 要这个风格）+ 备注；
 *  3. 把全部表态拼成「一行一条」的回执文本，每次变化都
 *     postMessage({ type: 'easyplan-feedback', text }, '*') 给卡片；
 *  4. 页面上同时保留一个可鼠标选中复制的 textarea 作为兜底通道。
 *
 * 命名规则：
 *  - 元素已有 AI 起的名字（data-id / data-pick / id 等）→ 优先用它；
 *  - 否则按 DOM 位置生成 path-x-y-z（body 的第 x 个孩子的第 y 个孩子……）。
 *
 * 沙箱兼容：只用 DOM 事件与 postMessage；本地存储、网络请求、剪贴板 API
 * 这三样在 sandbox 的不透明源里都会坏，本脚本一律不碰（测试盯着）。
 *
 * 与第 1 阶段模板页共存：点击落在交互元素（a / button / input 等）上时
 * 不拦截——模板页自己的表态按钮照常工作。
 *
 * 本文件是纯浏览器脚本：无 import、无依赖，由宿主读出来包进 <script> 注入。
 * ⚠️ 源码里不允许出现"结束 script 标签"的那个字面量（会提前结束宿主的
 *    script 标签），测试 test/picker.test.mjs 盯着这条。
 */
(function () {
  'use strict'
  if (window.__easyplanPicker) return
  window.__easyplanPicker = true

  /** 与浏览器半区（lib/client.js）约定的消息类型。 */
  var FEEDBACK_TYPE = 'easyplan-feedback'
  /** 点选 UI 自身的标记，事件处理里凭它跳过自己。 */
  var UI_ATTR = 'data-easyplan-ui'
  /** 自动编号写在这个属性上（AI 起过名的元素不写）。 */
  var PICK_ATTR = 'data-pick-id'
  /** AI 可能用过的命名属性，按优先级找。 */
  var NAME_ATTRS = ['data-id', 'data-pick', 'data-choice', 'data-key', 'data-option', 'data-slug', 'data-verdict', 'data-w', 'id']
  /** 哪些元素可点名（结构元素 + 显式命名过的元素）。 */
  var PICKABLE = 'section,article,header,footer,nav,main,aside,h1,h2,h3,h4,h5,h6,img,figure,table,pre,blockquote,ul,ol,video,canvas,[data-id],[data-pick],[data-choice],[data-key],[data-option]'
  /** 点击落在这些上面不拦截（页面自己的交互优先）。 */
  var INTERACTIVE = 'a,button,input,select,textarea,label,summary,[onclick],[contenteditable]'
  /** 判定词表——回执里的第二段就是它们。 */
  var VERDICTS = ['同意', '要改', '不要', '要这个风格']

  /** 表态记录：[{ id, verdict, note }]。 */
  var verdicts = []
  /** 点选模式开关。 */
  var picking = true
  /** 当前 hover 的可点名元素。 */
  var hovered = null
  /** 当前打开气泡对应的元素。 */
  var current = null

  // ────────────────────────────── 命名 ──────────────────────────────

  /** 按 DOM 位置生成 path-x-y-z 编号。 */
  function pathIdFor(el) {
    var parts = []
    var node = el
    while (node && node !== document.body) {
      var parent = node.parentElement
      if (!parent) break
      var index = Array.prototype.indexOf.call(parent.children, node)
      parts.unshift(index)
      node = parent
    }
    return parts.length ? 'path-' + parts.join('-') : ''
  }

  /**
   * 元素的名字：AI 起过的优先；没有就生成 path 编号并写到 PICK_ATTR。
   * @returns 名字字符串；实在给不出（如不在文档里）返回空串。
   */
  function nameFor(el) {
    for (var i = 0; i < NAME_ATTRS.length; i++) {
      var value = el.getAttribute(NAME_ATTRS[i])
      if (value && /^[A-Za-z0-9_.:-]+$/.test(value)) return value
    }
    var existing = el.getAttribute(PICK_ATTR)
    if (existing) return existing
    var generated = pathIdFor(el)
    if (generated) el.setAttribute(PICK_ATTR, generated)
    return generated
  }

  /** 从事件目标向上找最近的可点名元素；跳过点选 UI 与交互元素。 */
  function pickableFrom(target) {
    if (!(target instanceof Element)) return null
    if (target.closest('[' + UI_ATTR + ']')) return null
    if (target.closest(INTERACTIVE)) return null
    var el = target.closest(PICKABLE)
    if (!el) return null
    var rect = el.getBoundingClientRect()
    if (rect.width < 4 || rect.height < 4) return null
    return el
  }

  // ────────────────────────────── UI ──────────────────────────────

  var style = document.createElement('style')
  style.setAttribute(UI_ATTR, '')
  style.textContent = [
    '[' + UI_ATTR + '] { box-sizing: border-box; font: 13px/1.5 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }',
    '.ezp-hl { position: fixed; border: 2px solid #2563eb; background: rgba(37,99,235,.08); pointer-events: none; z-index: 2147483000; display: none; }',
    '.ezp-tag { position: fixed; background: #2563eb; color: #fff; padding: 1px 6px; border-radius: 3px; font-size: 12px; pointer-events: none; z-index: 2147483001; display: none; }',
    '.ezp-pop { position: fixed; z-index: 2147483002; background: #fff; color: #111; border: 1px solid #cbd5e1; border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.18); padding: 10px; width: 240px; display: none; }',
    '.ezp-pop .ezp-name { font-weight: 600; margin-bottom: 6px; word-break: break-all; }',
    '.ezp-pop button { margin: 0 4px 4px 0; padding: 3px 10px; border: 1px solid #94a3b8; border-radius: 5px; background: #f8fafc; cursor: pointer; font-size: 13px; }',
    '.ezp-pop button:hover { background: #e2e8f0; }',
    '.ezp-pop input { width: 100%; box-sizing: border-box; margin: 4px 0 6px; padding: 4px 6px; border: 1px solid #cbd5e1; border-radius: 5px; font-size: 13px; }',
    '.ezp-mark { outline: 2px dashed #f59e0b; outline-offset: 2px; }',
    '.ezp-bar { position: fixed; left: 0; right: 0; bottom: 0; z-index: 2147483003; background: #0f172a; color: #e2e8f0; padding: 6px 10px; display: flex; gap: 8px; align-items: center; }',
    '.ezp-bar button { padding: 2px 10px; border: 1px solid #475569; border-radius: 5px; background: #1e293b; color: #e2e8f0; cursor: pointer; font-size: 12px; }',
    '.ezp-bar textarea { flex: 1; height: 40px; resize: none; background: #1e293b; color: #e2e8f0; border: 1px solid #475569; border-radius: 5px; padding: 4px 6px; font: 12px/1.4 ui-monospace, monospace; }',
    '.ezp-bar .ezp-count { white-space: nowrap; font-size: 12px; }',
  ].join('\n')

  /** 造一个带 UI 标记的元素。 */
  function ui(tag, className) {
    var el = document.createElement(tag)
    el.setAttribute(UI_ATTR, '')
    if (className) el.className = className
    return el
  }

  var highlight = ui('div', 'ezp-hl')
  var tag = ui('div', 'ezp-tag')
  var pop = ui('div', 'ezp-pop')
  var bar = ui('div', 'ezp-bar')
  var toggleBtn = ui('button')
  var countSpan = ui('span', 'ezp-count')
  var receiptBox = ui('textarea')
  receiptBox.readOnly = true
  receiptBox.setAttribute('aria-label', '回执文本')
  bar.appendChild(toggleBtn)
  bar.appendChild(countSpan)
  bar.appendChild(receiptBox)

  // ────────────────────────────── 回执 ──────────────────────────────

  /** 一行一条：<id> <判定词>[：备注]。 */
  function toLine(item) {
    return item.id + ' ' + item.verdict + (item.note ? '：' + item.note : '')
  }

  /** 拼回执、刷 textarea、postMessage 给卡片（每次变化都发）。 */
  function emitReceipt() {
    var text = verdicts.map(toLine).join('\n')
    receiptBox.value = text
    countSpan.textContent = verdicts.length + ' 项表态'
    if (text !== '') {
      window.parent.postMessage({ type: FEEDBACK_TYPE, text: text }, '*')
    }
  }

  /** 某元素当前的表态下标；没有返回 -1。 */
  function verdictIndex(id) {
    for (var i = 0; i < verdicts.length; i++) {
      if (verdicts[i].id === id) return i
    }
    return -1
  }

  // ────────────────────────────── 气泡 ──────────────────────────────

  function closePop() {
    pop.style.display = 'none'
    pop.textContent = ''
    current = null
  }

  function openPop(el, x, y) {
    closePop()
    current = el
    var id = nameFor(el)

    var nameEl = ui('div', 'ezp-name')
    nameEl.textContent = id
    pop.appendChild(nameEl)

    VERDICTS.forEach(function (word) {
      var btn = ui('button')
      btn.textContent = word
      btn.addEventListener('click', function () {
        var note = noteInput.value.trim()
        var at = verdictIndex(id)
        var entry = { id: id, verdict: word, note: note }
        if (at >= 0) verdicts[at] = entry
        else verdicts.push(entry)
        el.classList.add('ezp-mark')
        emitReceipt()
        closePop()
      })
      pop.appendChild(btn)
    })

    var noteInput = ui('input')
    noteInput.placeholder = '备注（可空），如：字太小'
    var existing = verdicts[verdictIndex(id)]
    if (existing && existing.note) noteInput.value = existing.note
    pop.appendChild(noteInput)

    var clearBtn = ui('button')
    clearBtn.textContent = '清除此项'
    clearBtn.addEventListener('click', function () {
      var at = verdictIndex(id)
      if (at >= 0) verdicts.splice(at, 1)
      el.classList.remove('ezp-mark')
      emitReceipt()
      closePop()
    })
    pop.appendChild(clearBtn)

    pop.style.display = 'block'
    var left = Math.min(x, window.innerWidth - 260)
    var top = Math.min(y, window.innerHeight - 200)
    pop.style.left = Math.max(4, left) + 'px'
    pop.style.top = Math.max(4, top) + 'px'
    noteInput.focus()
  }

  // ────────────────────────────── 事件 ──────────────────────────────

  function onMove(event) {
    if (!picking) {
      highlight.style.display = 'none'
      tag.style.display = 'none'
      return
    }
    var el = pickableFrom(event.target)
    hovered = el
    if (!el) {
      highlight.style.display = 'none'
      tag.style.display = 'none'
      return
    }
    var rect = el.getBoundingClientRect()
    highlight.style.display = 'block'
    highlight.style.left = rect.left + 'px'
    highlight.style.top = rect.top + 'px'
    highlight.style.width = rect.width + 'px'
    highlight.style.height = rect.height + 'px'
    tag.style.display = 'block'
    tag.textContent = nameFor(el)
    tag.style.left = Math.max(4, rect.left) + 'px'
    tag.style.top = Math.max(4, rect.top - 22) + 'px'
  }

  function onClick(event) {
    if (!picking) return
    var el = pickableFrom(event.target)
    if (!el) return
    event.preventDefault()
    event.stopPropagation()
    openPop(el, event.clientX, event.clientY)
  }

  function onKeydown(event) {
    if (event.key === 'Escape') closePop()
  }

  function onScrollOrResize() {
    if (hovered) onMove({ target: hovered })
  }

  function setPicking(next) {
    picking = next
    toggleBtn.textContent = '点选：' + (picking ? '开' : '关')
    if (!picking) {
      closePop()
      highlight.style.display = 'none'
      tag.style.display = 'none'
    }
  }

  toggleBtn.addEventListener('click', function () {
    setPicking(!picking)
  })

  // ────────────────────────────── 启动 ──────────────────────────────

  function boot() {
    document.body.appendChild(highlight)
    document.body.appendChild(tag)
    document.body.appendChild(pop)
    document.body.appendChild(bar)
    document.addEventListener('mousemove', onMove, true)
    document.addEventListener('click', onClick, true)
    document.addEventListener('keydown', onKeydown, true)
    window.addEventListener('scroll', onScrollOrResize, true)
    window.addEventListener('resize', onScrollOrResize)
    setPicking(true)
    emitReceipt()
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot)
  } else {
    boot()
  }
})()
