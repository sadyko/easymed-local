// REP_BOT_CLAIMS_V1 — миграция 293: заявки бота медпредставителей на закрепление
// уже существующего врача (rep_bot_claims). Только добавление: новая таблица и
// индексы; справочник врачей и связки бота не трогаются.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';

const MIGRATIONS = path.dirname(fileURLToPath(import.meta.url));

function before293() {
  const db = openDb(':memory:');
  const stage = tmpDir('em-mig293-');
  for (const f of fs.readdirSync(MIGRATIONS)) {
    if (parseInt(f, 10) >= 293 || !f.endsWith('.sql')) continue;
    fs.copyFileSync(path.join(MIGRATIONS, f), path.join(stage, f));
  }
  migrate(db, stage);
  return db;
}

test('293: таблица заявок — колонки, ссылки, одна открытая заявка на пару врач+представитель, статусы из четырёх', () => {
  const db = before293();
  try {
    const has = () => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'rep_bot_claims'").get();
    assert.equal(has(), false);
    db.prepare("INSERT INTO users (id, username, password_hash, role, full_name, custom_role_code) VALUES (5, 'rep', 'x', 'callcenter', 'Представитель', 'medrep'), (6, 'rep2', 'x', 'callcenter', 'Второй', 'medrep')").run();
    db.prepare("INSERT INTO referral_sources (id, name, phone) VALUES (40, 'Каримов Азиз', '+998901234567')").run();
    const srcBefore = db.prepare('SELECT * FROM referral_sources ORDER BY id').all();
    migrate(db);
    assert.equal(has(), true);
    assert.deepEqual(db.prepare('SELECT * FROM referral_sources ORDER BY id').all(), srcBefore, 'справочник не тронут');

    const cols = db.prepare('PRAGMA table_info(rep_bot_claims)').all().map((c) => c.name);
    for (const c of ['id', 'referral_source_id', 'user_id', 'link_id', 'chat_id', 'entered_name', 'status',
      'prev_representative_id', 'decided_by', 'decided_at', 'created_at']) {
      assert.ok(cols.includes(c), 'нет колонки ' + c);
    }
    const fks = db.prepare('SELECT "table" t, "from" f, on_delete d FROM pragma_foreign_key_list(?)').all('rep_bot_claims');
    const fk = (f) => fks.find((x) => x.f === f);
    assert.equal(fk('referral_source_id').t, 'referral_sources');
    assert.equal(fk('referral_source_id').d, 'CASCADE', 'удалённый врач уносит свои заявки');
    assert.equal(fk('user_id').t, 'users');
    assert.equal(fk('link_id').t, 'rep_bot_links');
    assert.equal(fk('prev_representative_id').t, 'users');
    assert.equal(fk('decided_by').t, 'users');

    const ins = db.prepare("INSERT INTO rep_bot_claims (referral_source_id, user_id, chat_id, entered_name) VALUES (40, ?, '700', 'Каримов Азиз')");
    const first = Number(ins.run(5).lastInsertRowid);
    const row = db.prepare('SELECT * FROM rep_bot_claims WHERE id = ?').get(first);
    assert.equal(row.status, 'pending', 'по умолчанию — открытая');
    assert.match(row.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    assert.throws(() => ins.run(5), /UNIQUE/, 'вторая открытая на ту же пару — нет');
    ins.run(6);   // другой представитель на того же врача — можно

    db.prepare("UPDATE rep_bot_claims SET status = 'approved' WHERE id = ?").run(first);
    ins.run(5);   // закрытая + новая открытая на ту же пару — можно
    assert.throws(() => db.prepare("UPDATE rep_bot_claims SET status = 'maybe' WHERE id = ?").run(first), /CHECK/);
    for (const s of ['rejected', 'void']) db.prepare('UPDATE rep_bot_claims SET status = ? WHERE id = ?').run(s, first);

    db.prepare('DELETE FROM referral_sources WHERE id = 40').run();
    assert.equal(db.prepare('SELECT COUNT(*) n FROM rep_bot_claims').get().n, 0);
  } finally {
    db.close();
  }
});
