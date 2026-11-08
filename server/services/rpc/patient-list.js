// PATIENT_LIST_LAST_VISIT_V1 (владелец, 2026-11-07, по снимку картотеки: «put
// filter button … and make the sort button too, for instance it should be
// possible to sort based on last visit date») — страница картотеки, когда её
// сортируют или отбирают по ПОСЛЕДНЕМУ ВИЗИТУ.
//
// Почему отдельная дверь, а не /api/db. Обычную страницу картотеки собирает
// компилятор запросов (data.js loadPatientsPaged → /api/db), но «последнего
// визита» у пациента колонкой нет: это вычисление по визитам
// (domain/visit-summary.js, LAST_VISIT_TRUE_V1 — отменённые, неявки и пустые
// перенесённые записи не считаются). Сортировать по нему в браузере значило бы
// сортировать только 30 строк страницы; здесь сортируется вся картотека, а
// правило «состоялся» — то же самое фрагментом visitsWithHappenedSql, поэтому
// колонка «Последний визит», отбор и сортировка не расходятся.
//
// Остальные условия страницы — ТЕ ЖЕ, что у /api/db, и в том же смысле:
//   • поиск по словам (PATIENT_SEARCH_TOKENS_V1): каждое слово ищется в ФИО,
//     номере карты и телефоне (длинный цифровой — ещё и «с пробелами»), слова
//     через И; разбор слов — общий модуль patient-search.js;
//   • дата рождения — точное совпадение (PATIENT_SEARCH_DOB_V2);
//   • ids — ограничение «Дубликатов»; branch_ids — только когда экран сузил
//     выбор зданий (branchSelectionNarrows), как branchScope у /api/db.
// Колонки ответа — ровно читаемые колонки patients из реестра.
//
// Сортировка «по последнему визиту» у пациента без визитов берёт день
// регистрации — ту же дату, которую строка картотеки показывает в колонке
// «Последний визит» с пометкой «визитов не было». Отбор по периоду — только
// по НАСТОЯЩЕМУ последнему визиту: пациент без визитов в период не попадает.
import { RpcError } from './crm-config.js';
import { effectiveRoles, canViewSection } from '../roles.js';
import { canRead, readableColumns } from '../../db/schema-registry.js';
import { visitsWithHappenedSql } from '../domain/visit-summary.js';
import { localDate, today as clinicToday } from '../domain/day.js';
import { searchTokens, loosePhonePattern } from '../../../public/js/admin/patient-search.js';

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const SORTS = Object.freeze(['recent', 'az', 'mrn', 'last_visit_desc', 'last_visit_asc']);
const MAX_LIMIT = 200;

function idList(raw) {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) throw new RpcError('Список пациентов указан неверно.', 400);
  return [...new Set(raw.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
}
// I18N_COVERAGE_V1 — отказ целой фразой (клиент переводит его по словарю), а не склейкой.
function ymdArg(raw, refusal) {
  if (raw === undefined || raw === null || raw === '') return null;
  const v = String(raw).slice(0, 10);
  if (!YMD.test(v)) throw new RpcError(refusal, 400);
  return v;
}

/**
 * patient_list_page({ search?, dob?, ids?, branch_ids?, last_from?, last_to?, sort?, limit?, offset? })
 *   → { rows: [patients…], total }
 */
export function patientListPage(db, args, user) {
  const roles = effectiveRoles(user);
  if (!canViewSection(db, user, 'patients') || !canRead('patients', roles)) {
    throw new RpcError('Раздел «Пациенты» вашей роли не выдан.', 403);
  }
  const a = args || {};
  const sort = a.sort == null || a.sort === '' ? 'recent' : String(a.sort);
  if (!SORTS.includes(sort)) throw new RpcError('Неизвестный порядок сортировки.', 400);
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number.parseInt(a.limit, 10) || 30));
  const offset = Math.max(0, Number.parseInt(a.offset, 10) || 0);
  const lastFrom = ymdArg(a.last_from, 'Начало периода указано неверно.');
  const lastTo = ymdArg(a.last_to, 'Конец периода указан неверно.');
  if (lastFrom && lastTo && lastFrom > lastTo) throw new RpcError('Начало периода позже его конца.', 400);
  const dob = ymdArg(a.dob, 'Дата рождения указана неверно.');
  const ids = idList(a.ids);
  const branchIds = idList(a.branch_ids);
  if (ids && !ids.length) return { rows: [], total: 0 };

  const where = [];
  const params = [];
  for (const token of searchTokens(a.search)) {
    const pat = `%${token}%`;
    const terms = ["lower_uni(p.full_name) LIKE lower_uni(?) ESCAPE '\\'", "lower_uni(p.mrn) LIKE lower_uni(?) ESCAPE '\\'",
      "lower_uni(p.phone) LIKE lower_uni(?) ESCAPE '\\'"];
    params.push(pat, pat, pat);
    const loose = loosePhonePattern(token);
    if (loose) { terms.push('p.phone LIKE ?'); params.push(loose); }
    where.push('(' + terms.join(' OR ') + ')');
  }
  if (dob) { where.push('p.date_of_birth = ?'); params.push(dob); }
  if (ids) { where.push('p.id IN (SELECT value FROM json_each(?))'); params.push(JSON.stringify(ids)); }
  if (branchIds) { where.push('p.branch_id IN (SELECT value FROM json_each(?))'); params.push(JSON.stringify(branchIds)); }
  if (lastFrom || lastTo) {
    where.push('lv.last_jd IS NOT NULL');
    if (lastFrom) { where.push(`${localDate('lv.last_jd')} >= ?`); params.push(lastFrom); }
    if (lastTo) { where.push(`${localDate('lv.last_jd')} <= ?`); params.push(lastTo); }
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const regJd = "julianday(COALESCE(NULLIF(p.registration_date, ''), p.created_at))";
  const order = {
    recent: "p.registration_date DESC, p.created_at DESC, p.id DESC",
    az: 'p.last_name IS NULL, p.last_name ASC, p.id ASC',
    mrn: 'p.mrn IS NULL, p.mrn ASC, p.id ASC',
    last_visit_desc: `COALESCE(lv.last_jd, ${regJd}) DESC, p.id DESC`,
    last_visit_asc: `COALESCE(lv.last_jd, ${regJd}) ASC, p.id ASC`,
  }[sort];

  const day = clinicToday(db);
  const lvSql = `SELECT pid, MAX(CASE WHEN ok = 1 THEN jd END) AS last_jd
                   FROM (${visitsWithHappenedSql()}) GROUP BY pid`;
  const from = `FROM patients p LEFT JOIN (${lvSql}) lv ON lv.pid = p.id ${whereSql}`;
  const cols = readableColumns('patients').map((c) => 'p.' + c).join(', ');

  const total = db.prepare(`SELECT COUNT(*) AS n ${from}`).get(day, day, ...params).n;
  const rows = db.prepare(`SELECT ${cols} ${from} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(day, day, ...params, limit, offset);
  return { rows, total: Number(total) || 0 };
}
