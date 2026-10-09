// CRM_UNIFY_V1 — crm_link_new_patient: НОВАЯ КАРТА НАХОДИТ ЗАЯВКУ КОЛЛ-ЦЕНТРА.
//
// Колл-центр записывает человека, у которого карты ещё нет: заявка без
// пациента, строки на день прихода. Регистратура заводит карту — и смета
// (pendingCrmLines: заявки ПО patient_id) должна сразу увидеть записанные
// услуги. Раньше это делал браузер (linkCrmRequestsToPatient) — все открытые
// заявки с номером, без проверки «номер у одной карты» и только среди своих
// карточек. Теперь — сервер, по правилу шага записи (crm/visit-link.js, шаг D):
// ключ ОСНОВНОГО номера, номер у ОДНОЙ карты (patientIdsWithPhoneKey — с
// запасом, оба поля), ОДНА заявка — самая новая открытая без пациента; пишется
// только patient_id. Только для карты, заведённой только что.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay, addLead, addLine, linesOf, daysAgoIso } from '../../test-helpers/crm-unify-app.js';

const TODAY = localDay(0);
const NEW_PHONE = '+998 93 111 22 33';
const OPEN = ['in_process', 'recall', 'scheduled', 'approved'];

/** Карта заводится так же, как её заводит окно регистрации: вставкой через /api/db. */
async function register(t, who = 'reg', values = {}) {
  const r = await t.dbq(who, { table: 'patients', op: 'insert', returning: true, single: 'single',
    values: { full_name: 'Новый Пациент', phone: NEW_PHONE, ...values } });
  assert.equal(r.status, 200, r.text);
  return r.json.data;
}
const link = (t, who, patientId) => t.rpc('crm_link_new_patient', who, { patient_id: patientId });
const bookingLinks = (t, rid) => t.db.prepare('SELECT COUNT(*) AS n FROM crm_booking_links WHERE request_id = ?').get(rid).n;

test('CRM_UNIFY_V1: новая карта с номером одной карты — заявка получает пациента, смета регистратуры видит её строку', async () => {
  const t = await startCrmApp();
  try {
    const y = addLead(t.db, { patient: null, phone: '931112233', name: 'Звонок' });
    const line = addLine(t.db, y, { svc: 40, day: TODAY });
    const pat = await register(t);

    const r = await link(t, 'reg', pat.id);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.data, { ok: true });

    const lead = t.lead(y);
    assert.equal(lead.patient_id, pat.id, 'заявка колл-центра осталась без карты — смета её не увидит');
    assert.equal(lead.status, 'in_process', 'связь по номеру не двигает ступень');
    assert.deepEqual(linesOf(t.db, y).map((l) => [l.id, l.status, l.visit_id]), [[line, 'pending', null]],
      'связь по номеру не трогает строки');
    assert.equal(bookingLinks(t, y), 0, 'связь по номеру не заводит привязку записи');

    // То же чтение, что pendingCrmLines (crm-lines.js): заявки по patient_id,
    // затем ждущие строки на день.
    const reqs = await t.dbq('reg', { table: 'crm_requests', op: 'select', columns: 'id',
      filters: [{ col: 'patient_id', op: 'eq', val: pat.id }, { col: 'status', op: 'in', val: OPEN }], order: [] });
    assert.equal(reqs.status, 200, reqs.text);
    assert.deepEqual(reqs.json.data.map((x) => x.id), [y]);
    const lines = await t.dbq('reg', { table: 'crm_request_services', op: 'select', columns: 'id, service_id',
      filters: [{ col: 'request_id', op: 'in', val: [y] }, { col: 'scheduled_date', op: 'eq', val: TODAY },
                { col: 'status', op: 'eq', val: 'pending' }], order: [] });
    assert.equal(lines.status, 200, lines.text);
    assert.deepEqual(lines.json.data.map((x) => [x.id, x.service_id]), [[line, 40]],
      'смета регистратуры не видит услугу, записанную колл-центром');
  } finally { t.close(); }
});

