// V3120_PERF — лента документов переписана ради скорости (индекс по дню визита,
// один счётный проход, страница по полосе дней). Выдача обязана остаться
// ТОЙ ЖЕ: здесь прежняя реализация воспроизведена дословно (referenceFeed) и
// сравнивается с новой на пёстрых данных — полночь по местному времени, оба
// формата visit_date, чужие здания, фильтр типов, поиск, страницы, границы
// которых режут дни. Меняется только одно, намеренно: пустой период —
// последние DEFAULT_DAYS дней, а не вся история; и период не длиннее года.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { documentsFeed, DEFAULT_DAYS, MAX_SPAN_DAYS } from './documents.js';
import { inLocalRange, localDate } from '../domain/day.js';
import {
  buildingContext, originExpr, summariseByBuilding, labScopeOf, labScopeWhere,
} from '../domain/buildings.js';

const ADMIN = { id: 1, role: 'admin' };

// ── прежняя реализация (до V3120_PERF), без проверки прав ────────────────────
const HAS_DOC = `(
     EXISTS (SELECT 1 FROM lab_results     lr WHERE lr.visit_service_id = vs.id)
  OR EXISTS (SELECT 1 FROM visit_documents vd WHERE vd.visit_service_id = vs.id)
)`;
const ymd = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
function searchClause(q) {
  if (!q) return { sql: '', params: [] };
  const like = '%' + String(q).trim() + '%';
  return {
    sql: ` AND (lower_uni(p.full_name) LIKE lower_uni(?)`
       + ` OR lower_uni(COALESCE(p.mrn,'')) LIKE lower_uni(?)`
       + ` OR lower_uni(COALESCE(p.phone,'')) LIKE lower_uni(?)`
       + ` OR lower_uni(COALESCE(s.name,'')) LIKE lower_uni(?))`,
    params: [like, like, like, like],
  };
}
function referenceFeed(db, a) {
  const from = ymd(a.from); const to = ymd(a.to);
  const q = String(a.q || '').trim();
  const types = Array.isArray(a.types) ? a.types.filter((t) => typeof t === 'string' && t) : [];
  const limit = Math.min(100, Math.max(1, Number(a.limit) || 20));
  const offset = Math.max(0, Number(a.offset) || 0);
  const ctx = buildingContext(db);
  const labScope = labScopeOf(db);
  const scopeSql = labScopeWhere(db, labScope, 'visit_services', 'vs');
  const where = [HAS_DOC]; const params = [];
  if (from && to) { where.push(inLocalRange('v.visit_date')); params.push(from, to); }
  else if (from) { where.push(`${localDate('v.visit_date')} >= date(?)`); params.push(from); }
  else if (to) { where.push(`${localDate('v.visit_date')} <= date(?)`); params.push(to); }
  const search = searchClause(q);
  const baseSql = `
      FROM visit_services vs
      JOIN visits   v ON v.id = vs.visit_id
      LEFT JOIN patients p ON p.id = v.patient_id
      LEFT JOIN services s ON s.id = vs.service_id
     WHERE ${where.join(' AND ')}${scopeSql}${search.sql}`;
  const baseParams = params.concat(search.params);
  const byType = db.prepare(`SELECT COALESCE(s.type,'other') t, COUNT(*) c ${baseSql} GROUP BY t`).all(...baseParams);
  const typeWhere = types.length ? ` AND COALESCE(s.type,'other') IN (${types.map(() => '?').join(',')})` : '';
  const listParams = baseParams.concat(types);
  const total = db.prepare(`SELECT COUNT(*) c ${baseSql}${typeWhere}`).get(...listParams).c;
  const rows = db.prepare(`
    SELECT vs.id AS visit_service_id, vs.visit_id AS visit_id, vs.status AS status, vs.verified_at AS verified_at,
           v.visit_date AS visit_date, v.patient_id AS patient_id, p.full_name AS patient_name, p.mrn AS mrn,
           s.name AS service_name, COALESCE(s.type,'other') AS service_type,
           (SELECT COUNT(*) FROM lab_results lr WHERE lr.visit_service_id = vs.id) AS result_count,
           (SELECT vd.doc_type FROM visit_documents vd WHERE vd.visit_service_id = vs.id ORDER BY vd.created_at DESC LIMIT 1) AS doc_type,
           ${originExpr(db, 'visit_services', 'vs')} AS origin
      ${baseSql}${typeWhere}
     ORDER BY ${localDate('v.visit_date')} DESC, vs.id DESC
     LIMIT ? OFFSET ?`).all(...listParams, limit, offset);
  const ids = rows.map((r) => r.visit_service_id);
  if (ids.length) {
    const lr = db.prepare(`SELECT id, visit_service_id, parameter, value, unit, flag FROM lab_results WHERE visit_service_id IN (${ids.map(() => '?').join(',')})`).all(...ids);
    const latest = new Map();
    for (const r of lr) { const k = r.visit_service_id + '\0' + (r.parameter || ''); const p = latest.get(k); if (!p || r.id > p.id) latest.set(k, r); }
    const byVs = new Map();
    for (const r of [...latest.values()].sort((x, y) => x.id - y.id)) {
      if (!byVs.has(r.visit_service_id)) byVs.set(r.visit_service_id, []);
      byVs.get(r.visit_service_id).push({ parameter: r.parameter || '', value: r.value == null ? '' : String(r.value), unit: r.unit || '', flag: r.flag || '' });
    }
    for (const row of rows) row.results = byVs.get(row.visit_service_id) || [];
  }
  for (const row of rows) row.building = ctx.label(row.origin);
  return {
    rows, total, has_more: offset + rows.length < total, next_offset: offset + rows.length, by_type: byType,
    by_building: summariseByBuilding(ctx,
      db.prepare(`SELECT ${originExpr(db, 'visit_services', 'vs')} AS origin, COUNT(*) AS n ${baseSql} GROUP BY origin`).all(...baseParams),
      { n: (r) => r.n }).map(({ n, ...b }) => ({ ...b, rows: n })),
    lab_scope: labScope,
  };
}

