// CRM_BOOKINGS_TAB_V1 (направления до оплаты) — «ЗАПИСИ CRM»: НАПРАВЛЕНИЕ ВРАЧА ЖДЁТ, ПОКА КАССА НЕ ПРИМЕТ
// ОПЛАТУ. Стенд crm-unify-app.js: все миграции, /api/db, реестр RPC, касса, вход под ролями.
//
// Решение владельца: кабинет врача выставляет счёт по направлению сразу (REFERRAL_BILL_V1), и
// направленный пациент выпадал из «Ждут» в «Оформлены», ещё не дойдя до кассы. Теперь:
//   • строка направления врача в НЕОПЛАЧЕННОМ счёте пациента ('unpaid' / 'partial' / 'debt' — тот же
//     список, что «ещё должны» у кассы, domain/money.js OUTSTANDING_STATUSES), ещё не отпущенная в
//     работу ('added'), — «Ждут» с пометкой to_cashier («Направил врач — счёт выставлен, к кассе»):
//     «Оформить по записи» нет, есть «Открыть визит»;
//   • счёт оплачен ('paid') или строка отпущена в работу (RELEASE_SELECT_V1: отметка кассира при
//     части денег или долге, счёт плательщику) — «Оформлены»;
//   • направление без счёта — как прежде («Ждут» с «Оформить по записи»); отменённый счёт с «Оставить
//     услуги» — строка снова без счёта, значит как прежде; не оформленное с причиной — уходит;
//   • записи (не врач) — прежние правила слово в слово; счётчик вкладки (только CRM) не меняется;
//   • прошлый день — как прежде: выставленное направление — «Оформлены», а не «Не пришли».
// День — МЕСТНЫЙ день клиники (localDay); «сегодня ещё есть свободное время» тест не предполагает.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay, at } from '../test-helpers/crm-unify-app.js';
import { calendarBook, callcenterBook, addVisitLine } from '../test-helpers/crm-link-all.js';

const TODAY = localDay(0);
const PATIENTS = [
  [81, 'Направленов Глеб'], [82, 'Частичная Дина'], [83, 'Оплативший Егор'], [84, 'Должник Жанна'],
  [85, 'Безсчётный Зафар'], [86, 'Отменённый Илья'], [87, 'Пропущенная Камила'], [88, 'Записанный Лев'],
  [89, 'Смешанный Марк'], [90, 'Страховой Олег'], [91, 'Вчерашний Пётр'], [92, 'Завтрашняя Роза'],
  [93, 'Админов Саид'],
];
const seed = (db) => {
  const p = db.prepare('INSERT INTO patients (id, full_name, phone) VALUES (?, ?, ?)');
  for (const [id, name] of PATIENTS) p.run(id, name, '+998 90 000 00 ' + String(id).padStart(2, '0'));
  db.prepare("INSERT INTO services (id, name, price, type, is_lab) VALUES (41, 'Анализ мочи', 30000, 'lab', 1)").run();
};

const list = async (t, args = {}, who = 'reg') => {
  const r = await t.rpc('registrar_waiting', who, args);
  assert.equal(r.status, 200, r.text);
  return r.json.data;
};
const rowOf = (data, pid, status = null) => data.rows.find((r) => r.patient_id === pid && (status == null || r.status === status)) || null;
const ids = (data) => data.rows.map((r) => r.patient_id).sort((a, b) => a - b);
const lineView = (row) => row.lines.map((l) => [l.kind, l.visit_service_id, l.to_cashier === true]);
const invoiceOf = (t, vsId) => t.db.prepare(`SELECT i.id, i.status, i.invoice_number FROM visit_services vs
  JOIN invoice_items ii ON ii.id = vs.invoice_item_id JOIN invoices i ON i.id = ii.invoice_id WHERE vs.id = ?`).get(vsId) || null;
