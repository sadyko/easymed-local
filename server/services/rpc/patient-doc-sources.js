// PASTE_SOURCES_V1 (2026-11-02) — «ВСТАВИТЬ РЕЗУЛЬТАТЫ» КАБИНЕТА ВРАЧА: ВСЕ
// ДОКУМЕНТЫ ПАЦИЕНТА ОДНОЙ ВЫБОРКОЙ (rpc patient_doc_sources).
//
// Владелец (выпуск 3.21.0): вставить в документ приёма можно было только
// сводку «Осмотр / Диагноз / Рекомендации» ЗАВЕРШЁННЫХ строк, а строки
// раскладывались по регулярке имени вида услуги. На тестовой клинике вся
// диагностика и лаборатория попадали в «Услуги», где вставка выключена;
// анализы в 'resulted' (введены, не проверены) пропадали; архив документов
// (visit_documents), заключение визита (visits.conclusion) и документы
// стационара не читались вовсе.
//
// ЧТО ОТДАЁТ. Пять групп — вкладки окна (views/paste-sources.js):
//   consult   — протоколы приёма: подписанная запись строки (visit_services.notes,
//               то же правило, что у карты пациента, — lastSignedEntry) или её
//               копия в архиве (visit_documents 'protocol'; копия выигрывает, как
//               в карте); заключение визита — если у визита нет документа строки;
//   diag      — заключения диагностики (вид 'diag', строки imaging/radiology) с
//               «Измерениями» — показателями, внесёнными к исследованию;
//   labs      — анализы по визитам; 'resulted' — с пометкой unverified;
//   inpatient — опубликованные и не исправленные записи истории болезни;
//   files     — загруженные файлы: название и путь, содержимого нет.
// Раздел документа — { key, label, html }: ПОЛНЫЙ текст. Оформление врача —
// разметкой, очищенной общим санитайзером (shared/rich-text.js), простой текст —
// экранированным: «SpO2 <95%» не тег и не «&amp;lt;».
//
// РАСКЛАДКА — ПО services.type (CHECK миграций 022/023, пустым не бывает), не по
// имени вида услуги: справочник «Типы услуг» у клиник пуст или назван по-своему.
// Отдел услуги (departments.kind) — запасной путь, после типа.
//
// ПРАВА — КАК У КАРТЫ ПАЦИЕНТА (rpc/patient-card.js): раздел «Пациенты», вкладки
// «Документы» (протоколы, диагностика, файлы), «Лаборатория» (анализы), «История»
// (стационар) и реестр таблиц. Закрытая группа приходит null и названа в
// `closed`; закрыто всё — отказ, который называет вкладку.
//
// ЗДАНИЕ — КАК У КАРТЫ ПАЦИЕНТА (BRANCH_ORIGIN_V1): владелец просил результаты
// «из других документов пациента», а результаты анализов ездят между зданиями
// (lab_results). Поэтому анализы и показатели исследований, сделанные в
// соседнем здании, ОТДАЮТСЯ — с буквой филиала (`origin`, правило карты:
// метка результата, иначе метка строки), и окно подписывает их «Филиал X».
// Протоколы (visit_services.notes), архив документов и файлы между зданиями не
// ездят, заключение визита соседнего здания — тоже не наша запись: для них
// берутся только визиты и строки своего здания (sync_origin IS NULL).
//
// ТЕКУЩАЯ СТРОКА (exclude_visit_service_id) не возвращается: вставлять документ
// в самого себя незачем.
//
// РАЗМЕР ОГРАНИЧЕН: строк пациента — LINE_LIMIT, документов в группе — limit
// (40, не больше 100), раздел — SECTION_MAX знаков, весь ответ — BUDGET знаков
// разметки; обрезанная группа помечена в `truncated`. Изображения снимков
// диагностики (base64 в теле архива) не отдаются никогда.
//
// ТОЛЬКО ЧТЕНИЕ: ничего не пишет (READ_ONLY_RPCS в control/gate.js).
import { RpcError } from './crm-config.js';
import { patientCardAccess, fileOnThisMachine, DENIED_TEMPLATE, TAB_LABELS } from './patient-card.js';
import { canRead } from '../../db/schema-registry.js';
import { hasColumn } from '../domain/buildings.js';
import { richForSheet, notesDocData, lastSignedEntry } from '../../../public/js/shared/cabinet-doc.js';
import { hasMarkup, htmlToText, textIsBlank } from '../../../public/js/shared/rich-text.js';
import { loadCaseDocTitles, reviewSections } from './inpatient-reviews.js';   // PASTE_SOURCES_V1 — имена своих родов и свои разделы записи

