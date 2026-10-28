import test from 'node:test'
import assert from 'node:assert/strict'
import { copyText } from '../src/utils/clipboard.js'

function fakeDocument(copyResult = true) {
  const state = { appended: null, command: null, removed: false, focused: false, selected: false }
  const textarea = {
    style: {},
    setAttribute() {},
    focus() { state.focused = true },
    select() { state.selected = true },
    remove() { state.removed = true },
  }
  const document = {
    body: { appendChild(node) { state.appended = node } },
    createElement(tag) {
      assert.equal(tag, 'textarea')
      return textarea
    },
    execCommand(command) {
      state.command = command
      return copyResult
    },
  }
  return { document, state, textarea }
}

test('uses Clipboard API when writeText succeeds', async () => {
  const calls = []
  const fallback = fakeDocument()

  await copyText('原始提示词', {
    navigator: { clipboard: { async writeText(value) { calls.push(value) } } },
    document: fallback.document,
  })

  assert.deepEqual(calls, ['原始提示词'])
  assert.equal(fallback.state.appended, null)
})

test('uses the legacy copy command when Clipboard API is unavailable', async () => {
  const fallback = fakeDocument()

  await copyText('普通 HTTP 提示词', { navigator: {}, document: fallback.document })

  assert.equal(fallback.textarea.value, '普通 HTTP 提示词')
  assert.equal(fallback.state.focused, true)
  assert.equal(fallback.state.selected, true)
  assert.equal(fallback.state.command, 'copy')
  assert.equal(fallback.state.removed, true)
})

test('falls back when Clipboard API writeText is rejected', async () => {
  const fallback = fakeDocument()

  await copyText('权限拒绝后的提示词', {
    navigator: { clipboard: { async writeText() { throw new Error('NotAllowedError') } } },
    document: fallback.document,
  })

  assert.equal(fallback.textarea.value, '权限拒绝后的提示词')
  assert.equal(fallback.state.command, 'copy')
  assert.equal(fallback.state.removed, true)
})

test('preserves long Chinese prompts, newlines and asset references exactly', async () => {
  const fallback = fakeDocument()
  const prompt = `${'夜景中的城市天台，'.repeat(80)}\n角色说：“继续拍摄。”\n@主角素材 @场景-夜景素材`

  await copyText(prompt, { navigator: {}, document: fallback.document })

  assert.equal(fallback.textarea.value, prompt)
  assert.equal(fallback.state.command, 'copy')
  assert.equal(fallback.state.removed, true)
})

test('rejects when neither copy path succeeds and still removes the textarea', async () => {
  const fallback = fakeDocument(false)

  await assert.rejects(copyText('无法复制', { navigator: {}, document: fallback.document }), /rejected/)
  assert.equal(fallback.state.removed, true)
})