const lineStatus = (t, vsId) => t.db.prepare('SELECT status, invoice_item_id FROM visit_services WHERE id = ?').get(vsId);

/** Направление врача из кабинета: визит дня, строки к лаборатории (исполнителя нет), «Пришёл» — с приёма. */
async function doctorSends(t, pid, { svcs = [40], arrived = true, day = TODAY } = {}) {
  const ev = await t.rpc('ensure_visit', 'doc', { patient_id: pid, date: day, doctor_id: 10, visit_type: 'outpatient' });
  assert.equal(ev.status, 200, ev.text);
  const vid = ev.json.data.visit.id;
  if (arrived) t.db.prepare("UPDATE visits SET status = 'arrived' WHERE id = ?").run(vid);
  const lineIds = [];
  for (const svc of svcs) lineIds.push(await addVisitLine(t, 'doc', vid, { svc, doctor: null }));
  return { vid, ids: lineIds };
}
/** REFERRAL_BILL_V1 — кабинет врача выставляет счёт по направлению сразу (тем же вызовом, что мастер). */
async function doctorBills(t, pid, opts = {}) {
  const d = await doctorSends(t, pid, opts);
  const inv = await t.rpc('create_invoice_for_visit', 'doc', { visit_id: d.vid, visit_service_ids: d.ids, discount_amount: 0, payer_id: null });
  assert.equal(inv.status, 200, inv.text);
  assert.equal(inv.json.data.invoice.status, 'unpaid', 'подготовка: счёт направления не «не оплачен»');
  return { ...d, invoiceId: inv.json.data.invoice.id, invoiceNumber: inv.json.data.invoice.invoice_number };
}
const pay = async (t, invoiceId, amount, extra = {}) => {
  const r = await t.rpc('record_payment', 'kassa', { invoice_id: invoiceId, amount, method: 'cash', ...extra });
  assert.equal(r.status, 200, r.text);
  return r.json.data.invoice;
};

test('CRM_BOOKINGS_TAB_V1 (направления до оплаты): направление врача в неоплаченном счёте — «Ждут» с пометкой «к кассе», без «Оформить по записи»; фильтры «Направил врач» и «Все»; счётчик вкладки (CRM) прежний', async () => {
  const t = await startCrmApp(seed);
  try {
    const v77 = await callcenterBook(t, TODAY, { hour: 12, svc: 30, doctor: 10, pid: 77 });   // запись CRM — для счётчика
    const d81 = await doctorBills(t, 81);
    const [line] = d81.ids;
    assert.equal(lineStatus(t, line).status, 'added', 'подготовка: строка направления уже отпущена в работу');
    assert.notEqual(lineStatus(t, line).invoice_item_id, null, 'подготовка: строка направления не в счёте');
    // Без фильтров (прежний «Ждут регистрации»: сегодня, все источники).
    const plain = await list(t);
    const r81 = rowOf(plain, 81);
    assert.ok(r81, 'направление врача со счётом выпало из «Ждут»: ' + JSON.stringify(plain.rows.map((r) => [r.patient_id, r.status])));
    assert.equal(r81.status, 'waiting');
    assert.equal(r81.to_cashier, true, 'строка не помечена «к кассе»');
    assert.deepEqual(r81.sources, [{ kind: 'doctor', name: 'Иванов' }]);
    assert.deepEqual(r81.services, ['Анализ крови']);
    assert.equal(r81.visit_id, d81.vid, '«Открыть визит» — не тот визит');
    assert.deepEqual(lineView(r81), [['doctor', line, true]]);
    assert.equal(r81.lines[0].invoice_id, d81.invoiceId, 'у строки нет номера счёта');
    assert.equal(r81.lines[0].invoice_number, d81.invoiceNumber);
    // Запись CRM — без пометки, с прежним «Оформить по записи».
    assert.equal(rowOf(plain, 77).to_cashier, false);
    assert.equal(rowOf(plain, 77).visit_id, v77);
    assert.equal(rowOf(plain, 77).lines.some((l) => l.to_cashier === true), false);
    // «Направил врач» и «Все» источники — в списке; «Оформлены» — нет; «Все» статусы — только «Ждёт».
    assert.deepEqual(ids(await list(t, { sources: ['doctor'] })), [81]);
    assert.deepEqual(ids(await list(t, { sources: ['all'] })), [77, 81]);
    assert.equal(rowOf(await list(t, { status: 'registered' }), 81), null, 'неоплаченное направление — в «Оформлены»');
    assert.deepEqual((await list(t, { status: 'all' })).rows.filter((r) => r.patient_id === 81).map((r) => r.status), ['waiting']);
    // Счётчик вкладки — фильтр по умолчанию (только CRM): направление его не трогает.
    const crm = await list(t, { sources: ['crm'] });
    assert.deepEqual(ids(crm), [77]);
    assert.equal((await list(t, { sources: ['crm'], count_only: true })).count, 1);
    // count_only — то же число, что строк полного ответа (и с «Направил врач»).
    assert.equal((await list(t, { sources: ['doctor'], count_only: true })).count, 1);
    assert.equal((await list(t, { count_only: true })).count, plain.rows.length);
    // Один пациент (быстрая регистрация спрашивает про одного) — та же строка с пометкой.
    const one = await list(t, { patient_id: 81 });
    assert.deepEqual(one.rows.map((r) => [r.patient_id, r.status, r.to_cashier]), [[81, 'waiting', true]]);
  } finally { t.close(); }
});

