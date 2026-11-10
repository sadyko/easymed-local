// CRM_STAGE_ROLES_V1 (мигр. 284) — РОЛИ КОЛОНОК: «запись», «подтверждение», «не пришёл».
//
// Владелец (2026-11-10): «there is a setting in the CRM kanban columns; we need to add a
// booking tick (like conversion) so the system won't break». До 284 роли угадывались: «Колонка
// записи» — выбор crm_settings.booked_stage, если он допустим, иначе «Записан», иначе последняя
// открытая видимая колонка до конверсии (crm-booked-stage.js bookedStageKey); «подтверждение» —
// первая открытая видимая колонка после неё (confirmedStageKeyOf); «Не пришёл» — ключ 'no_show'
// у проигрышной колонки. Миграция ставит роли ровно тем колонкам, которые клиника использует
// СЕГОДНЯ (по ключам, порядку и сохранённому выбору — никогда по названиям): после обновления
// ничего не переезжает. Проверка — на восьми воронках: та, что дала бы старая догадка, и та,
// что стоит в базе, — одна и та же.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';
import { bookedStageKey, confirmedStageKeyOf, roleRefusal } from '../../../public/js/shared/crm-booked-stage.js';

const MIGRATIONS = path.dirname(fileURLToPath(import.meta.url));

// База версии 3.22.0: все миграции ниже 284.
function before284() {
  const db = openDb(':memory:');
  const stage = tmpDir('em-mig284-');
  for (const f of fs.readdirSync(MIGRATIONS)) {
    if (parseInt(f, 10) >= 284 || !f.endsWith('.sql')) continue;
    fs.copyFileSync(path.join(MIGRATIONS, f), path.join(stage, f));
  }
  migrate(db, stage);
  return db;
}

const stagesOf = (db) => db.prepare('SELECT key, label, position, is_active, kind FROM crm_stages ORDER BY position, key').all();
const roleOf = (db, role) => (db.prepare('SELECT key FROM crm_stages WHERE role = ?').get(role) || {}).key || null;
const roles = (db) => ({ booked: roleOf(db, 'booked'), confirmed: roleOf(db, 'confirmed'), no_show: roleOf(db, 'no_show') });

/** Что сервер 3.22.0 считал ролями этой воронки (services/crm/config.js scheduledStageKey / confirmedStageKey / noShowStageKey). */
// Ревью: 3.22.0 упорядочивал колонки с равной position через localeCompare (crm-booked-stage.js
// и экран), а не по кодам символов. Догадка 3.22.0 здесь — дословно, с тем порядком; общие
// функции 3.23.0 сравнивают ключи как SQLite.
function legacy(db) {
  const stages = stagesOf(db).sort((a, b) => (Number(a.position) || 0) - (Number(b.position) || 0) || String(a.key).localeCompare(String(b.key)))
    .map((s, i) => ({ ...s, position: i + 1 }));
  const chosen = db.prepare('SELECT booked_stage FROM crm_settings WHERE id = 1').get().booked_stage || null;
  const booked = stages.length ? bookedStageKey(stages, chosen) : null;
  const lost = stages.filter((s) => s.kind === 'lost').map((s) => s.key);
  return {
    booked,
    confirmed: stages.length ? confirmedStageKeyOf(stages, booked) : null,
    // Автоматика «Не пришёл» 3.22.0 работала только с сидовым ключом (no-show.js, visit-status.js).
    no_show: lost.includes('no_show') ? 'no_show' : null,
  };
}