test('CRM_UNIFY_V1: общий номер — второй номер чужой карты или поле с двумя номерами — заявку не трогают', async () => {
  for (const other of [
    { phone: '+998 90 000 00 01', phone_secondary: '+998 93 111 22 33' },
    { phone: '+998 91 222 33 44, +998 93 111 22 33', phone_secondary: null },
  ]) {
    const t = await startCrmApp((db) => db.prepare('INSERT INTO patients (id, full_name, phone, phone_secondary) VALUES (80, ?, ?, ?)')
      .run('Родственник', other.phone, other.phone_secondary));
    try {
      const y = addLead(t.db, { patient: null, phone: '931112233' });
      const pat = await register(t);
      const r = await link(t, 'reg', pat.id);
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(r.json.data, { ok: true });
      assert.equal(t.lead(y).patient_id, null, 'номер у двух карт, а заявку отдали одной из них: ' + JSON.stringify(other));
    } finally { t.close(); }
  }
});

// CRM_UNIFY_V1 (ревью 2 задачи 1, F1 и F4) — номер у карты ребёнка как
// экстренный контакт или номер опекуна, и «8 93 …» у новой карты при «93 …» у
// родственника: номер не одной карты — заявку не трогают.
test('CRM_UNIFY_V1: номер — экстренный контакт или опекун другой карты; «8 93 …» при «93 …» у родственника — заявку не трогают', async () => {
  for (const [label, seed, values] of [
    ['экстренный контакт', (db) => db.prepare("INSERT INTO patients (id, full_name, phone, emergency_contact_phone) VALUES (80,'Ребёнок','',?)").run(NEW_PHONE), {}],
    ['опекун', (db) => {
      db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (80,'Ребёнок','')").run();
      db.prepare("INSERT INTO patient_guardians (patient_id, name, phone) VALUES (80,'Мама',?)").run(NEW_PHONE);
    }, {}],
    ['восьмёрка', (db) => db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (80,'Родственник','93 111 22 33')").run(),
      { phone: '8 93 111 22 33' }],
  ]) {
    const t = await startCrmApp(seed);
    try {
      const y = addLead(t.db, { patient: null, phone: '8 93 111 22 33' });
      const z = addLead(t.db, { patient: null, phone: '931112233' });
      const pat = await register(t, 'reg', values);
      const r = await link(t, 'reg', pat.id);
      assert.equal(r.status, 200, r.text);
      assert.deepEqual([t.lead(y).patient_id, t.lead(z).patient_id], [null, null], label);
    } finally { t.close(); }
  }
});

test('CRM_UNIFY_V1: «8 93 …» у новой карты находит заявку «931112233», если номер у одной карты', async () => {
  const t = await startCrmApp();
  try {
    const y = addLead(t.db, { patient: null, phone: '931112233' });
    const pat = await register(t, 'reg', { phone: '8 93 111 22 33' });
    await link(t, 'reg', pat.id);
    assert.equal(t.lead(y).patient_id, pat.id);
  } finally { t.close(); }
});

test('CRM_UNIFY_V1: второй номер новой карты заявок не ищет — только основной', async () => {
  const t = await startCrmApp();
  try {
    const y = addLead(t.db, { patient: null, phone: '931112233' });
    const pat = await register(t, 'reg', { phone: '', phone_secondary: NEW_PHONE });
    await link(t, 'reg', pat.id);
    assert.equal(t.lead(y).patient_id, null, 'заявку нашли по второму номеру — обычно это номер родственника');
  } finally { t.close(); }
});

test('CRM_UNIFY_V1: две открытые заявки с номером — привязывается только самая новая, повторный вызов вторую не берёт', async () => {
  const t = await startCrmApp();
  try {
    const older = addLead(t.db, { patient: null, phone: '931112233', name: 'Старая', updated: daysAgoIso(3) });
    const newer = addLead(t.db, { patient: null, phone: '+998931112233', name: 'Новая', updated: daysAgoIso(1) });
    const pat = await register(t);
    await link(t, 'reg', pat.id);
    assert.equal(t.lead(newer).patient_id, pat.id, 'самая новая заявка осталась без карты');
    assert.equal(t.lead(older).patient_id, null, 'привязаны обе — это прежняя пачка по номеру');
    // Повтор — не проход по номеру частями: у карты уже есть заявка.
    await link(t, 'reg', pat.id);
    assert.equal(t.lead(older).patient_id, null, 'повторный вызов взял следующую заявку номера');
  } finally { t.close(); }
});

