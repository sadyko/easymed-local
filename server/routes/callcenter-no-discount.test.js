// CALLCENTER_NO_DISCOUNT_V1 (3.25.0) — владелец о колл-центре: «they create
// booking only, they cannot set the discount».
//
// Оператор заводит карту пациента из заявки CRM (окно «Пациент из заявки» →
// /api/db insert в patients, затем crm_link_new_patient). Реестр пускал
// category_id в эту вставку, а категория со скидкой (процент или ставки по
// услугам) даёт скидку на каждый счёт пациента сама. Здесь — серверный замок
// (routes/db.js → domain/patient-category-guard.js) через настоящие роли:
//   • только-колл-центр: категория со скидкой — отказ 403 словами, карта не
//     заводится; категория без скидки и пустая — можно;
//   • правка карты: ни поставить, ни снять, ни сменить категорию со скидкой;
//   • регистратура, администратор и колл-центр с ролью регистратуры — как прежде.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, addLead } from '../test-helpers/crm-unify-app.js';
import { STRINGS } from '../../public/js/admin/i18n-strings.js';
import { callcenterCategoryRefusal, CALLCENTER_DISCOUNT_REFUSAL } from '../services/domain/patient-category-guard.js';
import { RPC } from '../services/rpc/index.js';

function seed(db) {
  db.prepare("INSERT INTO patient_categories (id, name, discount_percent, active) VALUES (501, 'Сотрудники', 100, 1)").run();
  db.prepare("INSERT INTO patient_categories (id, name, discount_percent, active, discount_rates) VALUES (502, 'Партнёры', 0, 1, '{\"g\":{\"consultation\":100}}')").run();
  db.prepare("INSERT INTO patient_categories (id, name, discount_percent, active) VALUES (503, 'Взрослый', 0, 1)").run();
  db.prepare("INSERT INTO patient_categories (id, name, discount_percent, active) VALUES (504, 'VIP (выключена)', 10, 0)").run();
  db.prepare("INSERT INTO patient_categories (id, name, discount_percent, active, discount_rates) VALUES (505, 'Ставки по нулям', 0, 1, '{\"g\":{\"lab\":0}}')").run();
  // Оператор Б — колл-центр с дополнительной ролью регистратуры: права регистратуры.
  db.prepare("UPDATE users SET extra_roles = '[\"registrar\"]' WHERE id = 4").run();
}

const card = (category_id, phone = '+998901112233') => ({
  table: 'patients', op: 'insert', returning: true, single: 'single',
  values: { full_name: 'Новый Пациент', first_name: 'Новый', last_name: 'Пациент', phone, ...(category_id === undefined ? {} : { category_id }) },
});
const patientsCount = (db) => db.prepare('SELECT COUNT(*) n FROM patients').get().n;

test('только-колл-центр: карта с группой со скидкой (процент, ставки, выключенная) — отказ, карта не заведена', async () => {
  const t = await startCrmApp(seed);
  try {
    const before = patientsCount(t.db);
    for (const who of ['cc', 'head']) {          // head — своя роль клиники на основе колл-центра
      for (const cat of [501, 502, 504]) {
        const r = await t.dbq(who, card(cat));
        assert.equal(r.status, 403, `${who}, категория ${cat}: ${r.text}`);
        assert.equal(r.json.error.message, CALLCENTER_DISCOUNT_REFUSAL);
      }
    }
    assert.equal(patientsCount(t.db), before, 'ни одной карты');
  } finally { t.close(); }
});

test('только-колл-центр: группа без скидки (0 %, ставки по нулям) и без группы — карта заводится', async () => {
  const t = await startCrmApp(seed);
  try {
    let n = 0;
    for (const [cat, want] of [[503, 503], [505, 505], [null, null], ['', null], [undefined, null]]) {
      const r = await t.dbq('cc', card(cat, '+99890600000' + (n++)));
      assert.equal(r.status, 200, `категория ${cat}: ${r.text}`);
      assert.equal(t.db.prepare('SELECT category_id FROM patients WHERE id = ?').get(r.json.data.id).category_id, want);
    }
  } finally { t.close(); }
});

test('пачка карт колл-центра с одной группой со скидкой — отказ целиком', async () => {
  const t = await startCrmApp(seed);
  try {
    const before = patientsCount(t.db);
    const r = await t.dbq('cc', { table: 'patients', op: 'insert',
      values: [{ full_name: 'А Б', category_id: 503 }, { full_name: 'В Г', category_id: 501 }] });
    assert.equal(r.status, 403, r.text);
    assert.equal(patientsCount(t.db), before);
  } finally { t.close(); }
});