const FUNNELS = [
  ['сидовая воронка', () => {}, { booked: 'scheduled', confirmed: 'approved', no_show: 'no_show' }],
  ['переименованные колонки — роли по ключам, не по названиям', (db) => {
    const names = { in_process: 'Новые', recall: 'Записан', scheduled: 'Ждём', approved: 'Не пришёл', came: 'Дошли', no_show: 'Подтверждён' };
    for (const [k, v] of Object.entries(names)) db.prepare('UPDATE crm_stages SET label = ? WHERE key = ?').run(v, k);
  }, { booked: 'scheduled', confirmed: 'approved', no_show: 'no_show' }],
  ['переставленные колонки: «Перезвонить» после «Записан»', (db) => {
    db.prepare("UPDATE crm_stages SET position = 3 WHERE key = 'recall'").run();
    db.prepare("UPDATE crm_stages SET position = 2 WHERE key = 'scheduled'").run();
  }, { booked: 'scheduled', confirmed: 'recall', no_show: 'no_show' }],
  ['скрытая «Записан» — последняя открытая видимая до конверсии', (db) => {
    db.prepare("UPDATE crm_stages SET is_active = 0 WHERE key = 'scheduled'").run();
  }, { booked: 'approved', confirmed: null, no_show: 'no_show' }],
  ['удалённая «Записан»', (db) => {
    db.prepare("DELETE FROM crm_stages WHERE key = 'scheduled'").run();
  }, { booked: 'approved', confirmed: null, no_show: 'no_show' }],
  ['выбор администратора «Перезвонить»', (db) => {
    db.prepare("UPDATE crm_settings SET booked_stage = 'recall' WHERE id = 1").run();
  }, { booked: 'recall', confirmed: 'scheduled', no_show: 'no_show' }],
  ['недопустимый выбор (проигрышная колонка) — правило по умолчанию', (db) => {
    db.prepare("UPDATE crm_settings SET booked_stage = 'stopped' WHERE id = 1").run();
  }, { booked: 'scheduled', confirmed: 'approved', no_show: 'no_show' }],
  ['недопустимый выбор (колонки нет)', (db) => {
    db.prepare("UPDATE crm_settings SET booked_stage = 'zzz' WHERE id = 1").run();
  }, { booked: 'scheduled', confirmed: 'approved', no_show: 'no_show' }],
  ['выбор после конверсии не действует', (db) => {
    db.prepare("INSERT INTO crm_stages (key, label, color, position, is_active, kind) VALUES ('later', 'Позже', '', 9, 1, 'open')").run();
    db.prepare("UPDATE crm_settings SET booked_stage = 'later' WHERE id = 1").run();
  }, { booked: 'scheduled', confirmed: 'approved', no_show: 'no_show' }],
  ['без колонки «Не пришёл» — роли нет (автоматика выключена, как и в 3.22.0)', (db) => {
    db.prepare("DELETE FROM crm_stages WHERE key = 'no_show'").run();
  }, { booked: 'scheduled', confirmed: 'approved', no_show: null }],
  ['конверсия перенесена на «Подтверждён»', (db) => {
    db.prepare("UPDATE crm_stages SET kind = 'open' WHERE key = 'came'").run();
    db.prepare("UPDATE crm_stages SET kind = 'won' WHERE key = 'approved'").run();
  }, { booked: 'scheduled', confirmed: null, no_show: 'no_show' }],
  ['скрытая «Не пришёл» — роль остаётся (сервер 3.22.0 и в скрытую ставил)', (db) => {
    db.prepare("UPDATE crm_stages SET is_active = 0 WHERE key = 'no_show'").run();
  }, { booked: 'scheduled', confirmed: 'approved', no_show: 'no_show' }],
  ['своя колонка между «Записан» и «Подтверждён» — подтверждение у неё', (db) => {
    db.prepare("INSERT INTO crm_stages (key, label, color, position, is_active, kind) VALUES ('agreed', 'Согласовано', '', 3.5, 1, 'open')").run();
  }, { booked: 'scheduled', confirmed: 'agreed', no_show: 'no_show' }],
  // Ревью: равные position (ручная правка) — порядок, какой видела клиника в 3.22.0
  // (localeCompare: «x_2» раньше «x2»), а не коды символов SQLite (наоборот).
  ['равные position: «x2» и «x_2» — колонка записи та, что была последней на экране', (db) => {
    db.prepare("DELETE FROM crm_stages WHERE key = 'scheduled'").run();
    db.prepare("INSERT INTO crm_stages (key, label, color, position, is_active, kind) VALUES ('x2', 'Икс 2', '', 4, 1, 'open'), ('x_2', 'Икс_2', '', 4, 1, 'open')").run();
  }, { booked: 'x2', confirmed: null, no_show: 'no_show' }],
  ['равные position с конверсией: «a_b» перед «a1» (конверсия) — колонка записи', (db) => {
    db.prepare("UPDATE crm_stages SET kind = 'open' WHERE key = 'came'").run();
    db.prepare("DELETE FROM crm_stages WHERE key IN ('scheduled', 'approved')").run();
    db.prepare("INSERT INTO crm_stages (key, label, color, position, is_active, kind) VALUES ('a1', 'А1', '', 2, 1, 'won'), ('a_b', 'А_Б', '', 2, 1, 'open')").run();
  }, { booked: 'a_b', confirmed: null, no_show: 'no_show' }],
];

for (const [name, seed, want] of FUNNELS) {
  test('284: роли = то, что клиника использует сегодня — ' + name, () => {
    const db = before284();
    try {
      seed(db);
      const was = legacy(db);
      assert.deepEqual(was, want, 'проверка самой проверки: старая догадка дала другое');
      migrate(db);
      assert.deepEqual(roles(db), want);
      // Ревью: после миграции равных position нет, и правила ролей 3.23.0 принимают воронку.
      const after = db.prepare('SELECT key, label, position, is_active, kind, role FROM crm_stages ORDER BY position, key').all();
      assert.equal(new Set(after.map((s) => s.position)).size, after.length, 'остались равные position');
      assert.equal(roleRefusal(after, after), null, 'сохранение колонок без правок отказано: роли миграции не проходят правила 3.23.0');
    } finally { db.close(); }
  });
}

test('284: новая база — роли сидовой воронки; одна колонка на роль; неизвестной роли нет', () => {
  const db = openDb(':memory:');
  try {
    migrate(db);
    assert.deepEqual(roles(db), { booked: 'scheduled', confirmed: 'approved', no_show: 'no_show' });
    assert.throws(() => db.prepare("UPDATE crm_stages SET role = 'booked' WHERE key = 'recall'").run(), /UNIQUE/, 'вторая колонка записи');
    assert.throws(() => db.prepare("UPDATE crm_stages SET role = 'boss' WHERE key = 'recall'").run(), /CHECK/);
    db.prepare("UPDATE crm_stages SET role = NULL WHERE key = 'approved'").run();
    db.prepare("UPDATE crm_stages SET role = NULL WHERE key = 'no_show'").run();
    assert.deepEqual(roles(db), { booked: 'scheduled', confirmed: null, no_show: null }, 'без роли можно');
    // Выбор crm_settings.booked_stage больше не читается, но столбец остаётся (откат версии).
    assert.ok(db.prepare("SELECT 1 FROM pragma_table_info('crm_settings') WHERE name = 'booked_stage'").get());
  } finally { db.close(); }
});

test('284: повторный запуск ничего не меняет', () => {
  const db = before284();
  try {
    db.prepare("UPDATE crm_settings SET booked_stage = 'recall' WHERE id = 1").run();
    migrate(db);
    const first = roles(db);
    migrate(db);
    assert.deepEqual(roles(db), first);
  } finally { db.close(); }
});
