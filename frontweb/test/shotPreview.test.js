import test from 'node:test'
import assert from 'node:assert/strict'
import { activeGenerationStatuses, normalizeJob, resolveShotPreviewJob, shotPreviewVideoUrl } from '../src/utils/shotPreview.js'

const adopted = { id: 1, status: 'completed', is_current: true, videoUrl: '/static/old.mp4' }
const shot = { omni_job_id: 1, video_url: adopted.videoUrl }

test('refresh prioritizes the running generation over the adopted video', () => {
  for (const status of activeGenerationStatuses) {
    const running = { id: 2, status, videoUrl: '/static/intermediate.mp4' }
    const job = resolveShotPreviewJob([running, adopted], null, shot.omni_job_id)
    assert.equal(job, running)
  }
})

test('generation stages hide the player; post-processing stages preview the base video', () => {
  for (const status of ['sd2_waiting', 'processing']) {
    const running = { id: 2, status, videoUrl: '/static/intermediate.mp4' }
    assert.equal(shotPreviewVideoUrl(running, shot), '')
  }
  for (const status of ['upscale_pending', 'upscaling', 'interpolation_pending', 'interpolating', 'persisting']) {
    const running = { id: 2, status, videoUrl: '/static/intermediate.mp4' }
    assert.equal(shotPreviewVideoUrl(running, shot), '/static/intermediate.mp4')
  }
})

test('explicit history preview remains available while another version is generating', () => {
  const running = { id: 2, status: 'processing' }
  const job = resolveShotPreviewJob([running, adopted], 1, shot.omni_job_id)
  assert.equal(job, adopted)
  assert.equal(shotPreviewVideoUrl(job, shot), adopted.videoUrl)
})

test('refresh shows reconciliation ahead of adopted video without restarting automatic polling', () => {
  const pending = { id: 2, status: 'billing_reconciliation' }
  assert.equal(resolveShotPreviewJob([pending, adopted], null, 1), pending)
  assert.equal(shotPreviewVideoUrl(pending, shot), '')
  assert.equal(resolveShotPreviewJob([pending, adopted], 1, 1), adopted)
  assert.equal(activeGenerationStatuses.has(pending.status), false)
})

test('a followed task keeps its own completion or failure instead of falling back to old media', () => {
  for (const status of ['completed', 'failed', 'unknown', 'billing_reconciliation']) {
    const latest = { id: 2, status, videoUrl: status === 'completed' ? '/static/new.mp4' : '' }
    const job = resolveShotPreviewJob([latest, adopted], 2, shot.omni_job_id)
    assert.equal(job, latest)
    assert.equal(shotPreviewVideoUrl(job, shot), latest.videoUrl)
  }
})

test('existing adopted and legacy videos remain available without an active task', () => {
  assert.equal(resolveShotPreviewJob([adopted], null, null), adopted)
  assert.equal(shotPreviewVideoUrl(null, shot), adopted.videoUrl)
  assert.equal(shotPreviewVideoUrl(null, { ...shot, status: 'processing' }), '')
})

test('polling keeps the selected Omni job identity when the video generation ID differs', () => {
  const pending = normalizeJob({ id: 20, video_generation_id: 30, generation: { id: 30, status: 'processing' } })
  assert.equal(pending.id, 20)
  const finished = normalizeJob({ id: 20, video_generation_id: 30, request_snapshot: { original_prompt: '原始提示词' }, generation: { id: 30, status: 'completed', local_path: 'new.mp4', prompt: '供应商提示词' } })
  assert.equal(finished.original_prompt, '原始提示词')
  assert.equal(finished.provider_prompt, '供应商提示词')
  assert.equal(resolveShotPreviewJob([finished, adopted], pending.id, shot.omni_job_id), finished)
  assert.match(shotPreviewVideoUrl(finished, shot), /^\/static\/new\.mp4/)
})

test('copied playback is a fallback after terminal own-task failure, while processing hides old media', () => {
  const copy = { playback_video_generation_id: 41, video_url: '/static/original.mp4', omni_job_id: 9, status: 'failed' }
  const old = { id: 7, status: 'completed', videoUrl: '/static/unrelated.mp4' }
  assert.equal(resolveShotPreviewJob([old], null, copy.omni_job_id, copy.playback_video_generation_id), null)
  const processing = { id: 9, status: 'processing', videoUrl: '' }
  assert.equal(resolveShotPreviewJob([old, processing], null, 9, 41), processing)
  assert.equal(shotPreviewVideoUrl(processing, copy), '')
  for (const status of ['failed', 'cancelled']) {
    const own = { id: 9, status, videoUrl: '' }
    assert.equal(resolveShotPreviewJob([old, own], null, 9, 41), own)
    assert.equal(shotPreviewVideoUrl(own, copy), copy.video_url)
  }
  const finished = { id: 9, status: 'completed', videoUrl: '/static/new.mp4' }
  assert.equal(shotPreviewVideoUrl(resolveShotPreviewJob([old, finished], null, 9, 41), copy), finished.videoUrl)
})

test('copied playback history can drive read-only version actions before regeneration', () => {
  const playback = { id: 'video-41', video_generation_id: 41, status: 'completed', videoUrl: '/static/original.mp4', is_playback_reference: true }
  const shot = { playback_video_generation_id: 41, video_url: '/static/original.mp4' }
  for (const projectMode of [false, true]) {
    const job = resolveShotPreviewJob([playback], null, null, shot.playback_video_generation_id, projectMode)
    assert.equal(job, playback)
    assert.equal(job.is_playback_reference, true)
    assert.equal(shotPreviewVideoUrl(job, shot), '/static/original.mp4')
  }
})

test('project current adoption wins over newer historical videos while explicit preview still works', () => {
  const current = { id: 4, video_generation_id: 41, is_current: true, status: 'completed', videoUrl: '/static/adopted.mp4' }
  const latest = { id: 5, video_generation_id: 42, status: 'completed', videoUrl: '/static/latest.mp4' }
  assert.equal(resolveShotPreviewJob([latest, current], null, 41, null, true), current)
  assert.equal(resolveShotPreviewJob([latest, current], 5, 41, null, true), latest)
})
