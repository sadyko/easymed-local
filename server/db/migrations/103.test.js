// 103.test.js — PATIENT_TAB_ACCESS_V1.
//
// Вкладки карты пациента стали отдельными правами (просмотр / изменение /
// удаление). Проверяется не «SQL выполнился», а те утверждения, из-за которых
// эта работа могла бы навредить клинике:
//
//   1. НИКТО НЕ ТЕРЯЕТ ДОСТУП В ДЕНЬ ОБНОВЛЕНИЯ. Сеяные роли не содержат
//      patient_tabs, отсутствие ключа = полный доступ, и после миграции каждая
//      роль видит карту ровно так, как видела вчера. Это проверяется роль за
//      ролью, значением за значением.
//   2. СЛОВАРЬ ОДИН. id вкладок в карте (views/patient-card.js), в редакторе
//      ролей (permissions.js) и на сервере (services/roles.js) — один и тот же
//      набор. Ровно та болезнь, которую лечила 055: право, записанное под
//      именем, которого никто не спрашивает, молча не работает.
//   3. ПЕРЕИМЕНОВАНИЕ СОХРАНЯЕТ НАМЕРЕНИЕ. `overview` → `details` вместе с
//      уровнем, а старое имя продолжает читаться (его спрашивает кабинет врача).
//   4. ПРАВО, КОТОРОГО НЕТ, НЕ ОБЕЩАЕТСЯ. Уровень «Удаление» у «Счёта» и
//      «Редактирование» у «Лаборатории» понижаются до существующего, а редактор
//      таких галочек не рисует.
//   5. МИГРАЦИЯ ИДЕМПОТЕНТНА и безопасна на живой базе.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import {
  PATIENT_CARD_TABS, PATIENT_TAB_CAPS,
  patientTabLevel, canViewPatientTab, canEditPatientTab, canDeletePatientTab,
} from '../../services/roles.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const MIG = 'server/db/migrations/103_patient_card_tabs.sql';

const perms = (db, role) => JSON.parse(db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get(role).permissions);
const setPerms = (db, role, obj) => db.prepare('UPDATE role_permissions SET permissions = ? WHERE role = ?').run(JSON.stringify(obj), role);

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

