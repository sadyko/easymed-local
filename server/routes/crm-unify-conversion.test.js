// CRM_UNIFY_V1 — «КОЛОНКА КОНВЕРСИИ (ПРИШЁЛ)» И «КОЛОНКА ЗАПИСИ» — НАСТРОЙКИ
// «CRM-канбан» (дополнение владельца 2026-10-09), через настоящие двери
// /api/rpc под настоящими ролями.
//
// Выбор конверсии переносит вид won на выбранную колонку одной транзакцией.
// Всё, что ищет конверсию, читает вид won (wonStageKey), поэтому после смены
// приход — регистрация на стойке (crmLinkVisit desk) и отметка «Пришёл» в
// календаре (crmVisitStatus) — кладёт карточку в НОВУЮ конверсию, а запись —
// в «Колонку записи», посчитанную от новой конверсии. Карточки при смене не
// двигаются. Сохранить может только администратор.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay, addLead } from '../test-helpers/crm-unify-app.js';
import { wonStageKey, scheduledStageKey } from '../services/crm/config.js';

const TODAY = localDay(0);
const wonKeys = (db) => db.prepare("SELECT key FROM crm_stages WHERE kind = 'won'").all().map((r) => r.key);
const seedOther = (db) => db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (78,'Другой Пациент','+998 91 111 22 33')").run();

test('конверсия «Подтверждён»: ровно одна won; карточки прежней «Пришёл» не тронуты; стойка закрывает в новую', async () => {
  const t = await startCrmApp(seedOther);
  try {
    const old = addLead(t.db, { status: 'came', patient: 78, phone: '+998 91 111 22 33', name: 'Старая конверсия' });
    const s = await t.rpc('crm_config_save', 'boss', { settings: { won_stage: 'approved' } });
    assert.equal(s.status, 200, s.text);
    assert.deepEqual(wonKeys(t.db), ['approved'], 'после сохранения конверсия ровно одна');
    assert.equal(wonStageKey(t.db), 'approved');
    assert.equal(t.lead(old).status, 'came', 'карточка прежней конверсии переехала');

    const rid = addLead(t.db, { assigned: 3 });
    const r = await t.rpc('ensure_visit', 'reg', { patient_id: 77, date: new Date().toISOString(), doctor_id: 10,
      visit_type: 'outpatient', desk: true });
    assert.equal(r.status, 200, r.text);
    assert.equal(t.lead(rid).status, 'approved', 'регистрация на стойке закрыла карточку не в новую конверсию');
    assert.equal(t.lead(old).status, 'came', 'приход чужого пациента тронул карточку прежней конверсии');
  } finally { t.close(); }
});

test('конверсия «Успешно» (своя колонка клиники): запись — в колонку записи, отметка «Пришёл» в календаре — в новую конверсию', async () => {
  const t = await startCrmApp((db) => {
    // Воронка клиники: «Успешно» — открытая колонка после «Не пришёл».
    db.prepare("INSERT INTO crm_stages (key, label, color, position, is_active, kind) VALUES ('uspeshno','Успешно','ok',9,1,'open')").run();
  });
  try {
    const s = await t.rpc('crm_config_save', 'boss', { settings: { won_stage: 'uspeshno', booked_stage: 'approved' } });
    assert.equal(s.status, 200, s.text);
    assert.deepEqual(wonKeys(t.db), ['uspeshno']);
    assert.equal(scheduledStageKey(t.db), 'approved');
    assert.equal(s.json.data.settings.booked_effective, 'approved');

    const rid = addLead(t.db, { assigned: 3 });
    const e = await t.rpc('ensure_visit', 'reg', { patient_id: 77, date: TODAY, doctor_id: 10 });
    assert.equal(e.status, 200, e.text);
    assert.equal(t.lead(rid).status, 'approved', 'запись положила карточку не в выбранную колонку записи');

    const vid = e.json.data.visit.id;
    const when = t.db.prepare('SELECT visit_date FROM visits WHERE id = ?').get(vid).visit_date;
    const arr = await t.rpc('calendar_book', 'reg', { visit_id: vid, status: 'arrived', start: when });
    assert.equal(arr.status, 200, arr.text);
    assert.equal(t.lead(rid).status, 'uspeshno', 'отметка «Пришёл» закрыла карточку не в новую конверсию');
  } finally { t.close(); }
});

test('оператор и регистратура не меняют конверсию; отказы сервера — понятной фразой', async () => {
  const t = await startCrmApp();
  try {
    for (const who of ['cc', 'reg', 'head']) {
      const r = await t.rpc('crm_config_save', who, { settings: { won_stage: 'approved' } });
      assert.equal(r.status, 403, who + ': ' + r.text);
    }
    for (const [settings, re] of [
      [{ won_stage: 'stopped' }, /Проигрышная колонка/],
      [{ won_stage: 'no_show' }, /Проигрышная колонка/],
      [{ booked_stage: 'approved', won_stage: 'scheduled' }, /Колонка записи/],
    ]) {
      const r = await t.rpc('crm_config_save', 'boss', { settings });
      assert.equal(r.status, 400, r.text);
      assert.match(r.text, re);
    }
    t.db.prepare("UPDATE crm_stages SET is_active = 0 WHERE key = 'approved'").run();
    const hidden = await t.rpc('crm_config_save', 'boss', { settings: { won_stage: 'approved' } });
    assert.equal(hidden.status, 400, hidden.text);
    assert.match(hidden.text, /Скрытая колонка/);
    assert.deepEqual(wonKeys(t.db), ['came'], 'отказ сдвинул конверсию');
  } finally { t.close(); }
});
