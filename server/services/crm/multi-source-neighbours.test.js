// CRM_MULTI_SOURCE_V1 (2026-09-29) — СОСЕДИ, КОТОРЫЕ ПИШУТ ЗАЯВКУ САМИ.
//
// Звонок → заявка (lead-from-call.js) и зеркало записи календаря
// (booking-mirror.js attachVisitToCrm) пишут только главный source — правило
// чтения делает из него [source], и доска с отчётом видят их как прежде.
// Слияние дублей (rpc/crm-merge.js) даёт оставленной заявке объединение
// источников всех сливаемых, главный — её собственный. Справочник источников
// (config.js saveSources) не удаляет ключ, который стоит у заявки хотя бы
// вторым: иначе в её sources остался бы ключ, которого нет нигде.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { recordCall } from '../telephony/poller.js';
import { attachVisitToCrm } from './booking-mirror.js';
import { saveSources, listSources, CrmConfigError } from './config.js';
import { crmMergeLeads } from '../rpc/crm-merge.js';
import { callcenterReport } from '../rpc/callcenter.js';
import { unionLeadSources } from './sources.js';
import { leadSources, MAX_LEAD_SOURCES } from '../../../public/js/admin/crm-sources.js';

const BOSS = { id: 1, role: 'admin', extra_roles: [] };
const CC = { id: 2, role: 'callcenter', extra_roles: [] };

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role) VALUES (?,?,?,?,?)');
  u.run(1, 'boss', 'x', 'Админ', 'admin');
  u.run(2, 'cc', 'x', 'Оператор', 'callcenter');
  u.run(10, 'doc', 'x', 'Врач', 'doctor');
  db.prepare("INSERT INTO patients (id, full_name, mrn, phone) VALUES (77, 'Пациент Тест', 'M-77', '+998900000077')").run();
  return db;
}
const lead = (db, o) => Number(db.prepare(`INSERT INTO crm_requests (full_name, phone, status, source, sources, created_at)
  VALUES (@full_name, @phone, @status, @source, @sources, @created_at)`).run({
  full_name: 'Лид', phone: '+998 33 322 22 88', status: 'in_process', source: 'call', sources: null,
  created_at: '2026-09-14T10:00:00Z', ...o }).lastInsertRowid);
const get = (db, id) => db.prepare('SELECT source, sources FROM crm_requests WHERE id = ?').get(id);

test('звонок → заявка: пишет только source «Телефония», читается [telephony] и считается в отчёте', () => {
  const db = fresh();
  try {
    assert.equal(recordCall(db, {
      generalCallID: 'GC-MS', startTime: Math.floor(Date.now() / 1000), callType: 0,
      internalNumber: '901', externalNumber: '+998909610004', waitsec: '5', billsec: '73',
      disposition: 'ANSWER', isNewCall: '1',
    }, 'poll'), true);
    const r = db.prepare('SELECT source, sources FROM crm_requests').get();
    assert.deepEqual(r, { source: 'telephony', sources: null });
    assert.deepEqual(leadSources(r), ['telephony']);
    const rep = callcenterReport(db, { from: '2000-01-01', to: '2100-01-01' }, BOSS);
    assert.deepEqual(rep.bySource.map((x) => [x.source, x.count]), [['telephony', 1]]);
  } finally { db.close(); }
});

test('зеркало записи: колл-центр записал без заявки — новая заявка «Звонок», читается [call]', () => {
  const db = fresh();
  try {
    const day = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
    const vid = Number(db.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, status, created_by) VALUES (77, 10, ?, 'scheduled', 2)")
      .run(day + 'T09:00:00Z').lastInsertRowid);
    const rid = attachVisitToCrm(db, vid, CC);
    assert.ok(rid, 'зеркало не завело заявку');
    const r = get(db, rid);
    assert.deepEqual(r, { source: 'call', sources: null });
    assert.deepEqual(leadSources(r), ['call']);
  } finally { db.close(); }
});

test('слияние: оставленная получает объединение источников, главный — её собственный', () => {
  const db = fresh();
  try {
    const keep = lead(db, { source: 'instagram', sources: '["instagram"]', created_at: '2026-09-15T10:00:00Z' });
    const early = lead(db, { source: 'referral', sources: '["referral","call"]', created_at: '2026-09-10T10:00:00Z' });
    // Заявка от соседа — только source (sources пуст): её ключ тоже в объединении.
    const late = lead(db, { source: 'telegram', sources: null, created_at: '2026-09-20T10:00:00Z' });
    const res = crmMergeLeads(db, { keep_id: keep, merge_ids: [late, early] }, BOSS);
    assert.deepEqual(get(db, keep), { source: 'instagram', sources: '["instagram","referral","call","telegram"]' },
      'порядок: свои, затем влитые от ранней к поздней');
    assert.equal(res.lead.source, 'instagram', 'главный источник оставленной переписан');
    assert.deepEqual(leadSources(res.lead), ['instagram', 'referral', 'call', 'telegram']);
  } finally { db.close(); }
});

test('слияние: оставленная без sources (только source) — её source остаётся главным', () => {
  const db = fresh();
  try {
    const keep = lead(db, { source: 'telephony', sources: null });
    const other = lead(db, { source: 'instagram', sources: '["instagram","website"]', created_at: '2026-09-16T10:00:00Z' });
    crmMergeLeads(db, { keep_id: keep, merge_ids: [other] }, BOSS);
    assert.deepEqual(get(db, keep), { source: 'telephony', sources: '["telephony","instagram","website"]' });
  } finally { db.close(); }
});

test('слияние: объединение не длиннее десяти — свои источники не теряются', () => {
  const keys = Array.from({ length: 12 }, (_, i) => 'k' + i);
  assert.deepEqual(unionLeadSources([{ sources: keys.slice(0, 6) }, { sources: keys.slice(3, 12) }]), keys.slice(0, MAX_LEAD_SOURCES));
  assert.deepEqual(unionLeadSources([{ source: 'call' }, { source: '' }]), ['call', 'other']);
  const db = fresh();
  try {
    db.pragma('foreign_keys = OFF');   // ключи k* — не из справочника; слиянию важен только порядок
    const keep = lead(db, { source: 'k0', sources: JSON.stringify(keys.slice(0, 6)) });
    const other = lead(db, { source: 'k6', sources: JSON.stringify(keys.slice(6, 12)), created_at: '2026-09-16T10:00:00Z' });
    crmMergeLeads(db, { keep_id: keep, merge_ids: [other] }, BOSS);
    db.pragma('foreign_keys = ON');
    assert.deepEqual(JSON.parse(get(db, keep).sources), keys.slice(0, 10));
    assert.equal(get(db, keep).source, 'k0');
  } finally { db.close(); }
});

test('справочник: источник, стоящий у заявки только вторым, не удаляется (409); свободный — удаляется', () => {
  const db = fresh();
  try {
    lead(db, { source: 'call', sources: '["call","telegram"]' });
    const without = (key) => listSources(db).filter((s) => s.key !== key).map((s) => ({ key: s.key, label: s.label, is_active: s.is_active }));
    assert.throws(() => saveSources(db, without('telegram')),
      (e) => e instanceof CrmConfigError && e.status === 409 && /«telegram» стоит у 1 заявок/.test(e.message));
    assert.ok(listSources(db).some((s) => s.key === 'telegram'), 'источник удалён, хотя стоит у заявки');
    saveSources(db, without('website'));
    assert.ok(!listSources(db).some((s) => s.key === 'website'), 'свободный источник не удалился');
  } finally { db.close(); }
});
