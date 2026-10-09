// CRM_UNIFY_V1 — ИСТОРИЯ ОСТАЁТСЯ ИСТОРИЕЙ ПОСЛЕ СМЕНЫ «КОЛОНКИ КОНВЕРСИИ».
//
// Ревью задачи 4 (c06ff7d), атаки R1–R6. Перенос вида won оставлял карточки
// прежней «Пришёл» на месте — в колонке, ставшей ОТКРЫТОЙ: вся история
// конверсий оживала. Запись колл-центра цепляла карточку 2025 года и
// переписывала ей дату, стойка двигала старые карточки, звонок бывшего пациента
// не заводил лида (openLeadForPhone видел «живую» карточку), отчёт колл-центра
// проваливался, браузерный обход уносил историю в «Не пришёл».
//
// Правило контролёра (2026-10-09):
//   1. новая колонка конверсии обязана быть ПУСТОЙ — иначе отказ с числом;
//   2. конвертированные карточки идут за ролью: той же транзакцией все карточки
//      прежней конверсии переезжают в новую, updated_at не меняется, перенос —
//      в журнал (сколько, откуда, куда, кто); прежняя колонка — пустая открытая;
//   3. saveStages не меняет kind существующих колонок — won двигают только
//      настройки (иначе устаревшая вкладка молча откатывала перенос, а
//      собранный руками запрос делал «Не пришёл» конверсией).
// Каждая атака здесь — с утверждениями, и до переноса, и после.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay, at, daysAgoIso, addLead } from '../test-helpers/crm-unify-app.js';
import { leadFromCall } from '../services/crm/lead-from-call.js';
import { saveConfig, crmConfig, scheduledStageKey, saveStages, listStages } from '../services/crm/config.js';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';

const D = localDay(3);
const wonKeys = (db) => db.prepare("SELECT key FROM crm_stages WHERE kind = 'won'").all().map((r) => r.key);
const OLD_UPDATED = daysAgoIso(200);
const historyCard = (db, extra = {}) => addLead(db, { status: 'came', date: '2025-05-01', updated: OLD_UPDATED, name: 'История', ...extra });
const moveTo = async (t, key) => {
  const s = await t.rpc('crm_config_save', 'boss', { settings: { won_stage: key } });
  assert.equal(s.status, 200, s.text);
};
/** Карточка истории не тронута: стоит в конверсии (какой бы она ни была), дата и updated_at прежние. */
function assertHistory(db, id, won) {
  const r = db.prepare('SELECT status, scheduled_date, updated_at FROM crm_requests WHERE id = ?').get(id);
  assert.equal(r.status, won, 'карточка истории ушла из конверсии');
  assert.equal(r.scheduled_date, '2025-05-01', 'дата карточки истории переписана');
  assert.equal(r.updated_at, OLD_UPDATED, 'карточка истории «ожила»: updated_at сдвинут');
}
const CLINIC = (db) => {
  const st = (key, label, kind) => ({ key, label, color: '', kind, is_active: 1 });
  saveStages(db, [
    st('in_process', 'Новый лид', 'open'), st('recall', 'Перезвонить', 'open'), st('dozhim', 'Дожим', 'open'),
    st('approved', 'Подтверждён (амбулатор)', 'open'), st('approved_in', 'Подтверждён (стационар)', 'open'),
    st('no_show', 'Не пришёл', 'lost'), st('uspeshno', 'Успешно', 'open'), st('came', 'Пришёл', 'won'),
    st('stopped', 'Отказ', 'lost'),
  ]);
};

for (const move of [false, true]) {
  test(`R1 запись колл-центра пациента, у которого только старая «Пришёл», — новая карточка, история не тронута (перенос: ${move})`, async () => {
    const t = await startCrmApp();
    try {
      const old = historyCard(t.db);
      if (move) await moveTo(t, 'approved');
      const won = move ? 'approved' : 'came';
      assertHistory(t.db, old, won);
      const b = await t.rpc('calendar_book', 'cc', { patient_id: 77, doctor_id: 10, start: at(D, 9), duration_minutes: 30 });
      assert.equal(b.status, 200, b.text);
      const vid = b.json.data.visit.id;
      const link = t.db.prepare('SELECT request_id, created_request FROM crm_booking_links WHERE visit_id = ?').get(vid);
      assert.ok(link, 'запись колл-центра не нашла и не завела карточку');
      assert.notEqual(link.request_id, old, 'запись привязалась к карточке истории');
      assert.equal(link.created_request, 1, 'для записи заведена новая карточка');
      assertHistory(t.db, old, won);

      const when = t.db.prepare('SELECT visit_date FROM visits WHERE id = ?').get(vid).visit_date;
      const arr = await t.rpc('calendar_book', 'reg', { visit_id: vid, status: 'arrived', start: when });
      assert.equal(arr.status, 200, arr.text);
      assertHistory(t.db, old, won);
    } finally { t.close(); }
  });
}

