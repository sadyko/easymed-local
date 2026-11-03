// DOCTOR_REFERRAL_DESK_V1 — направления врача для окна регистрации: чтение (сегодня и вперёд,
// своё здание, состояние счёта, кому бонус — без сумм), привязка рекомендации к строке и метка
// календаря. Настоящее приложение и сессии (crm-unify-app.js): doc — врач №10 «Иванов».
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay, at } from '../test-helpers/crm-unify-app.js';
import { isReadOnlyRpc } from '../services/control/gate.js';

const TODAY = localDay(0);
const TOMORROW = localDay(1);
const srcOf = (db, doctorId) => db.prepare('SELECT id FROM referral_sources WHERE doctor_id = ?').get(doctorId).id;
const lastVs = (db) => db.prepare('SELECT MAX(id) id FROM visit_services').get().id;
const recInsert = (db, { service = 60, by = 10, notes = 'к 9:00' } = {}) => Number(db.prepare(
  "INSERT INTO recommended_services (patient_id, service_id, service_name, recommended_by, notes, status) VALUES (77, ?, 'ЭКГ', ?, ?, 'pending')")
  .run(service, by, notes).lastInsertRowid);

function seed(db) {
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (12,'doc2','x','Петров','doctor',1)").run();
  db.prepare("INSERT INTO services (id, name, price, type) VALUES (50,'УЗИ',80000,'imaging'), (60,'ЭКГ',50000,'procedure'), (61,'Холтер',90000,'imaging')").run();
  db.prepare("INSERT INTO referral_sources (id, name) VALUES (900, 'Клиника Партнёр')").run();
  db.prepare('UPDATE patients SET referral_source_id = 900 WHERE id = 77').run();
  db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (500, 77, ?, 'arrived')").run(at(TODAY, 9));
  db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (501, 77, ?, 'scheduled')").run(at(TOMORROW, 10));
  db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (503, 77, ?, 'scheduled')").run(at(localDay(2), 10));
}
async function doctorLine(t, values) {
  const r = await t.dbq('doc', { table: 'visit_services', op: 'insert', values: { quantity: 1, unit_price: 1, total: 1, status: 'added', ...values } });
  assert.equal(r.status, 200, r.text);
  return lastVs(t.db);
}
async function fixture() {
  const t = await startCrmApp(seed);
  const A = await doctorLine(t, { visit_id: 500, service_id: 40, referral_note: 'натощак' });     // сегодня, без счёта
  const B = await doctorLine(t, { visit_id: 500, service_id: 50, doctor_id: 12 });                // сегодня, в счёте
  const inv = await t.rpc('create_invoice_for_visit', 'reg', { visit_id: 500, visit_service_ids: [B], discount_amount: 0, payer_id: null });
  assert.equal(inv.status, 200, inv.text);
  const C = await doctorLine(t, { visit_id: 501, service_id: 50, doctor_id: 12 });                // завтра
  await doctorLine(t, { visit_id: 500, service_id: 30, doctor_id: 10 });                          // своя консультация — не направление
  const E = await t.dbq('reg', { table: 'visit_services', op: 'insert', values: { visit_id: 501, service_id: 40, quantity: 1, unit_price: 1, total: 1, status: 'added' } });
  assert.equal(E.status, 200, E.text);                                                             // строка стойки — не направление
  // Чужое здание: визит и строка, приехавшие из филиала B.
  t.db.prepare("INSERT INTO visits (id, patient_id, visit_date, status, sync_origin) VALUES (502, 77, ?, 'scheduled', 'B')").run(at(TOMORROW, 11));
  t.db.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, status, created_by, sync_origin) VALUES (502, 50, 12, 'added', 10, 'B')").run();
  const rec = recInsert(t.db);
  return { t, A, B, C, rec, invoice: inv.json.data.invoice };
}