/** Группы ответа — те же вкладки, что у окна (views/paste-sources.js PASTE_TABS). */
export const PASTE_GROUPS = Object.freeze(['consult', 'diag', 'labs', 'inpatient', 'files']);

/** Сколько последних строк пациента (копий архива, визитов с заключением) просматривается. */
const LINE_LIMIT = 300;
const DOC_LIMIT_DEFAULT = 40;
const DOC_LIMIT_MAX = 100;
/** Самый длинный раздел, знаков разметки: длиннее — текстом, с «…». */
export const SECTION_MAX = 20000;
/** Весь ответ, знаков разметки: дальше документы не добавляются (truncated). */
const BUDGET = 1500000;

const posInt = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
// Своё здание: строка заведена здесь. Колонки нет (база до 083) — все строки свои.
const ownWhere = (db, table, alias) => (hasColumn(db, table, 'sync_origin') ? ` AND ${alias}.sync_origin IS NULL` : '');

function escHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Простой текст → разметка: экранирование, строки — <br>. Длиннее предела — обрезка с «…». */
export function textHtml(v) {
  const t = String(v == null ? '' : v).replace(/\r\n?/g, '\n').trim();
  if (textIsBlank(t)) return '';
  const cut = t.length > SECTION_MAX ? t.slice(0, SECTION_MAX) + '…' : t;
  return escHtml(cut).replace(/\n/g, '<br>');
}

/**
 * Раздел записи → разметка вставки.
 * rich — значение может быть разметкой врача (запись кабинета, снимок с меткой
 * rich, документ стационара): через richForSheet оформление остаётся очищенной
 * разметкой, набранное без оформления — текстом. Не rich (снимок до
 * DOC_RICH_FORMAT_V1) — значение всегда текст: набранное «<b>» тегом не станет.
 */
export function sectionHtml(v, rich = true) {
  if (v == null || v === '') return '';
  if (!rich) return textHtml(v);
  const r = richForSheet(String(v));
  if (!r) return '';
  if (hasMarkup(r)) return r.length <= SECTION_MAX ? r : textHtml(htmlToText(r));
  return textHtml(r);
}

/** Рецепт — нумерованный список «название — доза, частота, длительность». */
function rxHtml(list) {
  const rows = (Array.isArray(list) ? list : []).filter((r) => r && typeof r === 'object' && String(r.name || '').trim());
  if (!rows.length) return '';
  return '<ol>' + rows.map((r) => {
    const tail = [r.dose, r.freq, r.dur, r.notes].map((x) => String(x == null ? '' : x).trim()).filter(Boolean).join(', ');
    return '<li><b>' + escHtml(String(r.name).trim()) + '</b>' + (tail ? ' — ' + escHtml(tail) : '') + '</li>';
  }).join('') + '</ol>';
}

function pushSection(out, key, label, html) { if (html) out.push({ key, label, html }); }