for (const move of [false, true]) {
  test(`R2 входящий звонок бывшего пациента (карточка в «Пришёл») заводит новый лид (перенос: ${move})`, () => {
    const db = openDb(':memory:');
    migrate(db);
    // CRM_UNIFY_V1 (задача 6) — ОБНОВЛЕНО НАМЕРЕННО: карточка истории — давняя
    // (за окном повторного обращения). Закрытая карточка В ОКНЕ новый лид не
    // заводит (Р5, lead-from-call.test.js).
    db.prepare("INSERT INTO crm_requests (full_name, phone, status, updated_at, created_at) VALUES ('История', '+998 90 909 26 38', 'came', ?, ?)").run(OLD_UPDATED, OLD_UPDATED);
    if (move) saveConfig(db, { settings: { won_stage: 'approved' } });
    const cid = Number(db.prepare("INSERT INTO calls (general_call_id, started_at, disposition, external_number, call_type) VALUES ('X1','2026-10-09T08:00:00Z','ANSWER','998909092638',0)").run().lastInsertRowid);
    const created = leadFromCall(db, { id: cid, disposition: 'ANSWER', external_number: '998909092638', call_type: 0 });
    assert.ok(created, 'звонок бывшего пациента не завёл лида: история принята за открытую карточку');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM crm_requests').get().n, 2);
    db.close();
  });
}

test('R3 воронка клиники: без выбора записанные идут в «Успешно»; конверсия «Успешно» — колонка записи «Подтверждён (стационар)»', () => {
  const db = openDb(':memory:');
  migrate(db);
  CLINIC(db);
  assert.deepEqual(wonKeys(db), ['came']);
  // Заметка выката: без явного выбора у клиники записанные по-прежнему уходят в
  // «Успешно» — администратор обязан выбрать «Колонку подтверждения».
  assert.equal(scheduledStageKey(db), 'uspeshno');
  saveConfig(db, { settings: { won_stage: 'uspeshno' } });
  const cfg = crmConfig(db);
  assert.deepEqual(cfg.stages.filter((s) => s.kind === 'won').map((s) => s.key), ['uspeshno']);
  assert.equal(cfg.stages.find((s) => s.key === 'came').kind, 'open');
  assert.equal(cfg.settings.booked_effective, 'approved_in');
  db.close();
});

test('R4 отчёт колл-центра не проваливается, когда клиника выбирает «Успешно» конверсией', async () => {
  const t = await startCrmApp(CLINIC);
  try {
    const came = [];
    for (let i = 0; i < 5; i++) came.push(addLead(t.db, { status: 'came', updated: daysAgoIso(20 + i), name: 'Пришёл ' + i }));
    addLead(t.db, { status: 'in_process', updated: daysAgoIso(5), name: 'Живой застрявший' });
    const from = localDay(-40), to = localDay(0);
    const rep = async () => (await t.rpc('callcenter_report', 'boss', { from, to })).json.data;
    const a = await rep();
    assert.equal(a.kpi.came, 5);
    assert.deepEqual(a.stale.oldest.map((x) => x.name), ['Живой застрявший']);
    await moveTo(t, 'uspeshno');
    for (const id of came) assert.equal(t.lead(id).status, 'uspeshno', 'конвертированная карточка не пошла за конверсией');
    const b = await rep();
    assert.equal(b.kpi.came, 5, 'конверсии после смены колонки пропали из отчёта');
    assert.equal(b.kpi.total, a.kpi.total);
    assert.deepEqual(b.stale.oldest.map((x) => x.name), ['Живой застрявший'], 'история стала «зависшими заявками»');
  } finally { t.close(); }
});

