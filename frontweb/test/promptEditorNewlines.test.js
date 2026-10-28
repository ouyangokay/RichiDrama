import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const componentFile = new URL('../src/components/OmniAssetPromptEditor.vue', import.meta.url)

function text(value) {
  return { nodeType: 3, nodeValue: value }
}

function element(tagName, childNodes = [], dataset = {}) {
  return { nodeType: 1, tagName, childNodes, dataset }
}

async function serializer(childNodes) {
  const source = await readFile(componentFile, 'utf8')
  const start = source.indexOf("const EDITOR_LINE_BLOCKS")
  const end = source.indexOf('// 记录上一次真正重建 DOM', start)
  assert.ok(start >= 0 && end > start, 'serializer implementation must remain discoverable')
  const context = {
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
    editorRef: { value: { childNodes } },
  }
  vm.runInNewContext(`${source.slice(start, end)}\nglobalThis.result = serializeEditor()`, context)
  return context.result
}

test('serializes BR and browser DIV/P line structures to the same newline text', async () => {
  assert.equal(await serializer([
    text('第一行'), element('BR'), text('第二行'), element('BR'), text('第三行'),
  ]), '第一行\n第二行\n第三行')

  assert.equal(await serializer([
    text('第一行'),
    element('DIV', [text('第二行')]),
    element('DIV', [text('第三行')]),
  ]), '第一行\n第二行\n第三行')

  assert.equal(await serializer([
    element('P', [text('第一行')]),
    element('P', [text('第二行')]),
    element('P', [text('第三行')]),
  ]), '第一行\n第二行\n第三行')
})

test('empty block placeholders contribute exactly one line boundary', async () => {
  assert.equal(await serializer([
    text('第一行'), element('DIV', [element('BR')]),
  ]), '第一行\n')

  assert.equal(await serializer([
    element('DIV', [text('第一行')]),
    element('DIV', [element('BR')]),
    element('DIV', [text('第三行')]),
  ]), '第一行\n\n第三行')
})

test('asset chips remain complete tokens across structural line boundaries', async () => {
  assert.equal(await serializer([
    element('DIV', [text('前景 '), element('SPAN', [text('ignored label')], { token: '@图片12' })]),
    element('DIV', [text('后景')]),
  ]), '前景 @图片12\n后景')
})

test('caret restoration snaps non-text tokens to their boundary and restores editor scrolling', async () => {
  const source = await readFile(componentFile, 'utf8')
  const start = source.indexOf('function focusEditorAtOffset')
  const end = source.indexOf('function restoreEditorAfterInsert', start)
  const focus = source.slice(start, end)
  assert.match(focus, /range\.setStart\(el, beforeToken \? index : index \+ 1\)/)
  assert.match(focus, /placedOffset = beforeToken \? consumed : consumed \+ length/)
  assert.match(focus, /el\.focus\(\{ preventScroll: true \}\)/)
  assert.match(focus, /el\.scrollTop = scrollPosition\?\.top \|\| 0/)
  assert.match(focus, /el\.scrollLeft = scrollPosition\?\.left \|\| 0/)
  assert.match(focus, /lastCaretOffset\.value = placedOffset/)
})

test('picker, insert button and drag paths share the same token insertion helper', async () => {
  const source = await readFile(componentFile, 'utf8')
  const insertStart = source.indexOf('function insertAsset')
  const insertEnd = source.indexOf('// Deterministic alternative', insertStart)
  const insertAsset = source.slice(insertStart, insertEnd)
  assert.equal(insertAsset.match(/insertTokenAtOffset\(/g)?.length, 1)
  assert.match(insertAsset, /source = `\$\{text\.value\.slice\(0, mention\.start\)\}\$\{text\.value\.slice\(mention\.end\)\}`/)
  assert.match(source, /insertAsset\(asset, \{ offset: lastCaretOffset\.value \}\)/)
  assert.match(source, /insertAsset\(detail\.asset, \{ offset: point\.offset \}\)/)
  assert.match(source, /insertAsset\(asset, \{ offset: point\.offset \}\)/)
})

test('asset-list refresh keeps the live caret and editor viewport instead of focusing the end', async () => {
  const source = await readFile(componentFile, 'utf8')
  assert.match(source, /watch\(\(\) => props\.assets, \(\) => \{ syncReferences\(text\.value\); nextTick\(\(\) => renderEditor\(text\.value\)\) \}/)
  assert.match(source, /const caret = !force && document\.activeElement === el \? caretOffset\(\) : null/)
  assert.match(source, /const scrollPosition = \{ top: el\.scrollTop, left: el\.scrollLeft \}/)
  assert.match(source, /if \(caret != null\) focusEditorAtOffset\(caret, scrollPosition\)/)
  assert.doesNotMatch(source.slice(source.indexOf('function insertAsset'), source.indexOf('function icon(')), /focusEditorEnd\(/)
})