/** Разделы протокола приёма — снимок формы buildBlankData / notesDocData, порядок листа. */
export function protocolSections(b, rich) {
  const d = b || {};
  const out = [];
  pushSection(out, 'complaint', 'Жалобы', sectionHtml(d.complaint, rich));
  pushSection(out, 'hpi', 'Анамнез', sectionHtml(d.hpi, rich));
  pushSection(out, 'exam', 'Осмотр', sectionHtml(d.exam, rich));
  pushSection(out, 'labs', 'Лабораторные исследования', sectionHtml(d.labs, rich));
  pushSection(out, 'instrumental', 'Инструментальные исследования', sectionHtml(d.instrumental, rich));
  pushSection(out, 'dx', 'Диагноз', textHtml(d.dx || [d.dxAuto, d.dxText].filter(Boolean).join('\n')));
  pushSection(out, 'therapy', 'Терапия', sectionHtml(d.therapy, rich));
  pushSection(out, 'recs', 'Рекомендации', sectionHtml(d.recsText, rich));
  pushSection(out, 'conclusion', 'Заключение', sectionHtml(d.conclusionText, rich));
  pushSection(out, 'rx', 'Рецепт', rxHtml(d.prescriptions));
  return out;
}

/** Разделы заключения диагностики — снимок формы diagDocData (изображения не берутся). */
export function diagSections(b, rich) {
  const d = b || {};
  const out = [];
  pushSection(out, 'description', 'Описание', sectionHtml(d.description, rich));
  pushSection(out, 'conclusion', 'Заключение', textHtml(d.conclusion || [d.conclusionAuto, d.conclusionBody].filter(Boolean).join('\n')));
  pushSection(out, 'rx', 'Рецепт', rxHtml(d.prescriptions));
  return out;
}

/**
 * Вкладка строки. Сначала services.type (и is_lab — ему верит лаборатория),
 * потом отдел услуги: консультация, заведённая в отделе диагностики (ЭКГ),
 * — «Диагностика», как было у DEPT_KIND_ROUTING_V1.
 */
export function lineKind({ type = '', is_lab = 0, dept_kind = '' } = {}) {
  const t = String(type || '').toLowerCase();
  if (t === 'lab' || Number(is_lab) === 1) return 'labs';
  if (t === 'imaging' || t === 'radiology') return 'diag';
  if (dept_kind === 'diagnostics') return 'diag';
  if (dept_kind === 'laboratory') return 'labs';
  return 'consult';
}

// Поля, которые бывают только у приёма (savedDocType кабинета, CONSULT_ONLY_FIELDS).
const CONSULT_ONLY = Object.freeze(['chief_complaint', 'hpi', 'physical_exam', 'therapy_text', 'recommendations_text', 'conclusion_text']);
/** Подписанная запись — бланк «Диагностика»? Сохранённый тип, иначе — по строке и полям. */
function signedIsDiag(payload, fields, kind) {
  if (payload.docType === 'diag') return true;
  if (payload.docType === 'conclusion') return false;
  if (kind !== 'diag') return false;
  return !CONSULT_ONLY.some((k) => !textIsBlank(htmlToText(String(fields[k] == null ? '' : fields[k]))));
}

function parseBody(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'object') return raw;
  try { const v = JSON.parse(raw); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; }
}

/** Новые первыми; при равной дате — больший id первым (порядок стабилен). */
function byAtDesc(a, b) {
  const x = String(a.at || ''), y = String(b.at || '');
  if (x !== y) return x < y ? 1 : -1;
  const i = String(a.id), j = String(b.id);
  return i === j ? 0 : (i < j ? 1 : -1);
}

/** Сколько документ весит в ответе (знаки разметки и показателей). */
function docSize(doc) {
  let n = 200;
  for (const s of doc.sections || []) n += String(s.html || '').length + String(s.label || '').length;
  for (const p of doc.panels || []) {
    for (const r of p.rows || []) n += 60 + String(r.parameter || '').length + String(r.value || '').length + String(r.reference_range || '').length;
  }
  return n;
}

/**
 * Документы пациента для «Вставить результаты».
 * args: { patient_id, exclude_visit_service_id?, limit? }
 * → { patient_id, groups: { consult, diag, labs, inpatient, files } (закрытая — null), closed, truncated }
 */