test('CRM_BOOKINGS_TAB_V1 (направления до оплаты): частичная оплата — ещё «Ждут»; отмеченное кассиром при долге — «Оформлены», неотмеченное ждёт; остаток оплачен — «Оформлены»', async () => {
  const t = await startCrmApp(seed);
  try {
    const d82 = await doctorBills(t, 82, { svcs: [40, 41] });
    const [blood, urine] = d82.ids;
    const part = await pay(t, d82.invoiceId, 10000);
    assert.equal(part.status, 'partial');
    let w = rowOf(await list(t), 82);
    assert.ok(w, 'частично оплаченное направление выпало из «Ждут»');
    assert.equal(w.to_cashier, true);
    assert.deepEqual(lineView(w).sort((a, b) => a[1] - b[1]), [['doctor', blood, true], ['doctor', urine, true]]);
    // Долг: кассир отметил «Анализ крови» — отпущен в работу; «Анализ мочи» ждёт оплаты.
    const debt = await t.rpc('mark_invoice_debt', 'kassa', { invoice_id: d82.invoiceId, release_line_ids: [blood] });
    assert.equal(debt.status, 200, debt.text);
    assert.equal(lineStatus(t, blood).status, 'queued');
    assert.equal(lineStatus(t, urine).status, 'added');
    w = rowOf(await list(t), 82);
    assert.ok(w, 'неотмеченная при долге строка выпала из «Ждут»');
    assert.deepEqual(lineView(w), [['doctor', urine, true]]);
    const reg = rowOf(await list(t, { status: 'registered' }), 82);
    assert.ok(reg, 'отпущенная при долге строка — не в «Оформлены»');
    assert.deepEqual(reg.lines.map((l) => l.visit_service_id), [blood]);
    // Остаток оплачен — всё отпущено, пациент — в «Оформлены» целиком.
    const rest = t.db.prepare('SELECT total_amount - paid_amount AS due FROM invoices WHERE id = ?').get(d82.invoiceId).due;
    assert.equal((await pay(t, d82.invoiceId, rest)).status, 'paid');
    assert.equal(rowOf(await list(t), 82), null, 'оплаченное направление осталось в «Ждут»');
    const reg2 = rowOf(await list(t, { status: 'registered' }), 82);
    assert.deepEqual(reg2.lines.map((l) => l.visit_service_id).sort((a, b) => a - b), [blood, urine]);
  } finally { t.close(); }
});

