import test from 'node:test'
import assert from 'node:assert/strict'

import { clampTextOffset, insertTokenAtOffset } from '../src/utils/promptInsertion.js'

test('inserts an asset token at a middle caret without moving surrounding text', () => {
  assert.deepEqual(insertTokenAtOffset('镜头从门口推进然后转场', '@人物', 7), {
    text: '镜头从门口推进 @人物 然后转场',
    caret: 12,
  })
})

test('does not duplicate spacing around a dropped token', () => {
  assert.deepEqual(insertTokenAtOffset('前景  后景', '@图片2', 3), {
    text: '前景 @图片2 后景',
    caret: 7,
  })
})

test('keeps a token on the previous line when inserted before a newline', () => {
  assert.deepEqual(insertTokenAtOffset('第一行\n第二行', '@素材', 3), {
    text: '第一行 @素材\n第二行',
    caret: 7,
  })
})

test('keeps a token at the next line start when inserted after a newline', () => {
  assert.deepEqual(insertTokenAtOffset('第一行\n第二行', '@素材', 4), {
    text: '第一行\n@素材 第二行',
    caret: 8,
  })
})

test('adds only the necessary separator at text boundaries', () => {
  assert.deepEqual(insertTokenAtOffset('后景', '@素材', 0), {
    text: '@素材 后景',
    caret: 4,
  })
  assert.deepEqual(insertTokenAtOffset('前景', '@素材', 2), {
    text: '前景 @素材',
    caret: 6,
  })
})

test('invalid offsets safely fall back to the end', () => {
  assert.equal(clampTextOffset('abc', Number.NaN), 3)
  assert.equal(insertTokenAtOffset('abc', '@x').text, 'abc @x')
})