export function patientDocSources(db, args, user) {
  const { roles, tabs } = patientCardAccess(db, user);
  const pid = posInt(args && args.patient_id);
  if (!pid) throw new RpcError('Не указан пациент.', 400);
  if (!db.prepare('SELECT 1 FROM patients WHERE id = ?').get(pid)) throw new RpcError('Пациент не найден.', 404);
  const exclude = posInt(args && args.exclude_visit_service_id);
  const limit = Math.min(posInt(args && args.limit) || DOC_LIMIT_DEFAULT, DOC_LIMIT_MAX);

  const lineRead = canRead('visits', roles) && canRead('visit_services', roles);
  const docsOpen = tabs.docs !== 'none';
  const open = {
    consult: docsOpen && lineRead,
    diag: docsOpen && lineRead,
    labs: tabs.labs !== 'none' && lineRead && canRead('lab_results', roles),
    inpatient: tabs.history !== 'none' && canRead('admission_reviews', roles),
    files: docsOpen && canRead('visit_documents', roles),
  };
  const closed = PASTE_GROUPS.filter((g) => !open[g]);
  if (closed.length === PASTE_GROUPS.length) {
    // Тот же отказ, что у вкладки карты: шаблон + название вкладки в params.
    const e = new RpcError(DENIED_TEMPLATE, 403);
    e.params = { tab: TAB_LABELS.docs };
    throw e;
  }

  const found = { consult: [], diag: [], labs: [], inpatient: [], files: [] };
  // Протоколы и заключения — только своего здания (записи кабинета между зданиями не ездят).
  if (open.consult) collectTextDocs(db, pid, loadLines(db, pid, { ownOnly: true }), exclude, canRead('visit_documents', roles), found);
  // Анализы и «Измерения» исследований — всех зданий, с буквой филиала (как в карте пациента).
  if (open.labs) collectLabs(db, loadLines(db, pid, { ownOnly: false }), exclude, found);
  if (open.inpatient) collectInpatient(db, pid, found);
  if (open.files) collectFiles(db, pid, found);

  const groups = {};
  const truncated = {};
  let budget = BUDGET;
  for (const g of PASTE_GROUPS) {
    if (!open[g]) { groups[g] = null; truncated[g] = false; continue; }
    const all = found[g].sort(byAtDesc);
    const kept = [];
    for (const doc of all) {
      if (kept.length >= limit) break;
      const size = docSize(doc);
      if (size > budget) break;
      budget -= size;
      kept.push(doc);
    }
    groups[g] = kept;
    truncated[g] = kept.length < all.length;
  }
  return { patient_id: pid, groups, closed, truncated };
}

/**
 * Строки визитов пациента (услуги, не товары), новые первыми.
 * ownOnly — только своего здания (протоколы); иначе — все здания, с буквой
 * филиала строки (vs_origin) для результатов анализов. notes читаются только
 * для своих строк: у приехавших их нет, а тело записи тяжёлое.
 */
function loadLines(db, pid, { ownOnly = true } = {}) {
  const vsOrigin = hasColumn(db, 'visit_services', 'sync_origin') ? 'vs.sync_origin' : 'NULL';
  const where = ownOnly ? ownWhere(db, 'visits', 'v') + ownWhere(db, 'visit_services', 'vs') : '';
  return db.prepare(`
    SELECT vs.id, vs.visit_id, vs.status, ${ownOnly ? 'vs.notes' : 'NULL AS notes'}, vs.verified_at, vs.created_at,
           ${vsOrigin} AS vs_origin,
           v.visit_date,
           COALESCE(s.name, '') AS name, COALESCE(s.type, '') AS type, COALESCE(s.is_lab, 0) AS is_lab,
           COALESCE(dp.kind, '') AS dept_kind,
           du.full_name AS doctor_name
      FROM visit_services vs
      JOIN visits v ON v.id = vs.visit_id
      LEFT JOIN services s ON s.id = vs.service_id
      LEFT JOIN departments dp ON dp.id = s.department_id
      LEFT JOIN users du ON du.id = vs.doctor_id
     WHERE v.patient_id = ? AND vs.clinic_item_id IS NULL${where}
     ORDER BY v.visit_date DESC, vs.id DESC
     LIMIT ?`).all(pid, LINE_LIMIT);
}