test('CRM_BOOKINGS_TAB_V1 (направления до оплаты): оплачен сразу — «Оформлены»; долг с отметкой — «Оформлены»; счёт плательщику — «Оформлены»', async () => {
  const t = await startCrmApp((db) => {
    seed(db);
    db.prepare("INSERT INTO payers (id, name, kind, active) VALUES (5, 'Страховая', 'insurance', 1)").run();
  });
  try {
    const d83 = await doctorBills(t, 83);
    assert.equal((await pay(t, d83.invoiceId, 40000)).status, 'paid');
    const d84 = await doctorBills(t, 84);
    const debt = await t.rpc('mark_invoice_debt', 'kassa', { invoice_id: d84.invoiceId, release_line_ids: d84.ids });
    assert.equal(debt.status, 200, debt.text);
    assert.equal(invoiceOf(t, d84.ids[0]).status, 'debt');
    // Плательщик в карте: врач счёта не выставляет, касса выставляет страховой — строки сразу в работу.
    t.db.prepare('UPDATE patients SET payer_id = 5 WHERE id = 90').run();
    const d90 = await doctorSends(t, 90);
    const byPayer = await t.rpc('create_invoice_for_visit', 'kassa', { visit_id: d90.vid, visit_service_ids: d90.ids, payer_id: 5 });
    assert.equal(byPayer.status, 200, byPayer.text);
    assert.equal(byPayer.json.data.invoice.status, 'unpaid', 'подготовка: счёт плательщику — долг плательщика');
    const waiting = await list(t);
    for (const pid of [83, 84, 90]) assert.equal(rowOf(waiting, pid), null, pid + ': ждёт кассу, хотя расчёт закрыт');
    assert.deepEqual(ids(await list(t, { status: 'registered' })), [83, 84, 90]);
  } finally { t.close(); }
});

test('CRM_BOOKINGS_TAB_V1 (направления до оплаты): без счёта — как прежде («Ждут», без пометки); отменённый счёт с «Оставить услуги» — снова без счёта; не оформленное с причиной — уходит', async () => {
  const t = await startCrmApp(seed);
  try {
    const d85 = await doctorSends(t, 85);
    const r85 = rowOf(await list(t), 85);
    assert.ok(r85);
    assert.equal(r85.to_cashier, false, 'направление без счёта помечено «к кассе»');
    assert.deepEqual(lineView(r85), [['doctor', d85.ids[0], false]]);
    // Отменённый счёт: «Оставить услуги» — строка снова без счёта, «Оформить по записи» как прежде.
    const d86 = await doctorBills(t, 86);
    assert.equal(rowOf(await list(t), 86).to_cashier, true);
    const v = await t.rpc('void_invoice', 'kassa', { invoice_id: d86.invoiceId, keep_services: true, reason: 'Ошибка в счёте' });
    assert.equal(v.status, 200, v.text);
    assert.deepEqual(lineStatus(t, d86.ids[0]), { status: 'added', invoice_item_id: null });
    const r86 = rowOf(await list(t), 86);
    assert.ok(r86, 'после отмены счёта направление выпало из «Ждут»');
    assert.equal(r86.to_cashier, false, 'отменённый счёт держит пометку «к кассе»');
    assert.deepEqual(lineView(r86), [['doctor', d86.ids[0], false]]);
    // Не оформлено с причиной (до счёта) — уходит; второе направление того же пациента выставлено — ждёт кассу.
    const d87 = await doctorSends(t, 87, { svcs: [40, 41] });
    const [skipped, billed] = d87.ids;
    const sk = await t.rpc('referral_line_skip', 'reg', { visit_service_id: skipped, reason: 'Пациент сдаст анализ завтра' });
    assert.equal(sk.status, 200, sk.text);
    const inv = await t.rpc('create_invoice_for_visit', 'doc', { visit_id: d87.vid, visit_service_ids: [billed], discount_amount: 0, payer_id: null });
    assert.equal(inv.status, 200, inv.text);
    const r87 = rowOf(await list(t), 87);
    assert.ok(r87);
    assert.deepEqual(lineView(r87), [['doctor', billed, true]], 'пропущенное направление вернулось в «Ждут»');
    assert.equal(r87.to_cashier, true);
    assert.deepEqual(rowOf(await list(t, { status: 'cancelled' }), 87).lines.map((l) => l.visit_service_id), [skipped]);
  } finally { t.close(); }
});

