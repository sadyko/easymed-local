// DOCS_FEED_V1 — лента готовых документов по всей клинике.
//
// Раздел «Документы» умел только одно: найти пациента и собрать бланк ему.
// Чтобы ответить на вопрос «что вообще готово за эту неделю», приходилось
// перебирать пациентов по одному. Здесь тот же материал развёрнут в список:
// каждая услуга, по которой есть результат или подписанный документ, — строка.
//
// ОДНА строка = ОДНА услуга (анализ, снимок, заключение), а не визит. Пациент
// с пятью анализами занимает пять строк — так фильтр по типу услуги вообще
// имеет смысл, а «Результаты анализов» отделяются от «Диагностики».
//
// Источников содержимого два, и они дополняют друг друга:
//   lab_results     — результаты анализов И диагностики (одна таблица на оба,
//                     см. service-workspace.js: «Labs + diagnostics use the
//                     same lab_results table»);
//   visit_documents — подписанные в кабинете заключения и загруженные файлы.
// Услуга попадает в ленту, если есть хотя бы одно из двух.
//
// Дата — ДЕНЬ ВИЗИТА, а не created_at строки результата: клиника ищет «что
// было в понедельник», а не «когда лаборант нажал сохранить».

import { canViewSection } from '../roles.js';
import { inLocalRange, localDate } from '../domain/day.js';

export class RpcError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

const SECTION = 'patient-documents';
const PAGE_MAX = 100;
const PAGE_DEFAULT = 20;

// Услуга считается «документом», если по ней есть результат или подписанная
// бумага. Один и тот же предикат нужен и списку, и счётчикам, поэтому он один.
const HAS_DOC = `(
     EXISTS (SELECT 1 FROM lab_results     lr WHERE lr.visit_service_id = vs.id)
  OR EXISTS (SELECT 1 FROM visit_documents vd WHERE vd.visit_service_id = vs.id)
)`;

const ymd = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);

// Поиск по пациенту: локальный клиент не умеет .or(), но здесь мы пишем SQL
// сами, поэтому три колонки проверяются одним условием.
//
// lower_uni, а не lower: встроенный lower() в SQLite складывает регистр только
// у латиницы, и поиск «сабина» не находил «Сабина». Тот же UDF использует
// query-compiler для .ilike() (CYRILLIC_ILIKE_V1, db/connection.js).
function searchClause(q) {
  if (!q) return { sql: '', params: [] };
  const like = '%' + String(q).trim() + '%';
  return {
    // Название услуги ищется наравне с пациентом: «ОАК за эту неделю» —
    // такой же законный вопрос, как «документы Каримовой».
    sql: ` AND (lower_uni(p.full_name) LIKE lower_uni(?)`
       + ` OR lower_uni(COALESCE(p.mrn,'')) LIKE lower_uni(?)`
       + ` OR lower_uni(COALESCE(p.phone,'')) LIKE lower_uni(?)`
       + ` OR lower_uni(COALESCE(s.name,'')) LIKE lower_uni(?))`,
    params: [like, like, like, like],
  };
}

export function documentsFeed(db, args, user) {
  if (!canViewSection(db, user, SECTION)) {
    throw new RpcError('Раздел «Документы» вам не выдан.', 403);
  }
  const a = args || {};
  const from = ymd(a.from);
  const to = ymd(a.to);
  const q = String(a.q || '').trim();
  const types = Array.isArray(a.types) ? a.types.filter((t) => typeof t === 'string' && t) : [];
  const limit = Math.min(PAGE_MAX, Math.max(1, Number(a.limit) || PAGE_DEFAULT));
  const offset = Math.max(0, Number(a.offset) || 0);

  const where = [HAS_DOC];
  const params = [];
  if (from && to) { where.push(inLocalRange('v.visit_date')); params.push(from, to); }
  else if (from)  { where.push(`${localDate('v.visit_date')} >= date(?)`); params.push(from); }
  else if (to)    { where.push(`${localDate('v.visit_date')} <= date(?)`); params.push(to); }

  const search = searchClause(q);
  const baseSql = `
      FROM visit_services vs
      JOIN visits   v ON v.id = vs.visit_id
      LEFT JOIN patients p ON p.id = v.patient_id
      LEFT JOIN services s ON s.id = vs.service_id
     WHERE ${where.join(' AND ')}${search.sql}`;
  const baseParams = params.concat(search.params);

  // Счётчики по типам считаются БЕЗ фильтра по типу — иначе, выбрав
  // «Лаборатория», сотрудник увидел бы нули у всех остальных и решил, что
  // других документов за период нет.
  const byType = db.prepare(
    `SELECT COALESCE(s.type,'other') t, COUNT(*) c ${baseSql} GROUP BY t`).all(...baseParams);

  const typeWhere = types.length
    ? ` AND COALESCE(s.type,'other') IN (${types.map(() => '?').join(',')})`
    : '';
  const listParams = baseParams.concat(types);

  const total = db.prepare(
    `SELECT COUNT(*) c ${baseSql}${typeWhere}`).get(...listParams).c;

  const rows = db.prepare(`
    SELECT vs.id            AS visit_service_id,
           vs.visit_id      AS visit_id,
           vs.status        AS status,
           vs.verified_at   AS verified_at,
           v.visit_date     AS visit_date,
           v.patient_id     AS patient_id,
           p.full_name      AS patient_name,
           p.mrn            AS mrn,
           s.name           AS service_name,
           COALESCE(s.type,'other') AS service_type,
           (SELECT COUNT(*) FROM lab_results lr WHERE lr.visit_service_id = vs.id)     AS result_count,
           (SELECT vd.doc_type FROM visit_documents vd WHERE vd.visit_service_id = vs.id
             ORDER BY vd.created_at DESC LIMIT 1)                                      AS doc_type
      ${baseSql}${typeWhere}
     ORDER BY ${localDate('v.visit_date')} DESC, vs.id DESC
     LIMIT ? OFFSET ?`).all(...listParams, limit, offset);

  return {
    rows,
    total,
    // Сколько уже отдано — клиенту не надо складывать самому, а «Показать
    // ещё» должна знать, есть ли что показывать.
    has_more: offset + rows.length < total,
    next_offset: offset + rows.length,
    by_type: byType,
  };
}