// ── пёстрые данные ───────────────────────────────────────────────────────────
function seed() {
  const db = openDb(':memory:');
  migrate(db);
  db.pragma('foreign_keys = OFF');
  db.prepare("INSERT INTO branches (name, letter, active) VALUES ('Чиланзар','B',0)").run();
  const svc = db.prepare('INSERT INTO services (id, name, price, type, is_lab) VALUES (?,?,0,?,?)');
  svc.run(1, 'ОАК', 'lab', 1); svc.run(2, 'УЗИ почек', 'imaging', 0); svc.run(3, 'Приём терапевта', 'consultation', 0);
  svc.run(4, 'Перевязка', 'procedure', 0); svc.run(5, 'Разное', 'other', 0);
  const names = ['Каримова Сабина', 'Олимов Турсунбой', 'Иванов Иван', 'Петрова Анна'];
  for (let i = 1; i <= 4; i++) db.prepare('INSERT INTO patients (id, full_name, mrn, phone) VALUES (?,?,?,?)').run(i, names[i - 1], 'A-26-0000' + i, '+99890111000' + i);

  const off = db.prepare("SELECT CAST(strftime('%s','now','localtime') AS INTEGER) - CAST(strftime('%s','now') AS INTEGER) s").get().s;
  const today = db.prepare("SELECT date('now','localtime') d").get().d;
  // Местная полночь дня d (UTC-миллисекунды) — отсюда края суток.
  const midnight = (d) => Date.parse(d + 'T00:00:00Z') - off * 1000;
  const dayOf = (k) => db.prepare('SELECT date(?, ?) d').get(today, k + ' days').d;
  let rnd = 7;
  const rand = (n) => {                         // mulberry32 — воспроизводимо
    rnd = (rnd + 0x6D2B79F5) | 0;
    let t = Math.imul(rnd ^ (rnd >>> 15), 1 | rnd);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (((t ^ (t >>> 14)) >>> 0) % n);
  };
  const insV = db.prepare("INSERT INTO visits (patient_id, visit_date, status) VALUES (?,?,'arrived') RETURNING id");
  const insVs = db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status, sync_origin) VALUES (?,?,1,0,0,'completed',?) RETURNING id");
  const insLr = db.prepare("INSERT INTO lab_results (visit_service_id, parameter, value, unit, flag) VALUES (?,?,?,?,?)");
  const insDoc = db.prepare("INSERT INTO visit_documents (title, doc_type, visit_id, visit_service_id, patient_id, created_at) VALUES ('Док',?,?,?,?,?)");
  // Сдвиги от полуночи: сама полночь, минута до и после, миллисекунда, середина дня.
  const edges = [0, 60e3, -60e3, 500, -1, 9 * 3600e3, 23 * 3600e3 + 59 * 60e3];
  for (let k = -130; k <= 3; k++) {
    const d = dayOf(k);
    const nVisits = 1 + rand(4);
    for (let j = 0; j < nVisits; j++) {
      const ms = midnight(d) + edges[rand(edges.length)];
      const iso = new Date(ms).toISOString();
      const vd = rand(2) ? iso : iso.slice(0, 19) + 'Z';     // '….000Z' и '…Z' — обе формы есть в базе
      const v = insV.get(1 + rand(4), vd).id;
      for (let m = 0; m < 1 + rand(4); m++) {
        const sid = 1 + rand(6); const vs = insVs.get(v, sid === 6 ? 99 : sid, rand(5) === 0 ? 'B' : null).id;
        const what = rand(4);                                   // 0 — ничего (не документ)
        if (what === 1 || what === 3) for (let r = 0; r < 1 + rand(3); r++) insLr.run(vs, 'P' + rand(3), String(rand(100)), 'г/л', rand(2) ? 'normal' : 'high');
        if (what >= 2) insDoc.run(['protocol', 'conclusion', 'diag'][rand(3)], v, vs, 1, `2026-01-0${1 + rand(9)}T10:00:00Z`);
      }
    }
  }
  return { db, today, dayOf };
}

