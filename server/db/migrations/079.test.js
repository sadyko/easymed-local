import { test } from 'node:test';
import assert from 'node:assert';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

const fresh = () => { const db = openDb(':memory:'); migrate(db); return db; };

test('079 branch_sync_map хранит соответствие «чужая строка → своя»', () => {
  const db = fresh();
  db.prepare('INSERT INTO branch_sync_map (table_name, remote_id, local_id) VALUES (?,?,?)').run('services', 7, 512);
  const row = db.prepare('SELECT * FROM branch_sync_map').get();
  assert.equal(row.table_name, 'services');
  assert.equal(row.remote_id, 7);
  assert.equal(row.local_id, 512);
  assert.ok(row.synced_at, 'дата проставляется сама');
});

test('079 одна чужая строка не может указывать на две местные', () => {
  const db = fresh();
  db.prepare('INSERT INTO branch_sync_map (table_name, remote_id, local_id) VALUES (?,?,?)').run('services', 7, 512);
  assert.throws(
    () => db.prepare('INSERT INTO branch_sync_map (table_name, remote_id, local_id) VALUES (?,?,?)').run('services', 7, 999),
    /UNIQUE constraint failed/,
    'иначе следующая синхронизация выбирала бы из двух соответствий наугад',
  );
  // Тот же чужой id в ДРУГОЙ таблице — совершенно законная пара.
  assert.doesNotThrow(
    () => db.prepare('INSERT INTO branch_sync_map (table_name, remote_id, local_id) VALUES (?,?,?)').run('lab_panels', 7, 3),
  );
});

test('079 таблица создаётся пустой — на самой миграции ничего не переносится', () => {
  const db = fresh();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM branch_sync_map').get().n, 0);
});

test('079 обратный индекс существует — усыновление ищет по (таблица, свой id)', () => {
  const db = fresh();
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='branch_sync_map'").all()
    .map((r) => r.name);
  assert.ok(idx.includes('idx_branch_sync_map_local'), 'нужен для проверки «эта местная строка уже занята?»');
});