/** Протоколы и заключения: копии архива, подписанные записи строк, заключения визитов. */
function collectTextDocs(db, pid, lines, exclude, archiveRead, found) {
  const docVisits = new Set();       // визиты, у строк которых есть документ (и у текущей)
  const archivedLines = new Set();   // строки с копией в архиве — их запись не задваивается

  // 1. Архив: копия подписанного документа — то, что карта пациента печатает.
  if (archiveRead) {
    const rows = db.prepare(`
      SELECT d.id, d.visit_service_id, COALESCE(d.visit_id, vs.visit_id) AS visit_id, d.doc_type, d.title, d.body, d.created_at,
             u.full_name AS created_by_name,
             COALESCE(s.name, '') AS name, COALESCE(s.type, '') AS type, COALESCE(s.is_lab, 0) AS is_lab,
             COALESCE(dp.kind, '') AS dept_kind
        FROM visit_documents d
        LEFT JOIN users u ON u.id = d.created_by
        LEFT JOIN visit_services vs ON vs.id = d.visit_service_id
        LEFT JOIN services s ON s.id = vs.service_id
        LEFT JOIN departments dp ON dp.id = s.department_id
       WHERE d.patient_id = ? AND d.voided_at IS NULL AND d.doc_type IN ('protocol', 'diag')
       ORDER BY d.created_at DESC, d.id DESC
       LIMIT ?`).all(pid, LINE_LIMIT);
    const seen = new Set();
    for (const r of rows) {
      if (r.visit_service_id != null) archivedLines.add(r.visit_service_id);
      if (r.visit_id != null) docVisits.add(r.visit_id);
      if (exclude && r.visit_service_id === exclude) continue;
      // До V3120_FIX у строки могло остаться несколько копий одного вида — берётся новейшая.
      const key = (r.visit_service_id == null ? 'd' + r.id : 'l' + r.visit_service_id) + ':' + r.doc_type;
      if (seen.has(key)) continue;
      seen.add(key);
      const body = parseBody(r.body);
      if (!body) continue;
      const isDiag = r.doc_type === 'diag';
      const sections = isDiag ? diagSections(body, !!body.rich) : protocolSections(body, !!body.rich);
      if (!sections.length) continue;
      const tab = isDiag || lineKind(r) === 'diag' ? 'diag' : 'consult';
      found[tab].push({
        id: 'doc:' + r.id, kind: tab, source: 'archive',
        visit_service_id: r.visit_service_id == null ? null : r.visit_service_id,
        title: r.name || String(body.service || '') || String(r.title || ''),
        doctor: String(body.doctorName || '') || r.created_by_name || '',
        at: r.created_at, sections,
      });
    }
  }

  // 2. Подписанная запись строки без копии в архиве (WS_DERIVED_DOCS_V1 карты).
  for (const l of lines) {
    const got = lastSignedEntry(l.notes);
    if (!got) continue;
    docVisits.add(l.visit_id);
    if (archivedLines.has(l.id) || (exclude && l.id === exclude)) continue;
    const { entry, payload } = got;
    const fields = entry.fields && typeof entry.fields === 'object' ? entry.fields : {};
    const data = notesDocData(fields, {
      diagnoses: Array.isArray(payload.diagnoses) ? payload.diagnoses : [],
      prescriptions: Array.isArray(payload.prescriptions) ? payload.prescriptions : [],
    });
    const kind = lineKind(l);
    const isDiag = signedIsDiag(payload, fields, kind);
    const sections = isDiag
      ? diagSections({ description: data.instrumental, conclusion: data.dx, prescriptions: data.prescriptions }, true)
      : protocolSections(data, true);
    if (!sections.length) continue;
    const tab = isDiag || kind === 'diag' ? 'diag' : 'consult';
    found[tab].push({
      id: 'line:' + l.id, kind: tab, source: 'notes', visit_service_id: l.id,
      title: l.name, doctor: l.doctor_name || String(entry.byName || ''),
      at: entry.savedAt || l.created_at, sections,
    });
  }

  // 3. Заключение визита — только у визита без документов строк: кабинет пишет
  //    туда текст своего же «Заключения» (WS_CONCLUSION_V1), второй раз его не показываем.
  const visits = db.prepare(`
    SELECT v.id, v.visit_date, v.conclusion, v.conclusion_type, du.full_name AS doctor_name
      FROM visits v
      LEFT JOIN users du ON du.id = v.doctor_id
     WHERE v.patient_id = ? AND TRIM(COALESCE(v.conclusion, '')) <> ''${ownWhere(db, 'visits', 'v')}
     ORDER BY v.visit_date DESC, v.id DESC
     LIMIT ?`).all(pid, LINE_LIMIT);
  for (const v of visits) {
    if (docVisits.has(v.id)) continue;
    const html = textHtml(v.conclusion);
    if (!html) continue;
    const tab = v.conclusion_type === 'diagnostic' ? 'diag' : 'consult';
    found[tab].push({
      id: 'visit:' + v.id, kind: tab, source: 'visit', visit_service_id: null,
      title: 'Заключение визита', doctor: v.doctor_name || '',
      at: v.visit_date, sections: [{ key: 'conclusion', label: 'Заключение', html }],
    });
  }
}