const strip = (r) => { const { range, ...rest } = r; return rest; };

test('лента: выдача совпадает с прежней реализацией на любом явном периоде ≤ года', () => {
  const { db, dayOf } = seed();
  const cases = [];
  const periods = [[dayOf(0), dayOf(0)], [dayOf(-6), dayOf(0)], [dayOf(-1), dayOf(-1)], [dayOf(-40), dayOf(-3)], [dayOf(-130), dayOf(3)], [dayOf(-89), null], [dayOf(-2), null]];
  for (const [from, to] of periods) {
    for (const types of [[], ['lab'], ['imaging', 'other'], ['nonexistent']]) {
      for (const q of ['', 'иван', 'УЗИ', '0002']) {
        for (const [limit, offset] of [[20, 0], [7, 0], [7, 7], [5, 13], [100, 0], [3, 250], [20, 99999]]) {
          cases.push({ from, to: to || '', types, q, limit, offset });
        }
      }
    }
  }
  let nonEmpty = 0;
  for (const a of cases) {
    const want = referenceFeed(db, a);
    const got = documentsFeed(db, a, ADMIN);
    assert.deepEqual(strip(got), want, JSON.stringify(a));
    assert.equal(got.range.defaulted, false);
    if (want.rows.length) nonEmpty++;
  }
  assert.ok(nonEmpty > cases.length / 4, 'сравнение обязано идти на непустых страницах');
  db.close();
});

test('лента: постраничный обход даёт ровно ту же последовательность, что прежняя', () => {
  const { db, dayOf } = seed();
  const a = { from: dayOf(-130), to: dayOf(3) };
  const walk = (fn) => { const out = []; for (let off = 0; ; off += 9) { const r = fn({ ...a, limit: 9, offset: off }); out.push(...r.rows.map((x) => x.visit_service_id)); if (!r.has_more) break; } return out; };
  const want = walk((x) => referenceFeed(db, x));
  assert.ok(want.length > 100);
  assert.deepEqual(walk((x) => documentsFeed(db, x, ADMIN)), want);
  db.close();
});

test('лента: при lab_scope=building выдача та же, что прежде', () => {
  const { db, dayOf } = seed();
  db.prepare("UPDATE doc_settings SET lab_scope = 'building' WHERE id = 1").run();
  for (const a of [{ from: dayOf(-30), to: dayOf(0) }, { from: dayOf(-30), to: dayOf(0), types: ['lab'], limit: 5, offset: 5 }]) {
    assert.deepEqual(strip(documentsFeed(db, a, ADMIN)), referenceFeed(db, a));
  }
  db.close();
});

test('лента: пустой период — последние DEFAULT_DAYS дней (и позже), с флагом', () => {
  const { db, dayOf } = seed();
  for (const a of [{}, { from: '', to: '' }, { from: 'вчера' }]) {
    const got = documentsFeed(db, a, ADMIN);
    assert.deepEqual(got.range, { from: dayOf(-(DEFAULT_DAYS - 1)), to: null, defaulted: true, capped: false, default_days: DEFAULT_DAYS, max_days: MAX_SPAN_DAYS });
    assert.deepEqual(strip(got), referenceFeed(db, { ...a, from: dayOf(-(DEFAULT_DAYS - 1)) }));
    assert.ok(got.total < referenceFeed(db, {}).total, 'старше 90 дней — не в ленте «по умолчанию»');
  }
  // Только конец периода: начало — за DEFAULT_DAYS дней до него.
  const only = documentsFeed(db, { to: dayOf(-10) }, ADMIN);
  assert.equal(only.range.from, dayOf(-10 - (DEFAULT_DAYS - 1)));
  assert.deepEqual(strip(only), referenceFeed(db, { from: dayOf(-10 - (DEFAULT_DAYS - 1)), to: dayOf(-10) }));
  db.close();
});

test('лента: период длиннее года подтягивается к году, с флагом', () => {
  const { db, dayOf } = seed();
  const got = documentsFeed(db, { from: '2020-01-01', to: dayOf(0) }, ADMIN);
  assert.equal(got.range.capped, true);
  assert.equal(got.range.from, dayOf(-(MAX_SPAN_DAYS - 1)));
  assert.deepEqual(strip(got), referenceFeed(db, { from: dayOf(-(MAX_SPAN_DAYS - 1)), to: dayOf(0) }));
  const ok = documentsFeed(db, { from: dayOf(-(MAX_SPAN_DAYS - 1)), to: dayOf(0) }, ADMIN);
  assert.equal(ok.range.capped, false, 'ровно год — не обрезается');
  db.close();
});
