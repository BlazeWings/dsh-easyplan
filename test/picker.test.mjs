/**
 * 点选注入的离线断言：
 *  - injectPicker 把脚本插到 </body> 之前；
 *  - 没有 </body> 时追加在末尾；
 *  - 已注入过的页面不重复注入；
 *  - picker.browser.js 本身不含 "</script" 字面量（否则会提前结束宿主的 script 标签）；
 *  - picker 源码里确实带着与客户端约定的消息类型、判定词和 postMessage 通道；
 *  - picker 不碰沙箱里会坏的三样（localStorage / fetch / navigator.clipboard）。
 *
 * 跑法：node test/picker.test.mjs
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { internals } from '../lib/index.js'

const { injectPicker, loadPickerSource } = internals

const source = await loadPickerSource()
assert.ok(source !== null, 'picker.browser.js 应该能被宿主读到')
assert.ok(source.length > 1000, 'picker 源码不应是空壳')

// ① 注入位置：优先 </body> 之前
{
  const html = '<!doctype html><html><body><h1>hi</h1></body></html>'
  const out = injectPicker(html, source)
  const scriptAt = out.indexOf('data-easyplan-picker')
  const bodyEndAt = out.indexOf('</body>')
  assert.ok(scriptAt > -1, '注入后应有标记')
  assert.ok(scriptAt < bodyEndAt, '脚本应插在 </body> 之前')
  assert.ok(out.includes('<h1>hi</h1>'), '原内容不能丢')
}

// ② 没有 </body>：追加在末尾，大小写不敏感
{
  const html = '<h1>no body tag</h1>'
  const out = injectPicker(html, source)
  assert.ok(out.startsWith('<h1>no body tag</h1>'), '末尾追加时原内容应在前面')
  assert.ok(out.includes('data-easyplan-picker'), '末尾追加也要有标记')

  const upper = '<HTML><BODY><p>x</p></BODY></HTML>'
  const outUpper = injectPicker(upper, source)
  assert.ok(outUpper.indexOf('data-easyplan-picker') < outUpper.indexOf('</BODY>'), '</BODY> 大写也要认')
}

// ③ 幂等：已注入过的页面原样返回
{
  const once = injectPicker('<body></body>', source)
  const twice = injectPicker(once, source)
  assert.equal(twice, once, '重复注入必须幂等')
}

// ④ picker 源码自身的安全与契约
assert.ok(!source.includes('</' + 'script'), 'picker 源码不能含 "</script" 字面量')
assert.ok(source.includes("easyplan-feedback"), 'picker 要用与客户端约定的消息类型')
assert.ok(source.includes('postMessage'), 'picker 要走 postMessage 通道')
assert.ok(source.includes('要改'), 'picker 要带判定词表')
assert.ok(!source.includes('localStorage'), 'picker 不能碰 localStorage')
assert.ok(!/\bfetch\s*\(/.test(source), 'picker 不能用 fetch')
assert.ok(!source.includes('navigator.clipboard'), 'picker 不能用 navigator.clipboard')

// ⑤ 回执格式约定（一行一条）——picker 里的 toLine 逻辑按契约抽查源码
assert.ok(/item\.id \+ ' ' \+ item\.verdict/.test(source), '回执行应是 `<id> <判定词>[：备注]`')

console.log('picker.test.mjs: all assertions passed')