// ---------------------------------------------------------------------------
// 2. Один словарь на три места.
// ---------------------------------------------------------------------------
function cardTabIds() {
  const src = read('public/js/admin/views/patient-card.js');
  const block = src.slice(src.indexOf('const TABS = ['), src.indexOf('];', src.indexOf('const TABS = [')));
  return [...block.matchAll(/\{\s*id:\s*'([^']+)'/g)].map((m) => m[1]);
}
function editorTabIds() {
  const src = read('public/js/admin/permissions.js');
  const block = src.slice(src.indexOf('export const PATIENT_TABS = ['), src.indexOf('export const PATIENT_CARD_TAB_IDS'));
  return [...block.matchAll(/\{\s*id:\s*'([^']+)'/g)].map((m) => m[1]);
}

test('каждая вкладка карты выдаётся отдельно — редактор и сервер знают тот же набор', () => {
  const card = cardTabIds();
  const editor = new Set(editorTabIds());
  const server = new Set(PATIENT_CARD_TABS);

  assert.deepEqual(card.slice().sort(), [...server].sort(), 'сервер знает ровно вкладки карты');
  const ungrantable = card.filter((id) => !editor.has(id));
  assert.deepEqual(ungrantable, [], 'вкладки, которые нельзя выдать в «Настройки → Роли»:\n' + ungrantable.join('\n'));
});

test('редактор не предлагает ключей, которых карта не спрашивает', () => {
  const known = new Set([...cardTabIds(), 'recommended']);   // recommended — гейт кнопки в кабинете врача
  const dead = editorTabIds().filter((id) => !known.has(id));
  assert.deepEqual(dead, [], 'галочки, которые ничего не делают:\n' + dead.join('\n'));
});

test('удаление предлагается ТОЛЬКО там, где оно существует', () => {
  // Счёт: реестр таблиц запрещает удаление счетов, позиций и оплат ВСЕМ.
  const registry = read('server/db/schema-registry.js');
  for (const t of ['invoices', 'invoice_items', 'payments']) {
    const block = registry.slice(registry.indexOf('\n  ' + t + ': {'));
    const write = block.slice(0, block.indexOf('filters:'));
    assert.match(write, /delete: \{ roles: \[\] \}/, t + ': удаления не существует ни у одной роли');
  }
  assert.equal(PATIENT_TAB_CAPS.billing.del, false, '«Счёт» не обещает удаления');
  assert.equal(PATIENT_TAB_CAPS.billing.edit, false, '«Счёт» не обещает изменения — деньги пишет касса');
  assert.equal(PATIENT_TAB_CAPS.labs.edit, false, 'результаты вносит раздел «Лаборатория»');
  assert.equal(PATIENT_TAB_CAPS.visits.del, false, 'удаления визита в карте нет');
  assert.equal(PATIENT_TAB_CAPS.details.del, false, 'удаление пациента живёт в «Настройки → Пациенты»');
  assert.equal(PATIENT_TAB_CAPS.services.del, true, 'неоплаченную услугу убрать можно (remove_unpaid_service)');
  assert.equal(PATIENT_TAB_CAPS.docs.del, true, 'документ удалить можно (visit_documents.delete)');

  // Редактор рисует прочерк вместо галочки там, где права не существует.
  const editor = read('public/js/admin/views/section-crud.js');
  assert.match(editor, /caps\.edit \? chk\('Редакт\./, 'галочка «Редакт.» рисуется по caps');
  assert.match(editor, /caps\.del\s+\? chk\('Удаление'/, 'галочка «Удаление» рисуется по caps');
});

// ---------------------------------------------------------------------------
// 1. День обновления: доступ не меняется ни у одной роли.
// ---------------------------------------------------------------------------
const SEEDED_ROLES = ['admin', 'registrar', 'doctor', 'cashier', 'lab', 'nurse', 'inventory', 'callcenter', 'head_doctor', 'senior_nurse'];

test('после 103 ни одна сеяная роль не имеет настроек вкладок — то есть видит карту как вчера', () => {
  const db = fresh();
  for (const role of SEEDED_ROLES) {
    const p = perms(db, role);
    assert.equal(p.patient_tabs, undefined, role + ': миграция не выдумывает ограничений');
  }
  db.close();
});

test('роль за ролью: по умолчанию открыты ВСЕ вкладки карты, на максимуме того, что вкладка умеет', () => {
  const db = fresh();
  for (const role of SEEDED_ROLES) {
    const user = { id: 1, role };
    for (const tab of PATIENT_CARD_TABS) {
      assert.equal(canViewPatientTab(db, user, tab), true, role + ' видит «' + tab + '»');
      assert.equal(canEditPatientTab(db, user, tab), PATIENT_TAB_CAPS[tab].edit, role + ' правит «' + tab + '» ровно если там есть что править');
      assert.equal(canDeletePatientTab(db, user, tab), PATIENT_TAB_CAPS[tab].del, role + ' удаляет на «' + tab + '» ровно если там есть что удалять');
    }
  }
  db.close();
});

// ---------------------------------------------------------------------------
// 3. Переименование `overview` → `details`.
// ---------------------------------------------------------------------------
test('103 переименовывает overview → details, сохраняя уровень', () => {
  const db = fresh();
  setPerms(db, 'registrar', {
    sections: ['patients'], levels: { patients: 'editor' },
    patient_tabs: { overview: 'view', billing: 'none' },
  });
  db.exec(read(MIG));

  const p = perms(db, 'registrar');
  assert.equal(p.patient_tabs.details, 'view', 'намерение администратора сохранено под новым именем');
  assert.equal(p.patient_tabs.overview, undefined, 'мёртвое имя ушло');
  assert.equal(p.patient_tabs.billing, 'none', 'остальные настройки не тронуты');

  const user = { id: 2, role: 'registrar' };
  assert.equal(patientTabLevel(db, user, 'details'), 'view');
  assert.equal(patientTabLevel(db, user, 'overview'), 'view', 'старое имя продолжает читаться (кабинет врача спрашивает его)');
  db.close();
});

test('старое имя читается и ДО миграции — обновление не оставляет дыры между шагами', () => {
  const db = fresh();
  setPerms(db, 'nurse', { sections: ['patients'], levels: {}, patient_tabs: { overview: 'none' } });
  assert.equal(canViewPatientTab(db, { id: 3, role: 'nurse' }, 'details'), false);
  db.close();
});

// ---------------------------------------------------------------------------
// 4. Понижение несуществующих уровней.
// ---------------------------------------------------------------------------
test('103 понижает уровень, которого не существует, до существующего', () => {
  const db = fresh();
  setPerms(db, 'cashier', {
    sections: ['patients'], levels: { patients: 'editor' },
    patient_tabs: { billing: 'delete', labs: 'edit', visits: 'delete', details: 'delete', services: 'delete', docs: 'delete' },
  });
  db.exec(read(MIG));
  const t = perms(db, 'cashier').patient_tabs;
  assert.equal(t.billing, 'view', '«Счёт» — только просмотр: писать и удалять там нечего');
  assert.equal(t.labs, 'view', '«Лаборатория» — только просмотр: результаты вносит свой раздел');
  assert.equal(t.visits, 'edit', 'удаления визита в карте нет');
  assert.equal(t.details, 'edit', 'удаления пациента в карте нет');
  assert.equal(t.services, 'delete', 'а вот здесь удаление настоящее — оно остаётся');
  assert.equal(t.docs, 'delete', 'и здесь тоже');
  db.close();
});

test('уровень выше возможного не выдаёт лишних прав даже без миграции', () => {
  const db = fresh();
  setPerms(db, 'lab', { sections: ['patients'], levels: {}, patient_tabs: { billing: 'delete' } });
  const user = { id: 4, role: 'lab' };
  assert.equal(patientTabLevel(db, user, 'billing'), 'view');
  assert.equal(canEditPatientTab(db, user, 'billing'), false);
  assert.equal(canDeletePatientTab(db, user, 'billing'), false);
  db.close();
});

// ---------------------------------------------------------------------------
// 5. Идемпотентность и безопасность на живой базе.
// ---------------------------------------------------------------------------
test('103 идемпотентна — повторный прогон ничего не меняет', () => {
  const db = fresh();
  setPerms(db, 'doctor', { sections: ['patients'], levels: {}, patient_tabs: { overview: 'edit', billing: 'delete' } });
  db.exec(read(MIG));
  const once = db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get('doctor').permissions;
  db.exec(read(MIG));
  db.exec(read(MIG));
  const thrice = db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get('doctor').permissions;
  assert.equal(thrice, once);
  db.close();
});

test('103 не трогает разделы, роли и любой другой JSON строки прав', () => {
  const db = fresh();
  const before = db.prepare('SELECT role, permissions FROM role_permissions ORDER BY role').all();
  db.exec(read(MIG));
  const after = db.prepare('SELECT role, permissions FROM role_permissions ORDER BY role').all();
  assert.deepEqual(after, before, 'на чистой базе миграция — no-op');
  db.close();
});

test('103 не ломает строку с невалидным JSON (такие в живых базах встречаются)', () => {
  const db = fresh();
  db.prepare('UPDATE role_permissions SET permissions = ? WHERE role = ?').run('not json', 'inventory');
  db.exec(read(MIG));
  assert.equal(db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get('inventory').permissions, 'not json');
  // и такая роль не роняет проверку прав — она просто ничего не ограничивает
  assert.equal(canViewPatientTab(db, { id: 5, role: 'inventory' }, 'billing'), true);
  db.close();
});

// ---------------------------------------------------------------------------
// Несколько ролей: «Дополнительные роли» ДОБАВЛЯЮТ, а не отнимают.
// ---------------------------------------------------------------------------
test('несколько ролей — самая щедрая настройка вкладки', () => {
  const db = fresh();
  setPerms(db, 'nurse',  { sections: ['patients'], levels: {}, patient_tabs: { billing: 'none', docs: 'view' } });
  setPerms(db, 'doctor', { sections: ['patients'], levels: {}, patient_tabs: { billing: 'view', docs: 'delete' } });
  const user = { id: 6, role: 'nurse', extra_roles: ['doctor'] };
  assert.equal(patientTabLevel(db, user, 'billing'), 'view', 'вторая роль открывает то, что закрыла первая');
  assert.equal(patientTabLevel(db, user, 'docs'), 'delete');
  db.close();
});

test('роль без строки прав вкладок не ограничивает — отказ живёт на уровне раздела', () => {
  const db = fresh();
  db.prepare('DELETE FROM role_permissions WHERE role = ?').run('nurse');
  assert.equal(patientTabLevel(db, { id: 7, role: 'nurse' }, 'billing'), 'view');
  db.close();
});