test('R5 редактор колонок не двигает конверсию: устаревшая вкладка и собранный руками запрос', async () => {
  const t = await startCrmApp();
  try {
    const stale = (await t.rpc('crm_config_get', 'boss', {})).json.data.stages;   // вкладка А открыла экран
    await moveTo(t, 'approved');                                                  // вкладка Б перенесла конверсию
    // R5a — вкладка А переименовывает колонку и сохраняет «Колонки» со старыми видами.
    const r = await t.rpc('crm_config_save', 'boss', { stages: stale.map((x) => (x.key === 'recall' ? { ...x, label: 'Перезвон' } : x)) });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(wonKeys(t.db), ['approved'], 'устаревшая вкладка молча откатила перенос конверсии');
    assert.equal(listStages(t.db).find((s) => s.key === 'recall').label, 'Перезвон', 'правка названия не сохранилась');
    // R5b — собранный руками запрос делает сидовую «Не пришёл» конверсией.
    const cur = (await t.rpc('crm_config_get', 'boss', {})).json.data.stages;
    const c = await t.rpc('crm_config_save', 'boss', { stages: cur.map((x) => ({ ...x, kind: x.key === 'no_show' ? 'won' : (x.kind === 'won' ? 'open' : x.kind) })) });
    assert.equal(c.status, 200, c.text);
    assert.deepEqual(wonKeys(t.db), ['approved'], 'запрос колонок сделал «Не пришёл» конверсией');
    assert.equal(listStages(t.db).find((s) => s.key === 'no_show').kind, 'lost');
    // R5c — настройки отказывают тому же.
    const via = await t.rpc('crm_config_save', 'boss', { settings: { won_stage: 'no_show' } });
    assert.equal(via.status, 400, via.text);
    assert.deepEqual(wonKeys(t.db), ['approved']);
  } finally { t.close(); }
});

for (const move of [false, true]) {
  test(`R6 регистрация на стойке бывшего пациента не двигает карточку истории (перенос: ${move})`, async () => {
    const t = await startCrmApp();
    try {
      const old = historyCard(t.db);
      if (move) await moveTo(t, 'approved');
      const r = await t.rpc('ensure_visit', 'reg', { patient_id: 77, date: new Date().toISOString(), doctor_id: 10, visit_type: 'outpatient', desk: true });
      assert.equal(r.status, 200, r.text);
      assertHistory(t.db, old, move ? 'approved' : 'came');
    } finally { t.close(); }
  });
}

// ── Правило переноса ─────────────────────────────────────────────────────────

test('новая колонка конверсии должна быть пустой: отказ 409 с числом карточек, ничего не сдвинуто', async () => {
  const t = await startCrmApp();
  try {
    const live = addLead(t.db, { status: 'approved', name: 'Живая в «Подтверждён»' });
    addLead(t.db, { status: 'approved', name: 'Вторая', patient: null });
    const hist = historyCard(t.db);
    const r = await t.rpc('crm_config_save', 'boss', { settings: { won_stage: 'approved' } });
    assert.equal(r.status, 409, r.text);
    assert.match(r.json.error.message, /В колонке «Подтверждён» карточек: 2 — сначала перенесите их в другие колонки/);
    assert.equal(r.json.error.template, 'В колонке «{label}» карточек: {n} — сначала перенесите их в другие колонки.',
      'фраза собрана без шаблона — узбекский и английский экраны покажут её по-русски');
    assert.deepEqual(r.json.error.params, { label: 'Подтверждён', n: 2 });
    assert.deepEqual(wonKeys(t.db), ['came']);
    assert.equal(t.lead(live).status, 'approved', 'открытая карточка стала ложной конверсией');
    assertHistory(t.db, hist, 'came');
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM crm_conversion_log').get().n, 0);
  } finally { t.close(); }
});

test('перенос: история идёт за конверсией, updated_at не меняется, журнал — сколько, откуда, куда, кто', async () => {
  const t = await startCrmApp();
  try {
    const a = historyCard(t.db);
    const b = historyCard(t.db, { patient: null, name: 'Вторая история', updated: daysAgoIso(30) });
    const bUpdated = t.lead(b).updated_at;
    const open = addLead(t.db, { status: 'recall', name: 'Живая' });
    await moveTo(t, 'approved');
    assert.deepEqual(wonKeys(t.db), ['approved']);
    assertHistory(t.db, a, 'approved');
    assert.equal(t.lead(b).status, 'approved');
    assert.equal(t.lead(b).updated_at, bUpdated);
    assert.equal(t.lead(open).status, 'recall', 'перенос тронул живую карточку');
    assert.equal(t.db.prepare("SELECT COUNT(*) n FROM crm_requests WHERE status = 'came'").get().n, 0, 'прежняя конверсия не опустела');
    assert.equal(listStages(t.db).find((s) => s.key === 'came').kind, 'open');
    const log = t.db.prepare('SELECT moved_by, from_stage, to_stage, cards_moved, moved_at FROM crm_conversion_log').all();
    assert.equal(log.length, 1);
    assert.deepEqual({ ...log[0], moved_at: undefined }, { moved_by: 1, from_stage: 'came', to_stage: 'approved', cards_moved: 2, moved_at: undefined });
    assert.match(log[0].moved_at, /^\d{4}-\d{2}-\d{2}T/);
    // И обратно: «Пришёл» теперь пуста — история возвращается туда же.
    await moveTo(t, 'came');
    assertHistory(t.db, a, 'came');
    assert.deepEqual(wonKeys(t.db), ['came']);
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM crm_conversion_log').get().n, 2);
  } finally { t.close(); }
});