/** Показателей у одного анализа — не больше (панель — не архив). */
const LAB_ROWS_MAX = 200;
const FLAGGED = new Set(['high', 'low', 'critical', 'abnormal']);

// BRANCH_ORIGIN_V1 — буква филиала или null (то же правило, что record-origin.js originTag).
const letterOf = (v) => {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
};

/**
 * Показатели строк. Повторный ввод того же показателя ЗАМЕНЯЕТ прежний, разные
 * показатели панели живут все — правило архива и панели истории болезни
 * (case-doc-sources.js). У показателя — буква филиала, откуда он приехал (origin).
 */
function latestResults(db, ids) {
  const by = new Map();
  if (!ids.length) return by;
  const lrOrigin = hasColumn(db, 'lab_results', 'sync_origin') ? 'sync_origin' : 'NULL';
  const rows = db.prepare(`
    SELECT id, visit_service_id, parameter, value, unit, reference_range, flag, ${lrOrigin} AS origin
      FROM lab_results
     WHERE visit_service_id IN (${ids.map(() => '?').join(',')})
     ORDER BY id`).all(...ids);
  const latest = new Map();
  for (const r of rows) latest.set(JSON.stringify([r.visit_service_id, String(r.parameter || '')]), r);
  for (const r of [...latest.values()].sort((x, y) => x.id - y.id)) {
    if (!by.has(r.visit_service_id)) by.set(r.visit_service_id, []);
    const list = by.get(r.visit_service_id);
    if (list.length < LAB_ROWS_MAX) list.push({
      parameter: String(r.parameter || ''), value: r.value == null ? '' : String(r.value),
      unit: String(r.unit || ''), reference_range: String(r.reference_range || ''), flag: String(r.flag || ''),
      origin: letterOf(r.origin),
    });
  }
  return by;
}

/** Таблица показателей для документа (подписи — бланк, по-русски); отклонение — жирным. */
export function resultsTableHtml(rows) {
  if (!rows || !rows.length) return '';
  const body = rows.map((r) => {
    const v = escHtml(r.value) + (r.unit ? ' ' + escHtml(r.unit) : '');
    return '<tr><td>' + escHtml(r.parameter) + '</td><td>' + (FLAGGED.has(String(r.flag).toLowerCase()) ? '<b>' + v + '</b>' : v)
      + '</td><td>' + escHtml(r.reference_range) + '</td></tr>';
  }).join('');
  return '<table class="a4-restbl"><thead><tr><th>Показатель</th><th>Результат</th><th>Норма</th></tr></thead><tbody>' + body + '</tbody></table>';
}