test('чтение: сегодня и вперёд, своё здание, состояние счёта, рекомендации, кому бонус — без сумм', async () => {
  const { t, A, B, C, rec, invoice } = await fixture();
  try {
    const r = await t.rpc('patient_referral_orders', 'reg', { patient_id: 77 });
    assert.equal(r.status, 200, r.text);
    const d = r.json.data;
    assert.equal(d.today, TODAY);
    assert.deepEqual(d.lines.map((l) => l.visit_service_id), [A, B, C]);
    assert.ok(!d.lines.some((l) => l.visit_id === 502), 'строка чужого здания в списке');
    const [a, b, c] = d.lines;
    assert.deepEqual([a.day, a.bill.state, a.referrer_name, a.referral_note], [TODAY, 'none', 'Иванов', 'натощак']);
    assert.deepEqual([b.bill.state, b.bill.invoice_number], ['invoiced', invoice.invoice_number]);
    assert.deepEqual([c.day, c.bill.state, c.doctor_name], [TOMORROW, 'none', 'Петров']);
    assert.deepEqual(a.bonus_to, ['Клиника Партнёр', 'Иванов']);
    assert.deepEqual(d.recommendations.map((x) => [x.recommendation_id, x.name, x.referrer_name, x.notes]), [[rec, 'ЭКГ', 'Иванов', 'к 9:00']]);
    // Ревью U10 LOW-7 — исполнитель рекомендации ещё не выбран: врач-рекомендатель получит бонус,
    // только если услугу выполнит другой врач (своя строка — без бонуса), — это условие, а не факт.
    assert.deepEqual([d.recommendations[0].bonus_to, d.recommendations[0].bonus_if_other], [['Клиника Партнёр'], 'Иванов']);
    assert.ok(!/reward|percent|own_rates|"rate"/.test(r.text), 'регистратору ушли суммы или ставки бонуса: ' + r.text);
    const bad = await t.rpc('patient_referral_orders', 'reg', { patient_id: 'x' });
    assert.equal(bad.status, 400);
  } finally { t.close(); }
});

test('выставленное направление второй раз не выставляется', async () => {
  const { t, B } = await fixture();
  try {
    const again = await t.rpc('create_invoice_for_visit', 'reg', { visit_id: 500, visit_service_ids: [B], discount_amount: 0, payer_id: null });
    assert.equal(again.status, 400, again.text);
    assert.match(again.json.error.message, /уже в счёте/);
  } finally { t.close(); }
});

// К5 — «Вернуть услугу» оставляет строку в визите без позиции счёта (отметка возврата
// pay_refund_releases): регистратуре её не показывают — иначе она выставилась бы снова.
// Замена услуги (та же строка) — строка показана с НОВОЙ услугой.
test('К5: возвращённая строка не показывается; заменённая — с новой услугой', async () => {
  const { t, A, B, C, invoice } = await fixture();
  try {
    t.db.prepare('UPDATE visit_services SET invoice_item_id = NULL WHERE id = ?').run(B);
    t.db.prepare("INSERT INTO pay_refund_releases (kind, line_id, invoice_id) VALUES ('out', ?, ?)").run(B, invoice.id);
    const sw = await t.rpc('change_unpaid_service', 'boss', { visit_service_id: C, new_service_id: 61 });
    assert.equal(sw.status, 200, sw.text);
    const d = (await t.rpc('patient_referral_orders', 'reg', { patient_id: 77 })).json.data;
    assert.deepEqual(d.lines.map((l) => l.visit_service_id), [A, C], 'возвращённая строка осталась в «Направлениях врача»');
    assert.equal(d.lines[1].name, 'Холтер', 'заменённая строка показана со старой услугой');
    const marks = (await t.rpc('referral_visit_links', 'reg', { visit_ids: [500, 501] })).json.data;
    assert.deepEqual(marks.map((m) => m.visit_id), [500, 501]);
  } finally { t.close(); }
});

