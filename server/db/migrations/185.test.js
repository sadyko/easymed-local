// FINAL_ROLES_SYNC_FIX_V1 (I4, мигр. 185) — умения соседа хранятся по соседу;
// пусто — «сосед ещё не сказал», и существующие строки обмена его не получают.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

test('185: у sync_peers есть caps / app_version / caps_at, по умолчанию пусто', () => {
  const db = openDb(':memory:');
  try {
    migrate(db);
    const cols = db.prepare('PRAGMA table_info(sync_peers)').all().map((c) => c.name);
    for (const c of ['caps', 'app_version', 'caps_at']) assert.ok(cols.includes(c), 'нет колонки ' + c);
    db.prepare("INSERT INTO sync_peers (node) VALUES ('B')").run();
    const r = db.prepare("SELECT caps, app_version, caps_at FROM sync_peers WHERE node = 'B'").get();
    assert.deepEqual({ ...r }, { caps: null, app_version: null, caps_at: null });
  } finally { db.close(); }
});
