const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { copyStoryboard } = require('../src/services/storyboardService');

const log = { info() {}, warn() {}, error() {} };

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE storyboards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      episode_id INTEGER NOT NULL,
      scene_id INTEGER,
      storyboard_number INTEGER,
      sort_order INTEGER DEFAULT 0,
      storyboard_uid TEXT,
      position INTEGER,
      title TEXT,
      description TEXT,
      dialogue TEXT,
      image_prompt TEXT,
      video_prompt TEXT,
      generation_overrides_json TEXT,
      characters TEXT,
      creation_mode TEXT,
      universal_segment_text TEXT,
      omni_asset_ids TEXT,
      image_url TEXT,
      local_path TEXT,
      video_url TEXT,
      active_video_generation_id INTEGER,
      first_frame_image_id INTEGER,
      last_frame_image_id INTEGER,
      audio_local_path TEXT,
      status TEXT,
      error_msg TEXT,
      created_at TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );
    CREATE TABLE storyboard_characters (storyboard_id INTEGER, character_id INTEGER, created_at TEXT, PRIMARY KEY (storyboard_id, character_id));
    CREATE TABLE storyboard_props (storyboard_id INTEGER, prop_id INTEGER, PRIMARY KEY (storyboard_id, prop_id));
    CREATE TABLE frame_prompts (id INTEGER PRIMARY KEY AUTOINCREMENT, storyboard_id INTEGER, frame_type TEXT, prompt TEXT, description TEXT, layout TEXT, created_at TEXT, updated_at TEXT);
  `);
  return db;
}

test('copyStoryboard copies editable data after the source and excludes generated media', () => {
  const db = createDb();
  db.prepare(`INSERT INTO storyboards (
    episode_id, storyboard_number, sort_order, title, description, dialogue,
    image_prompt, video_prompt, generation_overrides_json, characters,
    creation_mode, universal_segment_text, omni_asset_ids, image_url, local_path,
    video_url, active_video_generation_id, first_frame_image_id, last_frame_image_id,
    audio_local_path, status, error_msg
  ) VALUES (1, 1, 0, '第一镜', '描述', '对白', '图片提示词', '视频提示词',
    '{"duration":8}', '[11]', 'universal', '@图片1 前进', '[101]',
    '/old.jpg', 'videos/old.mp4', '/old.mp4', 55, 21, 22, 'audio/old.mp3', 'completed', '旧错误')`).run();
  db.prepare("INSERT INTO storyboards (episode_id, storyboard_number, sort_order, title, status) VALUES (1, 2, 1, '第二镜', 'pending')").run();
  db.prepare('INSERT INTO storyboard_characters VALUES (1, 7, ?)').run('2026-01-01T00:00:00.000Z');
  db.prepare('INSERT INTO storyboard_props VALUES (1, 9)').run();
  db.prepare("INSERT INTO frame_prompts (storyboard_id, frame_type, prompt) VALUES (1, 'first', '首帧提示词')").run();

  const copied = copyStoryboard(db, log, 1);

  assert.equal(copied.storyboard_number, 2);
  assert.equal(copied.title, '第一镜（副本）');
  assert.equal(copied.description, '描述');
  assert.equal(copied.video_prompt, '视频提示词');
  assert.equal(copied.creation_mode, 'universal');
  const row = db.prepare('SELECT * FROM storyboards WHERE id = ?').get(copied.id);
  assert.equal(row.image_url, null);
  assert.equal(row.local_path, null);
  assert.equal(row.video_url, null);
  assert.equal(row.active_video_generation_id, null);
  assert.equal(row.first_frame_image_id, null);
  assert.equal(row.last_frame_image_id, null);
  assert.equal(row.audio_local_path, null);
  assert.equal(row.status, 'pending');
  assert.equal(row.error_msg, null);
  const sourceRow = db.prepare('SELECT storyboard_uid, position FROM storyboards WHERE id = 1').get();
  assert.ok(sourceRow.storyboard_uid);
  assert.ok(row.storyboard_uid);
  assert.notEqual(row.storyboard_uid, sourceRow.storyboard_uid);
  assert.equal(sourceRow.position, 0);
  assert.equal(row.position, 1);
  assert.deepEqual(
    db.prepare('SELECT storyboard_number, sort_order, title FROM storyboards ORDER BY sort_order').all(),
    [
      { storyboard_number: 1, sort_order: 0, title: '第一镜' },
      { storyboard_number: 2, sort_order: 1, title: '第一镜（副本）' },
      { storyboard_number: 3, sort_order: 2, title: '第二镜' },
    ]
  );
  assert.deepEqual(db.prepare('SELECT character_id FROM storyboard_characters WHERE storyboard_id = ?').all(copied.id), [{ character_id: 7 }]);
  assert.deepEqual(db.prepare('SELECT prop_id FROM storyboard_props WHERE storyboard_id = ?').all(copied.id), [{ prop_id: 9 }]);
  assert.equal(db.prepare('SELECT prompt FROM frame_prompts WHERE storyboard_id = ?').get(copied.id).prompt, '首帧提示词');
});

test('copyStoryboard returns null for a missing source', () => {
  const db = createDb();
  assert.equal(copyStoryboard(db, log, 404), null);
});

test('storyboard copy rolls back reordered shots when insertion fails', () => {
  const db = createDb();
  try {
    db.prepare("INSERT INTO storyboards (episode_id,storyboard_number,title) VALUES (1,1,'源'),(1,2,'后镜')").run();
    db.exec(`CREATE TRIGGER fail_storyboard_copy BEFORE INSERT ON storyboards
      WHEN NEW.title LIKE '%（副本）' BEGIN SELECT RAISE(ABORT, 'copy rejected'); END;`);
    const before = db.prepare('SELECT id,storyboard_number,title FROM storyboards ORDER BY id').all();
    assert.throws(() => copyStoryboard(db, log, 1), /copy rejected/);
    assert.deepEqual(db.prepare('SELECT id,storyboard_number,title FROM storyboards ORDER BY id').all(), before);
  } finally { db.close(); }
});

test('copy pins the adopted local video without copying generation ownership or history', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'storyboard-copy-playback-'));
  const db = createDb();
  try {
    db.exec(`ALTER TABLE storyboards ADD COLUMN playback_video_generation_id INTEGER;
      CREATE TABLE video_generations (id INTEGER PRIMARY KEY, status TEXT, local_path TEXT, poster_local_path TEXT, deleted_at TEXT);`);
    fs.mkdirSync(path.join(root, 'videos'));
    fs.writeFileSync(path.join(root, 'videos', 'adopted.mp4'), 'test video bytes');
    db.prepare("INSERT INTO video_generations VALUES (41,'completed','videos/adopted.mp4','videos/poster.jpg',NULL)").run();
    db.prepare("INSERT INTO video_generations VALUES (42,'completed','videos/missing.mp4',NULL,NULL)").run();
    db.prepare("INSERT INTO storyboards (episode_id,storyboard_number,title,active_video_generation_id,status) VALUES (1,1,'原镜头',41,'completed')").run();
    const copy = copyStoryboard(db, log, 1, root);
    const row = db.prepare('SELECT * FROM storyboards WHERE id=?').get(copy.id);
    assert.equal(row.playback_video_generation_id, 41);
    assert.equal(row.video_url, null);
    assert.equal(row.local_path, null);
    assert.equal(row.active_video_generation_id, null);
    assert.equal(row.status, 'pending');
    assert.equal(copy.video_url, '/static/videos/adopted.mp4');
    assert.equal(copy.poster_local_path, 'videos/poster.jpg');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM video_generations').get().n, 2);
    db.prepare('UPDATE storyboards SET active_video_generation_id=42 WHERE id=1').run();
    db.prepare('UPDATE storyboards SET deleted_at=? WHERE id=1').run(new Date().toISOString());
    assert.equal(require('../src/services/storyboardService').getStoryboardById(db, copy.id, root).video_url, copy.video_url);
    const second = copyStoryboard(db, log, copy.id, root);
    assert.equal(second.playback_video_generation_id, 41, 'copying a copy keeps the selected playback resource');
  } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('copy does not inherit playback while the source generation is active', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'storyboard-copy-active-'));
  const db = createDb();
  try {
    db.exec(`ALTER TABLE storyboards ADD COLUMN playback_video_generation_id INTEGER;
      CREATE TABLE video_generations (id INTEGER PRIMARY KEY, status TEXT, local_path TEXT, poster_local_path TEXT, deleted_at TEXT);`);
    fs.mkdirSync(path.join(root, 'videos'));
    fs.writeFileSync(path.join(root, 'videos', 'old.mp4'), 'old video');
    db.prepare("INSERT INTO video_generations VALUES (41,'completed','videos/old.mp4',NULL,NULL),(42,'processing',NULL,NULL,NULL)").run();
    db.prepare("INSERT INTO storyboards (episode_id,storyboard_number,title,active_video_generation_id,playback_video_generation_id,status) VALUES (1,1,'源',42,41,'processing')").run();
    for (const status of ['sd2_waiting', 'processing', 'upscale_pending', 'upscaling', 'interpolation_pending', 'interpolating', 'persisting']) {
      db.prepare('UPDATE video_generations SET status=? WHERE id=42').run(status);
      assert.equal(copyStoryboard(db, log, 1, root).playback_video_generation_id, null, status);
    }
  } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('a copied storyboard stays independent after the source task completes a new version', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'storyboard-copy-independent-'));
  const db = createDb();
  try {
    db.exec(`ALTER TABLE storyboards ADD COLUMN playback_video_generation_id INTEGER;
      CREATE TABLE video_generations (id INTEGER PRIMARY KEY, status TEXT, local_path TEXT, poster_local_path TEXT, deleted_at TEXT);`);
    fs.mkdirSync(path.join(root, 'videos'));
    fs.writeFileSync(path.join(root, 'videos', 'old.mp4'), 'old video');
    fs.writeFileSync(path.join(root, 'videos', 'new.mp4'), 'new video');
    db.prepare("INSERT INTO video_generations VALUES (41,'completed','videos/old.mp4',NULL,NULL),(42,'processing',NULL,NULL,NULL)").run();
    db.prepare("INSERT INTO storyboards (episode_id,storyboard_number,title,active_video_generation_id,playback_video_generation_id,status) VALUES (1,1,'源',42,41,'processing')").run();
    const copy = copyStoryboard(db, log, 1, root);
    db.prepare("UPDATE video_generations SET status='completed', local_path='videos/new.mp4' WHERE id=42").run();
    db.prepare("UPDATE storyboards SET status='completed', video_url='/static/videos/new.mp4', local_path='videos/new.mp4' WHERE id=1").run();
    const copied = db.prepare('SELECT playback_video_generation_id, video_url, local_path FROM storyboards WHERE id=?').get(copy.id);
    assert.deepEqual(copied, { playback_video_generation_id: null, video_url: null, local_path: null });
  } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('copy keeps playback for non-active source generation states', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'storyboard-copy-state-boundary-'));
  const db = createDb();
  try {
    db.exec(`ALTER TABLE storyboards ADD COLUMN playback_video_generation_id INTEGER;
      CREATE TABLE video_generations (id INTEGER PRIMARY KEY, status TEXT, local_path TEXT, poster_local_path TEXT, deleted_at TEXT);`);
    fs.mkdirSync(path.join(root, 'videos'));
    fs.writeFileSync(path.join(root, 'videos', 'old.mp4'), 'old video');
    db.prepare("INSERT INTO video_generations VALUES (40,'completed','videos/old.mp4',NULL,NULL),(41,'processing',NULL,NULL,NULL)").run();
    db.prepare("INSERT INTO storyboards (episode_id,storyboard_number,title,active_video_generation_id,playback_video_generation_id,status) VALUES (1,1,'源',41,40,'processing')").run();
    for (const status of ['completed', 'failed', 'retryable', 'unknown', 'billing_reconciliation']) {
      db.prepare('UPDATE video_generations SET status=? WHERE id=41').run(status);
      assert.equal(copyStoryboard(db, log, 1, root).playback_video_generation_id, 40, status);
    }
  } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('copy does not reference an incomplete, deleted or missing local source', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'storyboard-copy-invalid-'));
  const db = createDb();
  try {
    db.exec(`ALTER TABLE storyboards ADD COLUMN playback_video_generation_id INTEGER;
      CREATE TABLE video_generations (id INTEGER PRIMARY KEY, status TEXT, local_path TEXT, poster_local_path TEXT, deleted_at TEXT);`);
    fs.mkdirSync(path.join(root, 'videos'));
    fs.writeFileSync(path.join(root, 'videos', 'valid.mp4'), 'local fixture');
    db.prepare("INSERT INTO video_generations VALUES (1,'processing','videos/valid.mp4',NULL,NULL),(2,'completed','videos/missing.mp4',NULL,NULL),(3,'completed','videos/valid.mp4',NULL,'2026-01-01')").run();
    db.prepare("INSERT INTO storyboards (episode_id,storyboard_number,title,active_video_generation_id) VALUES (1,1,'源',1)").run();
    for (const id of [1, 2, 3, 404]) {
      db.prepare('UPDATE storyboards SET active_video_generation_id=? WHERE id=1').run(id);
      assert.equal(copyStoryboard(db, log, 1, root).playback_video_generation_id, null);
    }
  } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('legacy current video can be resolved by its exact local path, never by latest history', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'storyboard-copy-legacy-'));
  const db = createDb();
  try {
    db.exec(`ALTER TABLE storyboards ADD COLUMN playback_video_generation_id INTEGER;
      CREATE TABLE video_generations (id INTEGER PRIMARY KEY, status TEXT, local_path TEXT, poster_local_path TEXT, deleted_at TEXT);`);
    fs.mkdirSync(path.join(root, 'videos'));
    fs.writeFileSync(path.join(root, 'videos', 'adopted.mp4'), 'local fixture');
    fs.writeFileSync(path.join(root, 'videos', 'latest.mp4'), 'other fixture');
    db.prepare("INSERT INTO video_generations VALUES (41,'completed','videos/adopted.mp4',NULL,NULL),(42,'completed','videos/latest.mp4',NULL,NULL)").run();
    db.prepare("INSERT INTO storyboards (episode_id,storyboard_number,title,local_path) VALUES (1,1,'旧镜头','videos/adopted.mp4')").run();
    assert.equal(copyStoryboard(db, log, 1, root).playback_video_generation_id, 41);
    db.prepare("UPDATE storyboards SET local_path='videos/missing.mp4' WHERE id=1").run();
    assert.equal(copyStoryboard(db, log, 1, root).playback_video_generation_id, null);
  } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
