const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sequences = require('../src/services/omniSequenceService');
const videos = require('../src/services/videoService');

const log = { info() {}, warn() {}, error() {} };

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-playback-'));
  const db = new Database(path.join(root, 'test.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 30');
  db.exec(`CREATE TABLE storyboards (id INTEGER PRIMARY KEY, playback_video_generation_id INTEGER, deleted_at TEXT);
    CREATE TABLE omni_video_sequences (id INTEGER PRIMARY KEY, name TEXT, is_default INTEGER DEFAULT 0, deleted_at TEXT, updated_at TEXT);
    CREATE TABLE omni_video_sequence_shots (id INTEGER PRIMARY KEY, sequence_id INTEGER, title TEXT, sort_order INTEGER, prompt TEXT,
      prompt_document_json TEXT, assets_json TEXT, settings_json TEXT, omni_job_id INTEGER,
      playback_video_generation_id INTEGER, created_at TEXT, updated_at TEXT, deleted_at TEXT);
    CREATE TABLE omni_video_jobs (id INTEGER PRIMARY KEY, sequence_id INTEGER, shot_id INTEGER, video_generation_id INTEGER);
    CREATE TABLE video_generations (id INTEGER PRIMARY KEY, status TEXT, video_url TEXT, local_path TEXT,
      poster_local_path TEXT, error_msg TEXT, deleted_at TEXT);`);
  fs.mkdirSync(path.join(root, 'videos'));
  fs.writeFileSync(path.join(root, 'videos', 'original.mp4'), 'local fixture');
  fs.writeFileSync(path.join(root, 'videos', 'new.mp4'), 'second fixture');
  db.prepare("INSERT INTO omni_video_sequences (id,name) VALUES (1,'自由创作')").run();
  db.prepare(`INSERT INTO omni_video_sequence_shots
    (id,sequence_id,title,sort_order,prompt,prompt_document_json,assets_json,settings_json,omni_job_id)
    VALUES (1,1,'原镜头',10,'提示词','{"text":"提示词","refs":[]}',
      '[{"asset_id":4,"usage":"motion"}]','{"model":"test","duration":8,"resolution":"720p"}',7)`).run();
  db.prepare("INSERT INTO video_generations VALUES (41,'completed',NULL,'videos/original.mp4','videos/poster.jpg',NULL,NULL)").run();
  db.prepare('INSERT INTO omni_video_jobs VALUES (7,1,1,41)').run();
  return { db, root, close() { db.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test('free copy pins its current local result, survives source changes, and yields to its own result', () => {
  const f = fixture();
  try {
    const copy = sequences.createShot(f.db, 1, { after_shot_id: 1, copy_source_shot_id: 1 }, f.root);
    assert.equal(copy.playback_video_generation_id, 41);
    assert.equal(copy.omni_job_id, null);
    assert.equal(copy.video_url, '/static/videos/original.mp4');
    assert.equal(copy.poster_local_path, 'videos/poster.jpg');
    assert.equal(copy.prompt, '提示词');
    assert.deepEqual(copy.assets, [{ asset_id: 4, usage: 'motion' }]);
    assert.equal(copy.settings.duration, 8);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM video_generations').get().n, 1);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM omni_video_jobs').get().n, 1);
    f.db.prepare("INSERT INTO video_generations VALUES (42,'completed',NULL,'videos/new.mp4',NULL,NULL,NULL)").run();
    f.db.prepare('INSERT INTO omni_video_jobs VALUES (8,1,1,42)').run();
    f.db.prepare('UPDATE omni_video_sequence_shots SET omni_job_id=8 WHERE id=1').run();
    assert.equal(sequences.listShots(f.db, 1, f.root).find(row => row.id === copy.id).video_url, '/static/videos/original.mp4');
    sequences.deleteShot(f.db, 1, 1);
    assert.equal(sequences.listShots(f.db, 1, f.root)[0].video_url, '/static/videos/original.mp4');
    assert.throws(() => videos.deleteById(f.db, log, 41), { code: 'VIDEO_IN_USE' });
    f.db.prepare("INSERT INTO video_generations VALUES (43,'failed',NULL,NULL,NULL,'failed',NULL)").run();
    f.db.prepare('INSERT INTO omni_video_jobs VALUES (9,1,?,43)').run(copy.id);
    f.db.prepare('UPDATE omni_video_sequence_shots SET omni_job_id=9 WHERE id=?').run(copy.id);
    assert.equal(sequences.listShots(f.db, 1, f.root)[0].video_url, '/static/videos/original.mp4');
    f.db.prepare("UPDATE video_generations SET status='completed',local_path='videos/new.mp4' WHERE id=43").run();
    assert.equal(sequences.listShots(f.db, 1, f.root)[0].video_url, '/static/videos/new.mp4');
    assert.equal(f.db.prepare('SELECT playback_video_generation_id FROM omni_video_sequence_shots WHERE id=?').get(copy.id).playback_video_generation_id, 41);
    f.db.prepare('UPDATE video_generations SET status=\'failed\', local_path=NULL WHERE id=43').run();
    assert.equal(sequences.listShots(f.db, 1, f.root)[0].video_url, '/static/videos/original.mp4');
    f.db.prepare("UPDATE video_generations SET status='cancelled' WHERE id=43").run();
    assert.equal(sequences.listShots(f.db, 1, f.root)[0].video_url, '/static/videos/original.mp4');
    assert.equal(f.db.prepare('SELECT playback_video_generation_id FROM omni_video_sequence_shots WHERE id=?').get(copy.id).playback_video_generation_id, 41);
  } finally { f.close(); }
});

test('a copied playback reference remains readable from a reopened database connection', () => {
  const f = fixture();
  try {
    const copy = sequences.createShot(f.db, 1, { after_shot_id: 1, copy_source_shot_id: 1 }, f.root);
    const reopened = new Database(path.join(f.root, 'test.db'));
    try {
      const restored = sequences.listShots(reopened, 1, f.root).find(row => row.id === copy.id);
      assert.equal(restored.playback_video_generation_id, 41);
      assert.equal(restored.video_url, '/static/videos/original.mp4');
    } finally { reopened.close(); }
  } finally { f.close(); }
});

test('invalid source does not produce a playback reference and copy failure rolls back', () => {
  const f = fixture();
  try {
    f.db.prepare("UPDATE video_generations SET local_path='videos/missing.mp4' WHERE id=41").run();
    const noVideo = sequences.createShot(f.db, 1, { after_shot_id: 1, copy_source_shot_id: 1 }, f.root);
    assert.equal(noVideo.playback_video_generation_id, null);
    f.db.prepare("UPDATE video_generations SET local_path='videos/original.mp4' WHERE id=41").run();
    f.db.exec(`CREATE TRIGGER fail_copy BEFORE INSERT ON omni_video_sequence_shots
      WHEN NEW.playback_video_generation_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'copy rejected'); END;`);
    const count = f.db.prepare('SELECT COUNT(*) n FROM omni_video_sequence_shots').get().n;
    const order = f.db.prepare('SELECT id,sort_order FROM omni_video_sequence_shots ORDER BY id').all();
    assert.throws(() => sequences.createShot(f.db, 1, { after_shot_id: 1, copy_source_shot_id: 1 }, f.root), /copy rejected/);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM omni_video_sequence_shots').get().n, count);
    assert.deepEqual(f.db.prepare('SELECT id,sort_order FROM omni_video_sequence_shots ORDER BY id').all(), order);
  } finally { f.close(); }
});

test('immediate writers serialize copy and deletion; only live references block deletion', () => {
  const f = fixture();
  const other = new Database(path.join(f.root, 'test.db'));
  other.pragma('busy_timeout = 30');
  try {
    f.db.transaction(() => {
      sequences.createShot(f.db, 1, { after_shot_id: 1, copy_source_shot_id: 1 }, f.root);
      assert.throws(() => videos.deleteById(other, log, 41), /database is locked/);
    }).immediate();
    assert.throws(() => videos.deleteById(other, log, 41), { code: 'VIDEO_IN_USE' });
    const copy = sequences.listShots(f.db, 1, f.root).find(row => row.id !== 1);
    sequences.deleteShot(f.db, 1, copy.id);
    assert.equal(videos.deleteById(other, log, 41), true);
    assert.equal(sequences.listShots(f.db, 1, f.root).some(row => row.id === copy.id), false);
  } finally { other.close(); f.close(); }
});

test('project references return an HTTP conflict and a deleted generation is never projected', () => {
  const f = fixture();
  try {
    f.db.prepare('INSERT INTO storyboards (id,playback_video_generation_id) VALUES (5,41)').run();
    let status;
    let payload;
    const response = { status(value) { status = value; return this; }, json(value) { payload = value; return this; } };
    require('../src/routes/videos')(f.db, log).delete({ params: { id: 41 } }, response);
    assert.equal(status, 409);
    assert.equal(payload.error.code, 'VIDEO_IN_USE');
    assert.equal(f.db.prepare('SELECT deleted_at FROM video_generations WHERE id=41').get().deleted_at, null);
    f.db.prepare("UPDATE storyboards SET deleted_at='2026-01-01T00:00:00.000Z' WHERE id=5").run();
    assert.equal(videos.deleteById(f.db, log, 41), true);
    assert.equal(videos.playbackGeneration(f.db, 41, f.root), null);
    f.db.prepare('UPDATE omni_video_sequence_shots SET playback_video_generation_id=41 WHERE id=1').run();
    assert.equal(sequences.listShots(f.db, 1, f.root)[0].video_url, null);
  } finally { f.close(); }
});

test('restoring a sequence keeps valid references and clears references deleted while it was inactive', () => {
  const f = fixture();
  try {
    const copy = sequences.createShot(f.db, 1, { after_shot_id: 1, copy_source_shot_id: 1 }, f.root);
    sequences.deleteSequence(f.db, 1);
    assert.equal(videos.deleteById(f.db, log, 41), true);
    sequences.restoreSequence(f.db, 1);
    assert.equal(f.db.prepare('SELECT playback_video_generation_id FROM omni_video_sequence_shots WHERE id=?').get(copy.id).playback_video_generation_id, null);
    assert.equal(sequences.listShots(f.db, 1, f.root).find(row => row.id === copy.id).video_url, null);
  } finally { f.close(); }
});
