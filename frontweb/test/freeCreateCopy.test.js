import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parse, compileScript } from '@vue/compiler-sfc'
import { computed, isReactive, reactive, ref, toRaw } from 'vue'
import { resolveAssetReferences } from '../src/utils/assetMentions.js'

// Execute the view's real copy handlers; only persistence and shot loading are faked.
const { descriptor } = parse(await readFile(new URL('../src/views/FreeCreate.vue', import.meta.url), 'utf8'))
const { scriptSetupAst } = compileScript(descriptor, { id: 'free-create-copy-test' })
const handlers = ['copyShot', 'copyCurrentShot', 'addShot', 'setPromptReferences']
const handlerSource = handlers.map(name => {
  const node = scriptSetupAst.find(node => node.type === 'FunctionDeclaration' && node.id.name === name)
  assert.ok(node, `missing handler ${name}`)
  return descriptor.scriptSetup.content.slice(node.start, node.end)
}).join('\n')
const jsonCopy = value => JSON.parse(JSON.stringify(value))
const initialSettings = {
  model: 'test-video-model', creationMode: 'first_last_frame', aspectRatio: '9:16', duration: 12,
  resolution: '720p', upscaleResolution: '1080p', targetFps: 60, audioStrategy: 'post_mix',
  keepOriginalAudio: false, audioVolume: 0, audioFadeSeconds: 2,
}

function harness(document) {
  const prompt = ref('镜头推进 @图片11，保持 @图片12；配合 @音频13\n第二行 🎬')
  const promptDocument = ref(document === undefined ? {
    text: prompt.value,
    refs: [reactive({ asset_id: 11, alias: '图片11', occurrence: 0, start: 5, end: 10,
      metadata: reactive({ tags: ['first-frame'], source: { id: 101 } }) }),
    { asset_id: 12, alias: '图片12', occurrence: 0, start: 14, end: 19 },
    { asset_id: 13, alias: '音频13', occurrence: 0, start: 23, end: 28 }],
    unresolved: [{ alias: '待选择', occurrence: 0, candidate_asset_ids: [21, 22] }],
    version: 1, metadata: { note: '保留扩展业务字段', flags: [true, false, null] },
  } : document)
  const source = { id: 1, prompt: prompt.value, prompt_document: promptDocument.value,
    settings: jsonCopy(initialSettings), assets: [{ asset_id: 11, usage: 'first_frame' },
      { asset_id: 12, usage: 'last_frame' }, { asset_id: 13, usage: 'post_mix' }] }
  const shots = ref([source]), activeShotId = ref(1)
  const currentShot = computed(() => shots.value.find(shot => shot.id === activeShotId.value))
  const selectedOrder = ref([12, 11, 13]), selected = ref(new Set())
  const assets = ref([{ id: 11, type: 'image', usage: 'first_frame' },
    { id: 12, type: 'image', usage: 'last_frame' }, { id: 13, type: 'audio', usage: 'post_mix' }])
  const chosenAssets = computed(() => selectedOrder.value.map(id => assets.value.find(asset => asset.id === id)))
  const settings = Object.fromEntries(Object.entries(initialSettings).map(([key, value]) => [key, ref(value)]))
  const messages = [], saved = []
  function loadShot(shot) {
    activeShotId.value = shot.id
    prompt.value = shot.prompt || ''
    promptDocument.value = shot.prompt_document || { text: '', refs: [] }
    selectedOrder.value = (shot.assets || []).map(asset => asset.asset_id)
    for (const [key, state] of Object.entries(settings)) state.value = shot.settings?.[key] ?? null
    for (const asset of assets.value) asset.usage = shot.assets?.find(item => item.asset_id === asset.id)?.usage || 'reference'
  }
  const state = {
    prompt, promptDocument, shots, activeShotId, currentShot, selectedOrder, selected, assets, chosenAssets,
    ...settings, isProjectMode: ref(false), reproductionMode: ref(null), sequence: ref({ id: 7 }),
    resolvedPromptDocument: computed(() => resolveAssetReferences(prompt.value, assets.value, promptDocument.value)),
    async saveCurrentShot() {
      Object.assign(currentShot.value, jsonCopy({ prompt: prompt.value, prompt_document: promptDocument.value,
        settings: Object.fromEntries(Object.entries(settings).map(([key, state]) => [key, state.value])),
        assets: chosenAssets.value.map(asset => ({ asset_id: asset.id, usage: asset.usage })) }))
      saved.push(jsonCopy(currentShot.value))
    },
    async selectShot(shot) { await state.saveCurrentShot(); loadShot(shots.value.find(item => item.id === shot.id)); return true },
    omniVideoAPI: {
      async addShot(sequenceId, body) {
        assert.equal(sequenceId, 7)
        assert.equal(body.after_shot_id, activeShotId.value)
        assert.equal(body.copy_source_shot_id, activeShotId.value)
        const origin = currentShot.value
        const shot = { id: Math.max(...shots.value.map(shot => shot.id)) + 1,
          prompt: origin.prompt, prompt_document: jsonCopy(origin.prompt_document),
          settings: jsonCopy(origin.settings), assets: jsonCopy(origin.assets), omni_job_id: null }
        shots.value.splice(shots.value.findIndex(shot => shot.id === body.after_shot_id) + 1, 0, shot)
        return shot
      },
      async getSequence() { return jsonCopy({ id: 7, shots: shots.value }) },
    },
    loadShot,
    ElMessage: { success: message => messages.push(['success', message]), error: message => messages.push(['error', message]) },
  }
  const functions = new Function(...Object.keys(state), `${handlerSource}\nreturn { ${handlers.join(', ')} }`)(...Object.values(state))
  return { ...state, ...functions, saved, messages }
}