test('CRM_BOOKINGS_TAB_V1 (направления до оплаты): записи — прежние правила (выставленная, но не оплаченная запись — «Оформлены»); запись и выставленное направление в одном визите — запись оформлена, направление ждёт кассу', async () => {
  const t = await startCrmApp(seed);
  try {
    // Запись колл-центра, по которой стойка выставила счёт, а касса ещё не взяла денег — «Оформлены», как прежде.
    const v88 = await callcenterBook(t, TODAY, { hour: 11, svc: 30, doctor: 10, pid: 88 });
    const booked = t.db.prepare("SELECT id FROM visit_services WHERE visit_id = ? AND status = 'added'").all(v88).map((r) => r.id);
    const inv = await t.rpc('create_invoice_for_visit', 'reg', { visit_id: v88, visit_service_ids: booked, discount_amount: 0, payer_id: null });
    assert.equal(inv.status, 200, inv.text);
    assert.equal(inv.json.data.invoice.status, 'unpaid');
    assert.equal(rowOf(await list(t), 88), null, 'выставленная запись вернулась в «Ждут»');
    assert.ok(rowOf(await list(t, { status: 'registered' }), 88));
    // Запись календаря; врач на приёме направил на анализ в тот же визит и выставил счёт на свою строку.
    const v89 = await calendarBook(t, 'reg', TODAY, { hour: 15, svc: 30, doctor: 10, pid: 89 });
    const sent = await addVisitLine(t, 'doc', v89, { svc: 40, doctor: null });
    const docInv = await t.rpc('create_invoice_for_visit', 'doc', { visit_id: v89, visit_service_ids: [sent], discount_amount: 0, payer_id: null });
    assert.equal(docInv.status, 200, docInv.text);
    const all = await list(t, { status: 'all' });
    const w = rowOf(all, 89, 'waiting');
    const reg = rowOf(all, 89, 'registered');
    assert.ok(w && reg, 'запись и направление одного визита: ' + JSON.stringify(all.rows.filter((r) => r.patient_id === 89).map((r) => [r.status, lineView(r)])));
    assert.deepEqual(lineView(w), [['doctor', sent, true]]);
    assert.equal(w.to_cashier, true);
    assert.deepEqual(reg.lines.map((l) => l.kind), ['booked'], 'запись не оформлена счётом визита (прежнее правило)');
    assert.deepEqual(reg.sources.map((s) => s.kind), ['calendar']);
  } finally { t.close(); }
});