// Строка без счёта, по которой уже идёт работа («в очереди», «взят материал»), — не «к
// оформлению»: так же, как строки «из записи» (booked-rows.js — только 'added'). Её выставляет
// касса из «Ждут счёта»; регистратура второй раз её не берёт.
test('строка без счёта, по которой уже идёт работа, в «Направлениях врача» не показывается', async () => {
  const { t, A, B, C } = await fixture();
  try {
    t.db.prepare("UPDATE visit_services SET status = 'queued' WHERE id = ?").run(A);
    t.db.prepare("UPDATE visit_services SET status = 'in_progress' WHERE id = ?").run(B);
    const d = (await t.rpc('patient_referral_orders', 'reg', { patient_id: 77 })).json.data;
    assert.deepEqual(d.lines.map((l) => l.visit_service_id), [B, C], 'строка без счёта «в очереди» осталась «к оформлению»');
  } finally { t.close(); }
});

// Администратор-врач у стойки (is_doctor = 1, роль «admin») записывает пациента к другому
// врачу — это работа стойки, а не направление врача: «от врача» здесь было бы неправдой.
test('строка администратора-врача у стойки — не «направление врача»', async () => {
  const t = await startCrmApp((db) => { seed(db); db.prepare('UPDATE users SET is_doctor = 1 WHERE id = 1').run(); });
  try {
    const r = await t.dbq('boss', { table: 'visit_services', op: 'insert', values: { visit_id: 500, service_id: 50, doctor_id: 12, quantity: 1, unit_price: 1, total: 1, status: 'added' } });
    assert.equal(r.status, 200, r.text);
    const d = (await t.rpc('patient_referral_orders', 'reg', { patient_id: 77 })).json.data;
    assert.deepEqual(d.lines, []);
    assert.deepEqual((await t.rpc('referral_visit_links', 'reg', { visit_ids: [500] })).json.data, []);
  } finally { t.close(); }
});

test('«Добавить» рекомендацию: строка стойки привязана сервером — рекомендация закрыта, направивший — врач', async () => {
  const { t, A, C, rec } = await fixture();
  try {
    const ins = await t.dbq('reg', { table: 'visit_services', op: 'insert', values: { visit_id: 500, service_id: 60, quantity: 1, unit_price: 1, total: 1, status: 'added' } });
    assert.equal(ins.status, 200, ins.text);
    const X = lastVs(t.db);
    assert.equal(t.db.prepare('SELECT referred_by_source_id s FROM visit_services WHERE id = ?').get(X).s, null, 'стойка без «Кто направил» направившего не ставит');
    assert.equal((await t.rpc('referral_recommendation_attach', 'kassa', { recommendation_id: rec, visit_service_id: X })).status, 403);
    const wrong = await t.rpc('referral_recommendation_attach', 'reg', { recommendation_id: rec, visit_service_id: A });
    assert.equal(wrong.status, 400, 'строка другой услуги');
    const ok = await t.rpc('referral_recommendation_attach', 'reg', { recommendation_id: rec, visit_service_id: X });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.data.referred_by_source_id, srcOf(t.db, 10));
    assert.deepEqual(t.db.prepare('SELECT referred_by_source_id, referral_note FROM visit_services WHERE id = ?').get(X),
      { referred_by_source_id: srcOf(t.db, 10), referral_note: 'к 9:00' });
    assert.deepEqual(t.db.prepare('SELECT status, visit_service_id FROM recommended_services WHERE id = ?').get(rec), { status: 'done', visit_service_id: X });
    assert.equal((await t.rpc('referral_recommendation_attach', 'reg', { recommendation_id: rec, visit_service_id: X })).status, 409);
    const after = (await t.rpc('patient_referral_orders', 'reg', { patient_id: 77 })).json.data;
    assert.equal(after.recommendations.length, 0);
    assert.ok(after.lines.some((l) => l.visit_service_id === X), 'строка по рекомендации — направление врача');
    // Одна строка закрывает одну рекомендацию: вторая того же врача на ту же услугу — отказ.
    const twin = recInsert(t.db);
    assert.equal((await t.rpc('referral_recommendation_attach', 'reg', { recommendation_id: twin, visit_service_id: X })).status, 409);
    assert.equal(t.db.prepare('SELECT status FROM recommended_services WHERE id = ?').get(twin).status, 'pending');
    // Ревью U10 MEDIUM-2 — врач привязывает к СВОЕЙ строке и рекомендацию коллеги (написанную
    // раньше строки): направивший строки — рекомендовавший; он же исполнитель — никто.
    const foreign = recInsert(t.db, { service: 50, by: 12, notes: '' });
    t.db.prepare("UPDATE recommended_services SET created_at = '2020-01-01T00:00:00Z' WHERE id = ?").run(foreign);
    assert.equal(t.db.prepare('SELECT referred_by_source_id s FROM visit_services WHERE id = ?').get(C).s, srcOf(t.db, 10), 'стенд: строку C завёл врач №10');
    const own = await t.rpc('referral_recommendation_attach', 'doc', { recommendation_id: foreign, visit_service_id: C });
    assert.equal(own.status, 200, own.text);
    assert.equal(t.db.prepare('SELECT referred_by_source_id s FROM visit_services WHERE id = ?').get(C).s, null, 'исполнитель C — сам рекомендовавший');
    // К строке, которую завёл другой сотрудник (стойка), врач рекомендацию не привязывает.
    const deskLine = await t.dbq('reg', { table: 'visit_services', op: 'insert', values: { visit_id: 501, service_id: 61, quantity: 1, unit_price: 1, total: 1, status: 'added' } });
    assert.equal(deskLine.status, 200, deskLine.text);
    const holter = recInsert(t.db, { service: 61, by: 10, notes: '' });
    t.db.prepare("UPDATE recommended_services SET created_at = '2020-01-01T00:00:00Z' WHERE id = ?").run(holter);
    assert.equal((await t.rpc('referral_recommendation_attach', 'doc', { recommendation_id: holter, visit_service_id: lastVs(t.db) })).status, 403);
  } finally { t.close(); }
});

