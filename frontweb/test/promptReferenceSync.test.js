import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parse, compileScript } from '@vue/compiler-sfc'
import { createRenderer, h, nextTick, reactive } from 'vue'
import { moduleSourceUrl } from './helpers/browserModule.js'

test('remote text and delayed copied assets resolve references without publishing empty metadata', async t => {
  const file = new URL('../src/components/OmniAssetPromptEditor.vue', import.meta.url)
  const { descriptor } = parse(await readFile(file, 'utf8'))
  let source = compileScript(descriptor, { id: 'reference-sync' }).content
  for (const name of ['promptInsertion', 'assetPointerDrag', 'assetMentions']) {
    source = source.replaceAll(`'@/utils/${name}'`, `'${new URL(`../src/utils/${name}.js`, import.meta.url).href}'`)
  }
  source = source.replaceAll("'vue'", `'${import.meta.resolve('vue')}'`)
  const Component = (await import(moduleSourceUrl(source))).default
  Component.render = () => null
  globalThis.window = { addEventListener() {}, removeEventListener() {} }
  const renderer = createRenderer({
    createComment: () => ({}), insert() {}, remove() {}, parentNode() {}, nextSibling() {},
  })
  const events = []
  const props = reactive({ modelValue: '保持 @图片19 的构图', assets: [], referenceDocument: {
    text: '保持 @图片19 的构图', refs: [{ asset_id: 20, alias: '图片19', occurrence: 0, start: 3, end: 8 }],
  }, onReferences: value => events.push(value) })
  const app = renderer.createApp({ render: () => h(Component, props) })
  app.mount({})
  t.after(() => { app.unmount(); delete globalThis.window })
  const editor = app._instance.subTree.component.setupState
  await nextTick()
  assert.deepEqual(events, [], 'an empty material list during loading must not erase saved references')
  props.assets = [{ id: 20, type: 'image', name: '项目副本', reference_alias: '图片20' }]
  await nextTick()
  assert.equal(editor.resolvedReferences[0].asset_id, 20)
  assert.equal(editor.resolvedReferences[0].alias, '图片19', 'saved reference binds the old token to the project copy')
  props.modelValue = '远端修改后保持 @图片19 的构图'
  await nextTick()
  assert.equal(editor.resolvedReferences[0].start, 8)
  assert.deepEqual(events, [], 'remote changes must not create a metadata save')
  editor.insertAtCaret(props.assets[0])
  await nextTick()
  assert.equal(events.length, 1, 'a user insertion must publish the reference document')
  assert.deepEqual(events[0].refs.map(ref => ref.asset_id), [20, 20])
  props.onPick = asset => { props.assets = [...props.assets, asset] }
  await nextTick()
  editor.insertAtCaret({ id: 21, type: 'image', reference_alias: '图片21' })
  await nextTick()
  assert.ok(events.at(-1).refs.some(ref => ref.asset_id === 21), 'dropping an unselected asset waits for the parent to add it before publishing its reference')
})

test('newline insertion keeps prompt, document text, reference offsets and caret in sync across an asset refresh', async t => {
  const file = new URL('../src/components/OmniAssetPromptEditor.vue', import.meta.url)
  const { descriptor } = parse(await readFile(file, 'utf8'))
  let source = compileScript(descriptor, { id: 'newline-reference-sync' }).content
  for (const name of ['promptInsertion', 'assetPointerDrag', 'assetMentions']) {
    source = source.replaceAll(`'@/utils/${name}'`, `'${new URL(`../src/utils/${name}.js`, import.meta.url).href}'`)
  }
  source = source.replaceAll("'vue'", `'${import.meta.resolve('vue')}'`)
  const Component = (await import(moduleSourceUrl(source))).default
  Component.render = () => null
  globalThis.window = { addEventListener() {}, removeEventListener() {} }
  const renderer = createRenderer({
    createComment: () => ({}), insert() {}, remove() {}, parentNode() {}, nextSibling() {},
  })
  const original = '第一行\n第二行 @图片19\n第三行'
  const modelEvents = []
  const referenceEvents = []
  const props = reactive({
    modelValue: original,
    assets: [{ id: 20, type: 'image', name: '项目副本', reference_alias: '图片20' }],
    chosenIds: new Set([20]),
    referenceDocument: { text: original, refs: [{ asset_id: 20, alias: '图片19', occurrence: 0, start: 8, end: 13 }] },
    'onUpdate:modelValue': value => { modelEvents.push(value); props.modelValue = value },
    onReferences: value => { referenceEvents.push(value); props.referenceDocument = value },
  })
  const app = renderer.createApp({ render: () => h(Component, props) })
  app.mount({})
  t.after(() => { app.unmount(); delete globalThis.window })
  const editor = app._instance.subTree.component.setupState
  await nextTick()

  editor.lastCaretOffset = 3
  editor.insertAtCaret(props.assets[0])
  await nextTick()

  const expected = '第一行 @图片20\n第二行 @图片19\n第三行'
  assert.equal(modelEvents.at(-1), expected)
  assert.equal(props.modelValue, expected)
  assert.equal(referenceEvents.at(-1).text, expected)
  assert.equal(props.referenceDocument.text, expected)
  assert.deepEqual(referenceEvents.at(-1).refs.map(({ alias, start, end }) => ({ alias, start, end })), [
    { alias: '图片20', start: 4, end: 9 },
    { alias: '图片19', start: 14, end: 19 },
  ])
  assert.equal(editor.lastCaretOffset, 9, 'caret remains immediately after the inserted token and before the newline')

  const stableDocument = JSON.parse(JSON.stringify(props.referenceDocument))
  props.assets = [...props.assets, { id: 21, type: 'image', reference_alias: '图片21' }]
  await nextTick()
  await nextTick()
  assert.equal(props.modelValue, expected, 'asset refresh must not overwrite the prompt')
  assert.deepEqual(props.referenceDocument, stableDocument, 'asset refresh must not rewrite stable reference metadata')
  assert.equal(editor.lastCaretOffset, 9, 'asset refresh must not move the logical caret to the text end')
})