test('CRM_UNIFY_V1: закрытая заявка («Пришёл», «Нецелевой», «Не пришёл») не трогается никогда', async () => {
  const t = await startCrmApp();
  try {
    const open = addLead(t.db, { patient: null, phone: '931112233', name: 'Открытая', updated: daysAgoIso(5) });
    const closed = ['came', 'not_qualified', 'no_show'].map((status) =>
      addLead(t.db, { status, patient: null, phone: '931112233', name: status, updated: daysAgoIso(1) }));
    const pat = await register(t);
    await link(t, 'reg', pat.id);
    for (const id of closed) {
      assert.equal(t.lead(id).patient_id, null, 'закрытая заявка — история, её не привязывают: ' + t.lead(id).status);
    }
    assert.equal(t.lead(open).patient_id, pat.id, 'открытую старее закрытых не взяли');
  } finally { t.close(); }

  const t2 = await startCrmApp();
  try {
    const only = addLead(t2.db, { status: 'came', patient: null, phone: '931112233' });
    const pat = await register(t2);
    await link(t2, 'reg', pat.id);
    assert.equal(t2.lead(only).patient_id, null, 'единственная закрытая заявка номера привязана');
  } finally { t2.close(); }
});

test('CRM_UNIFY_V1: заявка с пациентом не перепривязывается', async () => {
  const t = await startCrmApp();
  try {
    // Звонил родитель со своего номера про ребёнка 77: номер заявки — новой карты.
    const y = addLead(t.db, { patient: 77, phone: '931112233' });
    const pat = await register(t);
    await link(t, 'reg', pat.id);
    assert.equal(t.lead(y).patient_id, 77, 'заявку чужой карты увели к новой по номеру');
  } finally { t.close(); }
});

test('CRM_UNIFY_V1: старая карта или карта соседнего здания — ничего не делается', async () => {
  const t = await startCrmApp((db) => {
    db.prepare('INSERT INTO patients (id, full_name, phone, created_at) VALUES (81, ?, ?, ?)')
      .run('Давний', NEW_PHONE, daysAgoIso(30));
  });
  try {
    const y = addLead(t.db, { patient: null, phone: '931112233' });
    const r = await link(t, 'reg', 81);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.data, { ok: true });
    assert.equal(t.lead(y).patient_id, null, 'дверь для новой карты привязала заявку давней — это проход по старым картам');
  } finally { t.close(); }

  const t2 = await startCrmApp((db) => {
    db.prepare("INSERT INTO patients (id, full_name, phone, sync_origin) VALUES (82, ?, ?, 'B')").run('Сосед', NEW_PHONE);
  });
  try {
    const y = addLead(t2.db, { patient: null, phone: '931112233' });
    await link(t2, 'reg', 82);
    assert.equal(t2.lead(y).patient_id, null, 'карта соседнего здания — связь делается там, где её завели');
  } finally { t2.close(); }
});

test('CRM_UNIFY_V1: ответ один и тот же — привязали или нет; о заявках ни слова', async () => {
  const t = await startCrmApp();
  try {
    addLead(t.db, { patient: null, phone: '931112233', assigned: 4, name: 'Чужая заявка' });
    const pat = await register(t, 'cc');
    // Оператор А заявку оператора Б не видит, но привязку решает сервер.
    const r = await link(t, 'cc', pat.id);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json, { data: { ok: true } }, 'ответ раскрывает что-то о заявках');
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM crm_requests WHERE patient_id = ?').get(pat.id).n, 1,
      'заявка чужого оператора не привязана — видимость того, кто регистрирует, тут ни при чём');

    const lone = await register(t, 'reg', { phone: '+998 97 555 66 77' });
    const none = await link(t, 'reg', lone.id);
    assert.deepEqual(none.json, r.json, 'по ответу видно, нашлась ли заявка');
  } finally { t.close(); }
});

test('CRM_UNIFY_V1: роль, которая не заводит пациентов, получает отказ', async () => {
  const t = await startCrmApp();
  try {
    const y = addLead(t.db, { patient: null, phone: '931112233' });
    const pat = await register(t);
    for (const who of ['kassa', 'doc']) {
      const r = await link(t, who, pat.id);
      assert.equal(r.status, 403, who + ': ' + r.text);
    }
    assert.equal(t.lead(y).patient_id, null, 'отказ, а заявку всё равно привязали');
    const bad = await t.rpc('crm_link_new_patient', 'reg', {});
    assert.equal(bad.status, 400, bad.text);
  } finally { t.close(); }
});