test('copy handles nested Vue proxies and preserves text, all document fields, materials and parameters', async () => {
  const state = harness()
  state.currentShot.value.omni_job_id = 77
  const originalDocument = state.promptDocument.value
  assert.ok(isReactive(originalDocument))
  assert.ok(isReactive(originalDocument.refs[0]))
  assert.throws(() => structuredClone(originalDocument), { name: 'DataCloneError' })
  assert.throws(() => structuredClone(toRaw(originalDocument)), { name: 'DataCloneError' }, 'root toRaw is insufficient for nested proxies')
  const expected = jsonCopy(originalDocument)
  await state.copyShot(state.currentShot.value)
  assert.equal(state.messages.at(-1)?.[0], 'success', JSON.stringify(state.messages))
  assert.equal(state.shots.value.length, 2)
  assert.equal(state.activeShotId.value, 2)
  assert.equal(state.currentShot.value.omni_job_id, null)
  assert.deepEqual(jsonCopy(state.promptDocument.value), expected)
  assert.equal(state.prompt.value, expected.text)
  assert.deepEqual(state.saved.at(-1).settings, initialSettings)
  assert.deepEqual(state.selectedOrder.value, [12, 11, 13])
  assert.deepEqual(state.saved.at(-1).assets, [
    { asset_id: 12, usage: 'last_frame' }, { asset_id: 11, usage: 'first_frame' }, { asset_id: 13, usage: 'post_mix' },
  ])
  assert.deepEqual([...state.selected.value].sort(), [11, 12, 13])
  state.promptDocument.value.refs[0].metadata.tags.push('copy-only')
  state.promptDocument.value.metadata.flags[0] = false
  originalDocument.refs[0].metadata.source.id = 999
  assert.deepEqual(originalDocument.refs[0].metadata.tags, ['first-frame'])
  assert.equal(originalDocument.metadata.flags[0], true)
  assert.equal(state.promptDocument.value.refs[0].metadata.source.id, 101)
  // A JSON round trip models re-reading the persisted copy after refresh.
  const reloaded = jsonCopy(state.saved.at(-1))
  state.loadShot(reloaded)
  assert.deepEqual(jsonCopy(state.promptDocument.value), expected)
  state.shots.value[0].assets[0].usage = 'reference'
  state.shots.value[0].settings.duration = 5
  assert.equal(reloaded.assets[0].usage, 'last_frame')
  assert.equal(reloaded.settings.duration, 12)
})

test('legacy shot without a prompt document copies with text and empty refs', async () => {
  const state = harness(null)
  const text = state.prompt.value
  state.upscaleResolution.value = null
  state.targetFps.value = null
  await state.copyCurrentShot()
  assert.equal(state.messages.at(-1)?.[0], 'success')
  assert.deepEqual(jsonCopy(state.promptDocument.value), { text, refs: [] })
  assert.equal(state.saved.at(-1).settings.upscaleResolution, null)
  assert.equal(state.saved.at(-1).settings.targetFps, null)
})

test('clicking another shot copies that shot after selection and keeps the existing shot unchanged', async () => {
  const state = harness()
  const first = jsonCopy(state.currentShot.value)
  const other = { id: 2, prompt: '另一镜头 @图片11', prompt_document: { text: '另一镜头 @图片11', refs: [{ asset_id: 11, alias: '图片11' }] },
    settings: { ...initialSettings, duration: 8 }, assets: [{ asset_id: 11, usage: 'reference' }] }
  state.shots.value.push(other)
  await state.copyShot(state.shots.value[1])
  assert.equal(state.messages.at(-1)?.[0], 'success')
  assert.equal(state.activeShotId.value, 3)
  assert.equal(state.prompt.value, other.prompt)
  assert.deepEqual(jsonCopy(state.promptDocument.value), other.prompt_document)
  assert.equal(state.duration.value, 8)
  assert.equal(state.shots.value[0].prompt, first.prompt)
})