test('CRM_BOOKINGS_TAB_V1 (направления до оплаты): прошлый день — выставленное направление «Оформлены» (как прежде), не «Не пришли»; завтрашнее выставленное — «Ждут» завтра с пометкой', async () => {
  const t = await startCrmApp(seed);
  try {
    // Вчера: визит врача «Пришёл», строка врача к лаборатории, счёт (касса) — не оплачен.
    const y = Number(t.db.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, status, created_by) VALUES (91, 10, ?, 'arrived', 10)")
      .run(at(localDay(-1), 10)).lastInsertRowid);
    const yl = Number(t.db.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, created_by) VALUES (?, 40, NULL, 1, 40000, 40000, 'added', 10)")
      .run(y).lastInsertRowid);
    const yi = await t.rpc('create_invoice_for_visit', 'kassa', { visit_id: y, visit_service_ids: [yl] });
    assert.equal(yi.status, 200, yi.text);
    assert.deepEqual(ids(await list(t, { day: localDay(-1), status: 'no_show' })), [], 'выставленное вчера направление — «Не пришли»');
    const yr = rowOf(await list(t, { day: localDay(-1), status: 'registered' }), 91);
    assert.ok(yr, 'выставленное вчера направление — не «Оформлены»');
    assert.deepEqual(yr.lines.map((l) => [l.visit_service_id, l.to_cashier === true]), [[yl, false]]);
    // Завтра: врач направил на завтра и выставил счёт — в «Ждут» завтрашнего дня с пометкой.
    const d92 = await doctorBills(t, 92, { arrived: false, day: localDay(1) });
    const tw = rowOf(await list(t, { day: localDay(1) }), 92);
    assert.ok(tw, 'завтрашнее выставленное направление не ждёт');
    assert.equal(tw.to_cashier, true);
    assert.deepEqual(lineView(tw), [['doctor', d92.ids[0], true]]);
  } finally { t.close(); }
});

// Проверка владельца (не правка): направление из кабинета администратора. DOCTOR_NOT_DESK_SQL (ADMIN_DOCTOR_V1)
// считает администратора стойкой, поэтому «направил врач» у его строки — только по надёжной метке: внутренний
// источник врача на строке (referred_by_source_id → referral_sources.doctor_id). Её ставит мастер направления
// кабинета (visit-wizard.js lineReferralSource), когда у направляющего врача есть включённый источник; у
// администратора-врача он сам не заводится (мигр. 122 — только роль «Врач»), его заводят в настройках.
test('CRM_BOOKINGS_TAB_V1 (проверка): администратор-врач направил из кабинета — со своим внутренним источником строка «Направил врач»; без источника метки нет — правило стойки', async () => {
  const t = await startCrmApp((db) => {
    seed(db);
    db.prepare('UPDATE users SET is_doctor = 1 WHERE id = 1').run();
  });
  try {
    const cat = t.db.prepare('SELECT id FROM referral_source_categories WHERE is_internal = 1 ORDER BY id LIMIT 1').get().id;
    const src = Number(t.db.prepare("INSERT INTO referral_sources (name, first_name, doctor_id, category_id, active) VALUES ('Админ', 'Админ', 1, ?, 1)")
      .run(cat).lastInsertRowid);
    const ev = await t.rpc('ensure_visit', 'boss', { patient_id: 93, date: TODAY, doctor_id: 1, visit_type: 'outpatient' });
    assert.equal(ev.status, 200, ev.text);
    const vid = ev.json.data.visit.id;
    t.db.prepare("UPDATE visits SET status = 'arrived' WHERE id = ?").run(vid);
    const ins = (values) => t.dbq('boss', { table: 'visit_services', op: 'insert', returning: true, single: 'single',
      values: { visit_id: vid, quantity: 1, status: 'added', price_tier: 'primary', ...values } });
    const marked = await ins({ service_id: 40, unit_price: 40000, total: 40000, referred_by_source_id: src });
    assert.equal(marked.status, 200, marked.text);
    const plainLine = await ins({ service_id: 41, unit_price: 30000, total: 30000 });
    assert.equal(plainLine.status, 200, plainLine.text);
    assert.equal(t.db.prepare('SELECT referred_by_source_id FROM visit_services WHERE id = ?').get(marked.json.data.id).referred_by_source_id, src);
    const row = rowOf(await list(t, { sources: ['doctor'] }), 93);
    assert.ok(row, 'строка администратора-врача с его источником — не «Направил врач»');
    assert.deepEqual(row.lines.map((l) => [l.kind, l.visit_service_id]), [['doctor', marked.json.data.id]],
      'строка без метки посчитана направлением врача');
    assert.deepEqual(row.sources, [{ kind: 'doctor', name: 'Админ' }]);
  } finally { t.close(); }
});