/**
 * Буква филиала анализа — правило карты пациента (BRANCH_ORIGIN_V1, views/patient-card.js:
 * originTag(lr) || originTag(vs)): метка показателя, иначе метка строки. Своё — null.
 */
function panelOrigin(line, rows) {
  const fromRow = rows.map((r) => r.origin).find(Boolean);
  return fromRow || letterOf(line.vs_origin) || null;
}

/**
 * Анализы — ДОКУМЕНТОМ НА ВИЗИТ (как «Результаты анализов» карты,
 * LAB_DOC_ONE_PER_VISIT_V1), панель — анализ. Введено, но не проверено
 * ('resulted' без verified_at) — в списке, с пометкой unverified: врач видит
 * результат и знает, что лаборатория его ещё не подтвердила. Показатели,
 * внесённые к исследованию (ЭхоКГ, УЗИ с размерами), — раздел «Измерения» его
 * заключения во вкладке «Диагностика».
 * Здание — как у карты пациента: анализ соседнего здания в списке, с буквой
 * филиала у панели (origin); у документа визита буква — когда она у всех его
 * панелей одна, иначе пометка только у панелей.
 */
function collectLabs(db, lines, exclude, found) {
  const pick = lines.filter((l) => l.status !== 'cancelled' && !(exclude && l.id === exclude) && lineKind(l) !== 'consult');
  const results = latestResults(db, pick.map((l) => l.id));
  const byVisit = new Map();
  for (const l of pick) {
    const rows = results.get(l.id);
    if (!rows || !rows.length) continue;
    const origin = panelOrigin(l, rows);
    const clean = rows.map(({ origin: _o, ...r }) => r);
    if (lineKind(l) === 'labs') {
      let doc = byVisit.get(l.visit_id);
      if (!doc) {
        doc = {
          id: 'labs:' + l.visit_id, kind: 'labs', source: 'lab', visit_id: l.visit_id, visit_service_id: null,
          title: 'Результаты анализов', doctor: '', at: l.visit_date, unverified: false, origin: null, panels: [],
        };
        byVisit.set(l.visit_id, doc);
        found.labs.push(doc);
      }
      const unverified = l.status !== 'completed' && !l.verified_at;
      doc.panels.push({ visit_service_id: l.id, title: l.name, unverified, origin, rows: clean });
      if (unverified) doc.unverified = true;
      continue;
    }
    const section = { key: 'measurements', label: 'Измерения', html: resultsTableHtml(clean) };
    const doc = found.diag.find((d) => d.visit_service_id === l.id);
    if (doc) doc.sections.push(section);
    else found.diag.push({
      id: 'line:' + l.id, kind: 'diag', source: 'lab', visit_service_id: l.id,
      title: l.name, doctor: l.doctor_name || '', at: l.verified_at || l.visit_date, origin, sections: [section],
    });
  }
  for (const doc of byVisit.values()) {
    doc.panels.sort((a, b) => a.visit_service_id - b.visit_service_id);
    const letters = new Set(doc.panels.map((p) => p.origin));
    doc.origin = letters.size === 1 ? doc.panels[0].origin : null;
  }
}

const REVIEW_KEYS = Object.freeze(['complaints', 'objective', 'diagnosis', 'plan', 'body']);
// Подписи разделов — те же, что у листа истории болезни (views/case-doc-a4.js LABEL / BODY_LABEL).
const REVIEW_LABEL = Object.freeze({
  complaints: 'Жалобы', objective: 'Объективно', diagnosis: 'Диагноз', plan: 'План обследования и лечения', body: 'Дополнительно',
});
const REVIEW_BODY_LABEL = Object.freeze({ operation: 'Протокол операции', consent: 'Текст документа', other: 'Текст документа', rationale: 'Обоснование' });

