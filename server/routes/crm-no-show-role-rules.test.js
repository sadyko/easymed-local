// CRM_NO_SHOW_ANY_COLUMN_V1 (3.23.0, ревью потока E) — ГДЕ МОЖНО ОТМЕТИТЬ «НЕ ПРИШЁЛ», ЧЕРЕЗ НАСТОЯЩИЕ ДВЕРИ.
//
// Ревью (пробы rev-w23e/probe-noshow-open.mjs, probe-newborn-link.mjs): галочка «не пришёл» на
// «В обработке» превращала каждую новую заявку (доска, /api/db без статуса, звонок) в неявку — отчёты
// считали её потерей, а новая карта пациента её уже не находила (привязка ищет только живые заявки).
// Решение координатора (F1): у открытой колонки «не пришёл» — только ПОСЛЕ колонки записи и до
// конверсии, никогда у начальной «В обработке» и у колонки, куда звонки заводят заявки. Проигрышные —
// как прежде.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp } from '../test-helpers/crm-unify-app.js';

/** Колонки через экран «CRM-канбан» (crm_config_save под администратором). map: { key: role|null }; extra — новые колонки перед конверсией. */
async function saveRoles(t, map, extra = []) {
  const g = await t.rpc('crm_config_get', 'boss', {});
  assert.equal(g.status, 200, g.text);
  const stages = g.json.data.stages;
  const won = stages.findIndex((s) => s.kind === 'won');
  const ordered = [...stages.slice(0, won), ...extra, ...stages.slice(won)];
  const body = ordered.map((s) => ({ key: s.key, label: s.label, color: s.color || '', kind: s.kind || 'open', is_active: s.is_active !== false,
    role: Object.prototype.hasOwnProperty.call(map, s.key) ? map[s.key] : (s.role || null) }));
  return t.rpc('crm_config_save', 'boss', { stages: body });
}
const MISSED = { key: 'missed', label: 'Не дошли', color: 'crit', kind: 'open', is_active: true };

test('F1: «не пришёл» на «В обработке» и на «Перезвонить» (колонка звонков) — отказ 409; на открытой после записи — сохраняется', async () => {
  const t = await startCrmApp();
  try {
    const a = await saveRoles(t, { in_process: 'no_show', no_show: null });
    assert.equal(a.status, 409, a.text);
    assert.equal(a.json.error.message, 'Начальная колонка (в неё попадают новые заявки) не может быть колонкой «Не пришёл».');
    const b = await saveRoles(t, { recall: 'no_show', no_show: null });
    assert.equal(b.status, 409, b.text);
    assert.match(b.json.error.message, /^В эту колонку звонки заводят новые заявки/);
    const g = await t.rpc('crm_config_get', 'boss', {});
    assert.equal(g.json.data.stages.find((s) => s.role === 'no_show').key, 'no_show', 'отказ что-то записал');
    assert.ok(g.json.data.routed_stages.includes('in_process') && g.json.data.routed_stages.includes('recall'), 'экран не узнает колонки звонков');
    const ok = await saveRoles(t, { no_show: null, missed: 'no_show' }, [MISSED]);
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.data.stages.find((s) => s.role === 'no_show').key, 'missed');
  } finally { t.close(); }
});

// Проба probe-newborn-link.mjs: заявка, рождённая умолчанием (/api/db без статуса — «В обработке»), находит
// новую карту пациента, когда колонка «Не пришёл» — открытая (после записи); «В обработке» ею не бывает.
test('F1: с открытой колонкой «Не пришёл» новая заявка рождается живой и привязывается к новой карте пациента', async () => {
  const t = await startCrmApp();
  try {
    assert.equal((await saveRoles(t, { no_show: null, missed: 'no_show' }, [MISSED])).status, 200);
    const lead = await t.dbq('cc', { table: 'crm_requests', op: 'insert', returning: true, single: 'single',
      values: { full_name: 'Алиев Вали', phone: '+998 90 123 45 67', source: 'call' } });
    assert.equal(lead.status, 200, lead.text);
    assert.equal(t.lead(lead.json.data.id).status, 'in_process');
    const pat = await t.dbq('reg', { table: 'patients', op: 'insert', returning: true, single: 'single',
      values: { full_name: 'Алиев Вали', phone: '+998 90 123 45 67' } });
    assert.equal(pat.status, 200, pat.text);
    const r = await t.rpc('crm_link_new_patient', 'reg', { patient_id: pat.json.data.id });
    assert.equal(r.status, 200, r.text);
    assert.equal(t.lead(lead.json.data.id).patient_id, pat.json.data.id, 'новая заявка не нашла новую карту пациента');
  } finally { t.close(); }
});