// Ревью U10 LOW-7 — «Бонус: …» у рекомендации — то, что заплатит расчёт: база — источник
// сегодняшнего визита пациента (иначе карточки); врач-рекомендатель — условием «если выполняет
// другой врач»; рекомендатель — сам источник визита — без условия (за визит ему платят всегда);
// без своего включённого источника — его нет вовсе.
test('LOW-7: «Бонус» рекомендации — источник сегодняшнего визита, рекомендатель — условием', async () => {
  const { t } = await fixture();
  try {
    const bonusOf = async () => {
      const d = (await t.rpc('patient_referral_orders', 'reg', { patient_id: 77 })).json.data;
      return d.recommendations.map((r) => [r.bonus_to, r.bonus_if_other]);
    };
    t.db.prepare("INSERT INTO referral_sources (id, name) VALUES (902, 'Партнёр дня')").run();
    t.db.prepare('UPDATE visits SET referral_source_id = 902 WHERE id = 500').run();
    assert.deepEqual(await bonusOf(), [[['Партнёр дня'], 'Иванов']], 'база — карточка пациента, а не визит дня');
    t.db.prepare('UPDATE visits SET referral_source_id = ? WHERE id = 500').run(srcOf(t.db, 10));
    assert.deepEqual(await bonusOf(), [[['Иванов'], null]], 'рекомендатель — источник визита: бонус без условия');
    t.db.prepare('UPDATE visits SET referral_source_id = NULL WHERE id = 500').run();
    t.db.prepare('UPDATE referral_sources SET active = 0 WHERE doctor_id = 10').run();
    assert.deepEqual(await bonusOf(), [[['Клиника Партнёр'], null]], 'выключенный источник рекомендателя назван');
  } finally { t.close(); }
});

test('метка календаря: визиты с направлением врача и имя направившего', async () => {
  const { t } = await fixture();
  try {
    const r = await t.rpc('referral_visit_links', 'reg', { visit_ids: [500, 501, 503] });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.data, [{ visit_id: 500, doctor_name: 'Иванов' }, { visit_id: 501, doctor_name: 'Иванов' }]);
  } finally { t.close(); }
});

test('лицензия: оба чтения — в READ_ONLY_RPCS, привязка — запись', () => {
  assert.equal(isReadOnlyRpc('patient_referral_orders'), true);
  assert.equal(isReadOnlyRpc('referral_visit_links'), true);
  assert.equal(isReadOnlyRpc('referral_recommendation_attach'), false);
});