/**
 * Документы истории болезни пациента: ОПУБЛИКОВАННЫЕ и не исправленные
 * (superseded_by IS NULL — исправление закрывает прежнюю запись). Черновик —
 * не документ. Имя рода: у своего рода клиники — её название
 * (case_doc_types.title), у встроенного — пусто, его называет окно словарём
 * истории болезни (views/case-docs.js CASE_DOC_TITLE) на языке экрана.
 * Диагноз записи хранится простым текстом, остальные разделы — разметкой.
 */
function collectInpatient(db, pid, found) {
  const titles = loadCaseDocTitles(db);
  const rows = db.prepare(`
    SELECT r.id, r.kind, r.type_kind, r.complaints, r.objective, r.diagnosis, r.plan, r.body, r.sections_json,
           r.published_at, r.entry_date, u.full_name AS author_name, a.admission_no
      FROM admission_reviews r
      JOIN admissions a ON a.id = r.admission_id
      LEFT JOIN users u ON u.id = r.author_id
     WHERE a.patient_id = ? AND r.published_at IS NOT NULL AND r.superseded_by IS NULL
     ORDER BY COALESCE(r.entry_date, r.published_at) DESC, r.id DESC
     LIMIT ?`).all(pid, LINE_LIMIT);
  for (const r of rows) {
    const kind = r.type_kind || r.kind;
    const secs = reviewSections(r);
    const own = secs.titles && typeof secs.titles === 'object' ? secs.titles : {};
    const out = [];
    for (const key of REVIEW_KEYS) {
      const label = String(own[key] || (key === 'body' && REVIEW_BODY_LABEL[kind]) || REVIEW_LABEL[key]);
      pushSection(out, key, label, key === 'diagnosis' ? textHtml(r.diagnosis) : sectionHtml(r[key], true));
    }
    (Array.isArray(secs.extra) ? secs.extra : []).forEach((x, i) => {
      if (!x || typeof x !== 'object') return;
      pushSection(out, 'extra' + i, String(x.title || '').trim() || 'Раздел', sectionHtml(x.html, true));
    });
    if (!out.length) continue;
    found.inpatient.push({
      id: 'review:' + r.id, kind: 'inpatient', source: 'review', visit_service_id: null,
      doc_kind: kind, title: String(titles.get(kind) || ''), doctor: r.author_name || '',
      admission_no: r.admission_no || null, at: r.entry_date || r.published_at, sections: out,
    });
  }
}

/** Файлов в ответе — не больше (их содержимое не читается никогда). */
const FILE_LIMIT = 100;

/**
 * Загруженные файлы пациента: только название, путь и «лежит ли на этом
 * компьютере» (тем же правилом, что карта пациента, — fileOnThisMachine).
 * Отозванный документ не показывается. Вставлять нечего — окно его открывает.
 */
function collectFiles(db, pid, found) {
  const rows = db.prepare(`
    SELECT d.id, d.title, d.file_name, d.file_path, d.created_at, u.full_name AS created_by_name
      FROM visit_documents d
      LEFT JOIN users u ON u.id = d.created_by
     WHERE d.patient_id = ? AND d.voided_at IS NULL AND COALESCE(d.file_path, '') <> ''
     ORDER BY d.created_at DESC, d.id DESC
     LIMIT ?`).all(pid, FILE_LIMIT);
  for (const r of rows) {
    found.files.push({
      id: 'file:' + r.id, kind: 'files', source: 'file', document_id: r.id, visit_service_id: null,
      title: r.title || r.file_name || '', file_name: r.file_name || '', file_path: r.file_path,
      file_available: fileOnThisMachine(r.file_path), doctor: r.created_by_name || '', at: r.created_at,
    });
  }
}