test('регистратура, администратор и колл-центр с ролью регистратуры ставят группу со скидкой, как прежде', async () => {
  const t = await startCrmApp(seed);
  try {
    let n = 0;
    for (const who of ['reg', 'boss', 'cc2']) {
      const r = await t.dbq(who, card(501, '+99890700000' + (n++)));
      assert.equal(r.status, 200, `${who}: ${r.text}`);
      assert.equal(t.db.prepare('SELECT category_id FROM patients WHERE id = ?').get(r.json.data.id).category_id, 501);
    }
    // регистратура меняет группу на другую со скидкой и снимает её
    const pid = t.db.prepare("SELECT id FROM patients WHERE category_id = 501 ORDER BY id LIMIT 1").get().id;
    for (const next of [502, null]) {
      const u = await t.dbq('reg', { table: 'patients', op: 'update', values: { category_id: next }, filters: [{ col: 'id', op: 'eq', val: pid }] });
      assert.equal(u.status, 200, u.text);
      assert.equal(t.db.prepare('SELECT category_id FROM patients WHERE id = ?').get(pid).category_id, next);
    }
  } finally { t.close(); }
});

test('правка карты колл-центром: ни через /api/db, ни через карту пациента — группа со скидкой остаётся', async () => {
  const t = await startCrmApp(seed);
  try {
    t.db.prepare('UPDATE patients SET category_id = 501 WHERE id = 77').run();
    for (const next of [503, null, 502]) {
      const u = await t.dbq('cc', { table: 'patients', op: 'update', values: { category_id: next }, filters: [{ col: 'id', op: 'eq', val: 77 }] });
      assert.equal(u.status, 403, u.text);
      const c = await t.rpc('patient_card_save', 'cc', { patient_id: 77, values: { category_id: next } });
      assert.equal(c.status, 403, c.text);
    }
    assert.equal(t.db.prepare('SELECT category_id FROM patients WHERE id = 77').get().category_id, 501);
  } finally { t.close(); }
});

test('правило правки (замок не полагается только на реестр): поставить, снять, сменить группу со скидкой — отказ; без скидки — можно', async () => {
  const t = await startCrmApp(seed);
  try {
    const cc = { id: 3, role: 'callcenter', extra_roles: [] };
    const ccReg = { id: 4, role: 'callcenter', extra_roles: ['registrar'] };
    const ccAdminExtra = { id: 4, role: 'callcenter', extra_roles: ['admin'] };
    const reg = { id: 2, role: 'registrar', extra_roles: ['callcenter'] };
    const R = (user, next, current) => callcenterCategoryRefusal(t.db, user, { next, current });
    assert.equal(R(cc, 501, [503]), CALLCENTER_DISCOUNT_REFUSAL, 'поставить со скидкой');
    assert.equal(R(cc, 503, [501]), CALLCENTER_DISCOUNT_REFUSAL, 'сменить со скидкой на без скидки');
    assert.equal(R(cc, null, [502]), CALLCENTER_DISCOUNT_REFUSAL, 'снять со скидкой');
    assert.equal(R(cc, 501, [501]), null, 'то же значение — не правка');
    assert.equal(R(cc, '501', [501]), null, 'то же значение строкой');
    assert.equal(R(cc, 503, [null]), null, 'без скидки на пустую');
    assert.equal(R(cc, 505, [503]), null, 'без скидки на без скидки');
    assert.equal(R(cc, 501, []), CALLCENTER_DISCOUNT_REFUSAL, 'новая карта');
    for (const u of [ccReg, ccAdminExtra, reg]) assert.equal(R(u, 501, [503]), null, JSON.stringify(u));
  } finally { t.close(); }
});

test('заявка CRM → карта: группа без скидки — карта и привязка к заявке; со скидкой — ни карты, ни привязки', async () => {
  const t = await startCrmApp(seed);
  try {
    const lead = addLead(t.db, { patient: null, phone: '+998 93 555 11 22', name: 'Каримов' });
    const bad = await t.dbq('cc', { ...card(501, '+998 93 555 11 22'), values: { ...card(501).values, full_name: 'Каримов Али', last_name: 'Каримов', first_name: 'Али', phone: '+998 93 555 11 22' } });
    assert.equal(bad.status, 403, bad.text);
    assert.equal(t.lead(lead).patient_id, null);
    const ok = await t.dbq('cc', { ...card(503), values: { ...card(503).values, full_name: 'Каримов Али', last_name: 'Каримов', first_name: 'Али', phone: '+998 93 555 11 22' } });
    assert.equal(ok.status, 200, ok.text);
    const link = await t.rpc('crm_link_new_patient', 'cc', { patient_id: ok.json.data.id });
    assert.equal(link.status, 200, link.text);
    assert.equal(t.lead(lead).patient_id, ok.json.data.id);
    assert.equal(t.db.prepare('SELECT category_id FROM patients WHERE id = ?').get(ok.json.data.id).category_id, 503);
  } finally { t.close(); }
});

test('отказ переведён: статья словаря ru/uz/en, в uz и en нет кириллицы', () => {
  const e = STRINGS[CALLCENTER_DISCOUNT_REFUSAL];
  assert.ok(e, 'статья словаря есть');
  assert.equal(e.ru, CALLCENTER_DISCOUNT_REFUSAL);
  for (const lang of ['uz', 'en']) {
    assert.ok(e[lang] && e[lang].trim(), lang);
    assert.doesNotMatch(e[lang], /[А-Яа-яЁё]/, lang + ' без кириллицы');
  }
  assert.ok(RPC.patient_card_save, 'дверь карты пациента существует');
});
