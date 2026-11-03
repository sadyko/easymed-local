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
// ОТОЗВАННЫЙ ДОКУМЕНТ (ревью H1, 2026-11-03). «Отозвать документ» в карте —
// «он останется в карте, но перестанет открываться». Строка с ЛЮБОЙ копией в
// архиве (живой или отозванной) — документ архива, её запись (notes) документом
// не выводится: то же правило, что у карты (views/patient-card.js paintList —
// archived = копии с этой строкой, отозванные тоже). И визит такой строки
// «с документом»: его visits.conclusion пишет та же подпись (WS_CONCLUSION_V1),
// и отозванный текст не возвращается «Заключением визита».
//
// РАСКЛАДКА — ПО services.type (CHECK миграций 022/023, пустым не бывает), не по
// имени вида услуги: справочник «Типы услуг» у клиник пуст или назван по-своему.
// Отдел услуги (departments.kind) — запасной путь, после типа.
//
// ПРАВА — КАК У КАРТЫ ПАЦИЕНТА (rpc/patient-card.js): раздел «Пациенты», вкладки
// «Документы» (протоколы, диагностика, файлы), «Лаборатория» (анализы), «История»
// (стационар) и реестр таблиц. Закрытая группа приходит null и названа в
// `closed`; закрыто всё — отказ, который называет вкладку.
// Ревью M3 (решение по умолчанию, владельцу сообщается): роль клиники с кабинетом
// врача, но без «Пациентов» (свой «Врач-УЗИ»), прежним окном читала строки через
// /api/db. Ей окно открывается по ТЕКУЩЕЙ строке кабинета (exclude_visit_service_id):
// строка назначена этому врачу — тот же отбор, что у «Мои услуги», откуда кабинет
// её открывает, — и только для пациента ЭТОЙ строки (cabinetLineAccess).
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
// РАЗМЕР ОГРАНИЧЕН (ревью M1, M2, L7). У каждого источника — свой предел, и
// упёршийся в предел источник помечает СВОЮ группу в `truncated`: строки анализов
// не вытесняют приёмы, протоколы — заключения диагностики. Тела (notes, копии
// архива, записи стационара) читаются только у тех документов, которые уйдут в
// ответ: сначала лёгкий список (без тел), новейшие первыми, потом тело — по
// одному, пока группе нужно (limit — 40, не больше 100). Строки с копией в
// архиве своей записи не разбирают вовсе. Раздел — SECTION_MAX знаков
// (сокращённый помечен cut — окно об этом говорит); весь ответ — BUDGET знаков,
// у каждой группы своя доля (fitGroups). Изображения снимков диагностики
// (base64 в теле архива) не отдаются никогда.
//
// ТОЛЬКО ЧТЕНИЕ: ничего не пишет (READ_ONLY_RPCS в control/gate.js).
import { RpcError } from './crm-config.js';
import { patientCardAccess, fileOnThisMachine, DENIED_TEMPLATE, TAB_LABELS } from './patient-card.js';
import { effectiveRoles, canViewSection, PATIENT_CARD_TABS, patientTabLevel } from '../roles.js';
import { canRead } from '../../db/schema-registry.js';
import { hasColumn } from '../domain/buildings.js';
import { richForSheet, notesDocData, lastSignedEntry } from '../../../public/js/shared/cabinet-doc.js';
import { hasMarkup, htmlToText, textIsBlank } from '../../../public/js/shared/rich-text.js';
import { loadCaseDocTitles, reviewSections } from './inpatient-reviews.js';   // PASTE_SOURCES_V1 — имена своих родов и свои разделы записи
import { serviceRoute } from '../../../public/js/shared/service-route.js';   // DIAG_ROUTE_V1 — анализ ли строка, решает группа

/** Группы ответа — те же вкладки, что у окна (views/paste-sources.js PASTE_TABS). */
export const PASTE_GROUPS = Object.freeze(['consult', 'diag', 'labs', 'inpatient', 'files']);

const DOC_LIMIT_DEFAULT = 40;
const DOC_LIMIT_MAX = 100;
/** Подписанных записей строк без копии в архиве, разбираемых на группу (их notes тяжёлые). */
const NOTES_LIMIT = 300;
/** Предохранитель лёгких списков (без тел): строк, копий, визитов одного пациента. */
const SCAN_LIMIT = 5000;
/** Самый длинный раздел, знаков разметки: длиннее — текстом, с «…» (cut). */
export const SECTION_MAX = 20000;
/** Весь ответ, знаков разметки: у каждой группы своя доля (fitGroups). */
const BUDGET = 1500000;
/** Сколько id в одном IN (…). */
const IN_CHUNK = 500;

const posInt = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
// Своё здание: строка заведена здесь. Колонки нет (база до 083) — все строки свои.
const ownWhere = (db, table, alias) => (hasColumn(db, table, 'sync_origin') ? ` AND ${alias}.sync_origin IS NULL` : '');

function escHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const NO_PART = Object.freeze({ html: '', cut: false });

// PASTE_SOURCES_V1 (ревью L1) — раздел и пометка «сокращён пределом»: окно
// говорит врачу, что полный текст (и оформление) — в карте пациента.
function textPart(v) {
  const t = String(v == null ? '' : v).replace(/\r\n?/g, '\n').trim();
  if (textIsBlank(t)) return NO_PART;
  const cut = t.length > SECTION_MAX;
  return { html: escHtml(cut ? t.slice(0, SECTION_MAX) + '…' : t).replace(/\n/g, '<br>'), cut };
}

function sectionPart(v, rich = true) {
  if (v == null || v === '') return NO_PART;
  if (!rich) return textPart(v);
  const r = richForSheet(String(v));
  if (!r) return NO_PART;
  if (hasMarkup(r)) return r.length <= SECTION_MAX ? { html: r, cut: false } : { html: textPart(htmlToText(r)).html, cut: true };
  return textPart(r);
}

/** Простой текст → разметка: экранирование, строки — <br>. Длиннее предела — обрезка с «…». */
export function textHtml(v) { return textPart(v).html; }

/**
 * Раздел записи → разметка вставки.
 * rich — значение может быть разметкой врача (запись кабинета, снимок с меткой
 * rich, документ стационара): через richForSheet оформление остаётся очищенной
 * разметкой, набранное без оформления — текстом. Не rich (снимок до
 * DOC_RICH_FORMAT_V1) — значение всегда текст: набранное «<b>» тегом не станет.
 */
export function sectionHtml(v, rich = true) { return sectionPart(v, rich).html; }

/** Рецепт — нумерованный список «название — доза, частота, длительность». */
function rxHtml(list) {
  const rows = (Array.isArray(list) ? list : []).filter((r) => r && typeof r === 'object' && String(r.name || '').trim());
  if (!rows.length) return NO_PART;
  return { html: '<ol>' + rows.map((r) => {
    const tail = [r.dose, r.freq, r.dur, r.notes].map((x) => String(x == null ? '' : x).trim()).filter(Boolean).join(', ');
    return '<li><b>' + escHtml(String(r.name).trim()) + '</b>' + (tail ? ' — ' + escHtml(tail) : '') + '</li>';
  }).join('') + '</ol>', cut: false };
}

function pushSection(out, key, label, part) {
  if (part && part.html) out.push(part.cut ? { key, label, html: part.html, cut: true } : { key, label, html: part.html });
}

/** Разделы протокола приёма — снимок формы buildBlankData / notesDocData, порядок листа. */
export function protocolSections(b, rich) {
  const d = b || {};
  const out = [];
  pushSection(out, 'complaint', 'Жалобы', sectionPart(d.complaint, rich));
  pushSection(out, 'hpi', 'Анамнез', sectionPart(d.hpi, rich));
  pushSection(out, 'exam', 'Осмотр', sectionPart(d.exam, rich));
  pushSection(out, 'labs', 'Лабораторные исследования', sectionPart(d.labs, rich));
  pushSection(out, 'instrumental', 'Инструментальные исследования', sectionPart(d.instrumental, rich));
  pushSection(out, 'dx', 'Диагноз', textPart(d.dx || [d.dxAuto, d.dxText].filter(Boolean).join('\n')));
  pushSection(out, 'therapy', 'Терапия', sectionPart(d.therapy, rich));
  pushSection(out, 'recs', 'Рекомендации', sectionPart(d.recsText, rich));
  pushSection(out, 'conclusion', 'Заключение', sectionPart(d.conclusionText, rich));
  pushSection(out, 'rx', 'Рецепт', rxHtml(d.prescriptions));
  return out;
}

/** Разделы заключения диагностики — снимок формы diagDocData (изображения не берутся). */
export function diagSections(b, rich) {
  const d = b || {};
  const out = [];
  pushSection(out, 'description', 'Описание', sectionPart(d.description, rich));
  pushSection(out, 'conclusion', 'Заключение', textPart(d.conclusion || [d.conclusionAuto, d.conclusionBody].filter(Boolean).join('\n')));
  pushSection(out, 'rx', 'Рецепт', rxHtml(d.prescriptions));
  return out;
}

/**
 * Вкладка строки. Сначала services.type (и is_lab — ему верит лаборатория),
 * потом отдел услуги: консультация, заведённая в отделе диагностики (ЭКГ),
 * — «Диагностика», как было у DEPT_KIND_ROUTING_V1.
 * DIAG_ROUTE_V1 — анализ ли это, решает ГРУППА (shared/service-route.js, то же
 * правило, что у очереди лаборатории): отделение-лаборатория делает строку
 * анализом только у услуги без группы. Отдел диагностики по-прежнему разводит
 * бланк приёма и бланк диагностики внутри кабинета — маршрута он не меняет.
 */
export function lineKind({ type = '', is_lab = 0, dept_kind = '' } = {}) {
  if (serviceRoute({ type, is_lab: Number(is_lab), dept_kind }) === 'lab') return 'labs';
  const t = String(type || '').toLowerCase();
  if (t === 'imaging' || t === 'radiology') return 'diag';
  if (dept_kind === 'diagnostics') return 'diag';
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
 * PASTE_SOURCES_V1 (ревью M2) — ДОЛИ ОТВЕТА ПО ГРУППАМ. Раньше один бюджет
 * тратился группами по порядку и обрывался на первом документе, который не
 * влез: 39 длинных годовалых приёмов съедали его, и сегодняшнее УЗИ, анализы,
 * стационар и файлы приходили пустыми. Теперь — справедливая доля: группа,
 * которой нужно меньше равной доли, берёт своё; остаток поровну делят большие.
 * Внутри группы — новейшие первыми; документ, который не влез, пропускается
 * (следующий, поменьше, может влезть), а не обрывает группу.
 * PASTE_SOURCES_V1 (полировка 3.21.0, п. 14; ревью R-L3) — ВТОРОЙ ПРОХОД: то, что
 * доли не истратили (бюджет − взятое), получают пропущенные документы, новые первыми
 * по всем группам (times — их `at`; без них — порядок групп и документов). Документ,
 * который влезает в ответ целиком, больше не выпадает только потому, что он больше
 * доли своей группы (М2f: два документа по 1 М при бюджете 1,5 М — прежде ни одного).
 * @param {Record<string, number[]>} sizes размеры документов группы, новые первыми
 * @param {number} budget
 * @param {Record<string, Array<string|null>>} [times] время документов группы (для второго прохода)
 * @returns {Record<string, boolean[]>} кто остаётся в ответе
 */
export function fitGroups(sizes, budget, times = null) {
  const keys = Object.keys(sizes);
  const need = Object.fromEntries(keys.map((k) => [k, sizes[k].reduce((a, b) => a + b, 0)]));
  const share = Object.fromEntries(keys.map((k) => [k, 0]));
  let left = budget;
  let pending = keys.filter((k) => need[k] > 0);
  while (pending.length) {
    const fair = left / pending.length;
    const small = pending.filter((k) => need[k] <= fair);
    if (!small.length) { for (const k of pending) share[k] = fair; break; }
    for (const k of small) { share[k] = need[k]; left -= need[k]; }
    pending = pending.filter((k) => !small.includes(k));
  }
  const out = {};
  let used = 0;
  for (const k of keys) {
    let room = share[k];
    out[k] = sizes[k].map((n) => { if (n <= room) { room -= n; used += n; return true; } return false; });
  }
  // Полировка, п. 14 — второй проход (см. выше): остаток бюджета — пропущенным, новые первыми.
  let rest = budget - used;
  const skipped = [];
  keys.forEach((k, gi) => sizes[k].forEach((n, i) => {
    if (!out[k][i]) skipped.push({ k, i, n, gi, at: times && times[k] ? String(times[k][i] || '') : '' });
  }));
  skipped.sort((a, b) => (a.at !== b.at ? (a.at < b.at ? 1 : -1) : (a.gi - b.gi) || (a.i - b.i)));
  for (const s of skipped) {
    if (s.n <= rest) { out[s.k][s.i] = true; rest -= s.n; }
  }
  return out;
}

// ---------------------------------------------------------------------------
// ПРАВА.
// ---------------------------------------------------------------------------
const CABINET_SECTION = 'consultation';

/**
 * PASTE_SOURCES_V1 (ревью M3) — окно вставки по ТЕКУЩЕЙ строке кабинета.
 * Роль с кабинетом врача, но без раздела «Пациенты», видит документы пациента
 * той строки, которую кабинет ей открывает. PASTE_SOURCES_V1 (полировка 3.21.0,
 * п. 12; ревью R-L1) — что именно пускает:
 *   • строка — не товар, своего здания (vs.sync_origin пуст), не отменена, не снята
 *     и не возвращена (status 'cancelled' / 'removed' / 'refunded' и отметка возврата
 *     pay_refund_releases 'out' у строки без счёта — K5);
 *   • визит строки — своего здания (v.sync_origin пуст), не отменён и не «не пришёл»;
 *   • строка назначена этому человеку (у администратора — любая с исполнителем).
 * Лабораторные и процедурные строки самого человека пускаются тоже: это НЕ ровно
 * отбор «Мои услуги» (views/consultation.js loadServices), а его границы по зданию,
 * отмене и исполнителю — данных шире, чем роль и так читает, окно не открывает.
 * Пациент запроса — пациент строки; иначе null. Уровни вкладок и реестр таблиц — те
 * же, что у карты.
 */
const LINE_GONE = ['cancelled', 'removed', 'refunded'];   // PASTE_SOURCES_V1 (полировка, п. 12)
function cabinetLineAccess(db, user, pid, vsId) {
  if (!pid || !vsId || !user) return null;
  if (!canViewSection(db, user, CABINET_SECTION)) return null;
  const roles = effectiveRoles(user);
  if (!canRead('patients', roles)) return null;
  const vsOrigin = hasColumn(db, 'visit_services', 'sync_origin') ? 'vs.sync_origin' : 'NULL';
  const vOrigin = hasColumn(db, 'visits', 'sync_origin') ? 'v.sync_origin' : 'NULL';   // полировка, п. 12
  const refunded = hasColumn(db, 'pay_refund_releases', 'line_id')
    ? `(vs.invoice_item_id IS NULL AND EXISTS (SELECT 1 FROM pay_refund_releases prr WHERE prr.kind = 'out' AND prr.line_id = vs.id))`
    : '0';
  const line = db.prepare(`SELECT vs.doctor_id, vs.status, vs.clinic_item_id, ${vsOrigin} AS vs_origin, v.patient_id,
         v.status AS visit_status, ${vOrigin} AS v_origin, ${refunded} AS refunded
      FROM visit_services vs JOIN visits v ON v.id = vs.visit_id WHERE vs.id = ?`).get(vsId);
  if (!line || Number(line.patient_id) !== pid || LINE_GONE.includes(line.status) || line.clinic_item_id != null || line.vs_origin != null) return null;
  // PASTE_SOURCES_V1 (полировка, п. 12) — визит отменён / «не пришёл» / другого здания; строка возвращена.
  if (line.visit_status === 'cancelled' || line.visit_status === 'no_show' || line.v_origin != null || Number(line.refunded) === 1) return null;
  const me = posInt(user.id);
  const assigned = line.doctor_id != null && Number(line.doctor_id) === me;
  if (!assigned && !(roles.includes('admin') && line.doctor_id != null)) return null;
  const tabs = {};
  for (const t of PATIENT_CARD_TABS) tabs[t] = patientTabLevel(db, user, t);
  return { roles, tabs };
}

/** Права карты; нет раздела «Пациенты» — текущая строка кабинета (ревью M3); иначе — прежний отказ. */
function docSourcesAccess(db, user, pid, currentLine) {
  try {
    return patientCardAccess(db, user);
  } catch (e) {
    if (!(e instanceof RpcError) || e.status !== 403) throw e;
    const via = cabinetLineAccess(db, user, pid, currentLine);
    if (!via) throw e;
    return via;
  }
}

/**
 * Документы пациента для «Вставить результаты».
 * args: { patient_id, exclude_visit_service_id? (текущая строка кабинета), limit? }
 * → { patient_id, groups: { consult, diag, labs, inpatient, files } (закрытая — null), closed, truncated }
 */
export function patientDocSources(db, args, user) {
  const pid = posInt(args && args.patient_id);
  const exclude = posInt(args && args.exclude_visit_service_id);
  const { roles, tabs } = docSourcesAccess(db, user, pid, exclude);
  if (!pid) throw new RpcError('Не указан пациент.', 400);
  if (!db.prepare('SELECT 1 FROM patients WHERE id = ?').get(pid)) throw new RpcError('Пациент не найден.', 404);
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

  // c.cut[g] — источник группы упёрся в свой предел: документов у пациента больше.
  const c = {
    db, pid, exclude, limit,
    found: { consult: [], diag: [], labs: [], inpatient: [], files: [] },
    cut: { consult: false, diag: false, labs: false, inpatient: false, files: false },
    cutLines: new Set(),   // строки, чей текстовый документ не взят пределом: их «Измерения» отдельным документом не всплывают
  };
  // Протоколы и заключения — только своего здания (записи кабинета между зданиями не ездят).
  if (open.consult) collectTextDocs(c, canRead('visit_documents', roles));
  // Анализы и «Измерения» исследований — всех зданий, с буквой филиала (как в карте пациента).
  if (open.labs) collectLabs(c);
  if (open.inpatient) collectInpatient(c);
  if (open.files) collectFiles(c);

  const groups = {};
  const truncated = {};
  const picked = {};
  for (const g of PASTE_GROUPS) {
    if (!open[g]) continue;
    const all = c.found[g].sort(byAtDesc);
    picked[g] = all.slice(0, limit);
    truncated[g] = c.cut[g] || all.length > limit;
  }
  const keep = fitGroups(Object.fromEntries(Object.entries(picked).map(([g, list]) => [g, list.map(docSize)])), BUDGET,
    Object.fromEntries(Object.entries(picked).map(([g, list]) => [g, list.map((d) => d.at || null)])));   // полировка, п. 14 — время для второго прохода
  for (const g of PASTE_GROUPS) {
    if (!open[g]) { groups[g] = null; truncated[g] = false; continue; }
    groups[g] = picked[g].filter((_, i) => keep[g][i]);
    if (groups[g].length < picked[g].length) truncated[g] = true;
  }
  return { patient_id: pid, groups, closed, truncated };
}

// Колонки услуги строки — для lineKind (вкладка) и названия документа.
const SERVICE_COLS = `COALESCE(s.name, '') AS name, COALESCE(s.type, '') AS type, COALESCE(s.is_lab, 0) AS is_lab,
           COALESCE(dp.kind, '') AS dept_kind`;

/** Предел лёгкого списка: лишняя строка выборки (LIMIT n + 1) говорит «есть ещё». */
function capRows(rows, n) {
  if (rows.length <= n) return { rows, more: false };
  return { rows: rows.slice(0, n), more: true };
}

// Ревью L7 — ТЯЖЁЛЫЙ ТЕКСТ (notes строки, тело копии архива) читается байтами и
// переводится в строку здесь: длинный текст с кириллицей better-sqlite3 отдаёт
// строкой JS в 2–3 раза дольше, чем Buffer.toString (замер: 27 МБ записей —
// 220 мс против 60). Байты — UTF-8 базы; у базы в другой кодировке — обычное чтение.
const UTF8_DB = new WeakMap();
function dbIsUtf8(db) {
  if (!UTF8_DB.has(db)) {
    let enc = '';
    try { enc = String(db.pragma('encoding', { simple: true }) || ''); } catch { enc = ''; }
    UTF8_DB.set(db, enc.toUpperCase() === 'UTF-8');
  }
  return UTF8_DB.get(db);
}
/** Читатель одного текстового поля по id: (id) → строка или null. */
function textReader(db, table, col) {
  const st = db.prepare(`SELECT ${dbIsUtf8(db) ? `CAST(${col} AS BLOB)` : col} AS v FROM ${table} WHERE id = ?`);
  return (id) => {
    const r = st.get(id);
    const v = r ? r.v : null;
    if (v == null) return null;
    return Buffer.isBuffer(v) ? v.toString('utf8') : String(v);
  };
}
// Есть ли подстрока в тексте — побайтно (instr над текстом считает символы и в 2 раза медленнее).
const hasText = (expr, needle) => `instr(CAST(${expr} AS BLOB), CAST('${needle}' AS BLOB)) > 0`;

/** Протоколы и заключения: копии архива, подписанные записи строк, заключения визитов. */
function collectTextDocs(c, archiveRead) {
  const { db, pid, exclude, limit, found } = c;
  const docVisits = new Set();       // визиты, у строк которых есть документ (и у текущей)
  const archivedLines = new Set();   // строки с копией в архиве — их запись не выводится

  // 0. Ревью H1 — ВСЕ копии протоколов и заключений пациента, отозванные тоже:
  //    строка с копией — документ архива (правило карты, views/patient-card.js
  //    paintList), а её визит — «с документом». Список лёгкий, без тел; права на
  //    чтение архива ему не нужны — наружу он не уходит, только прячет.
  for (const r of db.prepare(`
      SELECT d.visit_service_id, COALESCE(d.visit_id, vs.visit_id) AS visit_id
        FROM visit_documents d
        LEFT JOIN visit_services vs ON vs.id = d.visit_service_id
       WHERE d.patient_id = ? AND d.doc_type IN ('protocol', 'diag')`).all(pid)) {
    if (r.visit_service_id != null) archivedLines.add(r.visit_service_id);
    if (r.visit_id != null) docVisits.add(r.visit_id);
  }

  // 1. Архив: ЖИВАЯ копия подписанного документа — то, что карта пациента печатает.
  //    Сначала лёгкий список (новые первыми), тело — по одному, пока вкладке нужно (ревью M1, L7).
  if (archiveRead) {
    const { rows, more } = capRows(db.prepare(`
      SELECT d.id, d.visit_service_id, COALESCE(d.visit_id, vs.visit_id) AS visit_id, d.doc_type, d.title, d.created_at,
             u.full_name AS created_by_name, v.visit_date,
             ${SERVICE_COLS}
        FROM visit_documents d
        LEFT JOIN users u ON u.id = d.created_by
        LEFT JOIN visit_services vs ON vs.id = d.visit_service_id
        LEFT JOIN visits v ON v.id = COALESCE(d.visit_id, vs.visit_id)
        LEFT JOIN services s ON s.id = vs.service_id
        LEFT JOIN departments dp ON dp.id = s.department_id
       WHERE d.patient_id = ? AND d.voided_at IS NULL AND d.doc_type IN ('protocol', 'diag')
       ORDER BY d.created_at DESC, d.id DESC
       LIMIT ?`).all(pid, SCAN_LIMIT + 1), SCAN_LIMIT);
    if (more) { c.cut.consult = true; c.cut.diag = true; }
    const bodyOf = textReader(db, 'visit_documents', 'body');
    const made = { consult: 0, diag: 0 };
    const seen = new Set();
    for (const r of rows) {
      if (exclude && r.visit_service_id === exclude) continue;
      // До V3120_FIX у строки могло остаться несколько копий одного вида — берётся новейшая.
      const key = (r.visit_service_id == null ? 'd' + r.id : 'l' + r.visit_service_id) + ':' + r.doc_type;
      if (seen.has(key)) continue;
      seen.add(key);
      const isDiag = r.doc_type === 'diag';
      const tab = isDiag || lineKind(r) === 'diag' ? 'diag' : 'consult';
      if (made[tab] >= limit) {
        c.cut[tab] = true;
        if (r.visit_service_id != null) c.cutLines.add(r.visit_service_id);
        continue;
      }
      const body = parseBody(bodyOf(r.id));
      if (!body) continue;
      const sections = isDiag ? diagSections(body, !!body.rich) : protocolSections(body, !!body.rich);
      if (!sections.length) continue;
      made[tab] += 1;
      found[tab].push({
        id: 'doc:' + r.id, kind: tab, source: 'archive',
        visit_service_id: r.visit_service_id == null ? null : r.visit_service_id,
        title: r.name || String(body.service || '') || String(r.title || ''),
        doctor: String(body.doctorName || '') || r.created_by_name || '',
        at: r.created_at, origin: null,
        // Ревью L5 — день заголовка вставки: день, напечатанный на копии (PRINT_VISIT_DATE_V1), иначе — по визиту.
        visit_date: r.visit_date || null,
        issue_date: typeof body.issueDate === 'string' && body.issueDate ? body.issueDate : null,
        sections,
      });
    }
  }

  // 2. Подписанная запись строки без копии в архиве (WS_DERIVED_DOCS_V1 карты).
  //    Ревью L7 — строки с копией в архиве и строки без подписи (instr) notes не
  //    читают вовсе; ревью M1 — у приёмов и исследований свой предел записей
  //    (раскладка — lineKind и сохранённый тип бланка, его видно и без разбора).
  const { rows: signedRows, more: signedMore } = capRows(db.prepare(`
    SELECT vs.id, vs.visit_id, vs.created_at, v.visit_date,
           ${SERVICE_COLS},
           du.full_name AS doctor_name,
           ${hasText('vs.notes', '"docType":"diag"')} AS diag_hint
      FROM visit_services vs
      JOIN visits v ON v.id = vs.visit_id
      LEFT JOIN services s ON s.id = vs.service_id
      LEFT JOIN departments dp ON dp.id = s.department_id
      LEFT JOIN users du ON du.id = vs.doctor_id
     WHERE v.patient_id = ? AND vs.clinic_item_id IS NULL AND ${hasText('vs.notes', '"signed"')}
           ${ownWhere(db, 'visits', 'v')}${ownWhere(db, 'visit_services', 'vs')}
     ORDER BY v.visit_date DESC, vs.id DESC
     LIMIT ?`).all(pid, SCAN_LIMIT + 1), SCAN_LIMIT);
  if (signedMore) { c.cut.consult = true; c.cut.diag = true; }
  const notesOf = textReader(db, 'visit_services', 'notes');
  // Полировка, п. 13 — подпись диагностики в любом виде JSON (оба слова есть): спрашивается только у
  // строк за пределом и только пока «Диагностика» не помечена — обычному пациенту не стоит ничего.
  const diagMaybe = db.prepare(`SELECT (${hasText('notes', '"docType"')} AND ${hasText('notes', '"diag"')}) AS m FROM visit_services WHERE id = ?`);
  const parsed = { consult: 0, diag: 0 };
  for (const l of signedRows) {
    // PASTE_SOURCES_V1 (полировка, п. 15; ревью N2) — визит «с документом» — только по строке,
    // у которой и правда есть подписанная версия: черновик, где значение поля — «signed», или
    // заметка с этим словом в кавычках «Заключение визита» больше не прячут. Строки с копией
    // в архиве (визит уже отмечен выше), текущая и не разобранные из-за предела — как прежде.
    if (archivedLines.has(l.id) || (exclude && l.id === exclude)) { docVisits.add(l.visit_id); continue; }
    const kind = lineKind(l);
    const part = kind === 'diag' || l.diag_hint ? 'diag' : 'consult';
    if (parsed[part] >= NOTES_LIMIT) {
      c.cut[part] = true; c.cutLines.add(l.id); docVisits.add(l.visit_id);
      // PASTE_SOURCES_V1 (полировка, п. 13; ревью R-L2) — строка не диагностики, не разобранная из-за
      // предела, может нести подпись бланка диагностики (подсказка "docType":"diag" ищет только
      // плотный JSON; "docType": "diag" с пробелом она не видит): «Диагностика» тоже помечается
      // сокращённой, а не молча «пустой». Только у строки, где оба слова есть ("docType" и "diag"):
      // обычные приёмы за пределом «Диагностику» сокращённой не делают.
      if (kind !== 'diag' && !c.cut.diag) { const r = diagMaybe.get(l.id); if (r && Number(r.m) === 1) c.cut.diag = true; }
      continue;
    }
    parsed[part] += 1;
    const got = lastSignedEntry(notesOf(l.id));
    if (!got) continue;
    docVisits.add(l.visit_id);   // полировка, п. 15
    const { entry, payload } = got;
    const fields = entry.fields && typeof entry.fields === 'object' ? entry.fields : {};
    const data = notesDocData(fields, {
      diagnoses: Array.isArray(payload.diagnoses) ? payload.diagnoses : [],
      prescriptions: Array.isArray(payload.prescriptions) ? payload.prescriptions : [],
    });
    const isDiag = signedIsDiag(payload, fields, kind);
    const sections = isDiag
      ? diagSections({ description: data.instrumental, conclusion: data.dx, prescriptions: data.prescriptions }, true)
      : protocolSections(data, true);
    if (!sections.length) continue;
    const tab = isDiag || kind === 'diag' ? 'diag' : 'consult';
    // Ревью L5 — день документа: день визита, но не позже ПЕРВОЙ подписи (docDayText окна).
    const firstSigned = payload.history.find((e) => e && typeof e === 'object' && e.kind === 'signed' && e.savedAt);
    found[tab].push({
      id: 'line:' + l.id, kind: tab, source: 'notes', visit_service_id: l.id,
      title: l.name, doctor: l.doctor_name || String(entry.byName || ''),
      at: entry.savedAt || l.created_at, origin: null,
      visit_date: l.visit_date || null, first_signed_at: firstSigned ? String(firstSigned.savedAt) : null,
      sections,
    });
  }

  // 3. Заключение визита — только у визита без документов строк: кабинет пишет
  //    туда текст своего же «Заключения» (WS_CONCLUSION_V1), второй раз его не показываем.
  //    Текст читается только у тех, кто уйдёт в ответ.
  const { rows: visits, more: visitsMore } = capRows(db.prepare(`
    SELECT v.id, v.visit_date, v.conclusion_type, du.full_name AS doctor_name
      FROM visits v
      LEFT JOIN users du ON du.id = v.doctor_id
     WHERE v.patient_id = ? AND TRIM(COALESCE(v.conclusion, '')) <> ''${ownWhere(db, 'visits', 'v')}
     ORDER BY v.visit_date DESC, v.id DESC
     LIMIT ?`).all(pid, SCAN_LIMIT + 1), SCAN_LIMIT);
  if (visitsMore) { c.cut.consult = true; c.cut.diag = true; }
  const conclusionOf = textReader(db, 'visits', 'conclusion');
  const madeVisit = { consult: 0, diag: 0 };
  for (const v of visits) {
    if (docVisits.has(v.id)) continue;
    const tab = v.conclusion_type === 'diagnostic' ? 'diag' : 'consult';
    if (madeVisit[tab] >= limit) { c.cut[tab] = true; continue; }
    const part = textPart(conclusionOf(v.id));
    if (!part.html) continue;
    madeVisit[tab] += 1;
    const sections = [];
    pushSection(sections, 'conclusion', 'Заключение', part);
    found[tab].push({
      id: 'visit:' + v.id, kind: tab, source: 'visit', visit_service_id: null,
      title: 'Заключение визита', doctor: v.doctor_name || '',
      at: v.visit_date, origin: null, sections,
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
  const rows = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const part = ids.slice(i, i + IN_CHUNK);
    rows.push(...db.prepare(`
      SELECT id, visit_service_id, parameter, value, unit, reference_range, flag, ${lrOrigin} AS origin
        FROM lab_results
       WHERE visit_service_id IN (${part.map(() => '?').join(',')})`).all(...part));
  }
  rows.sort((x, y) => x.id - y.id);
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
 * заключения во вкладке «Диагностика» — с буквой филиала результата (ревью L2)
 * и той же пометкой «не проверено» (ревью L3).
 * Здание — как у карты пациента: анализ соседнего здания в списке, с буквой
 * филиала у панели (origin); у документа визита буква — когда она у всех его
 * панелей одна, иначе пометка только у панелей.
 * Ревью M1 — строки с показателями — своим лёгким списком (без notes); анализы —
 * последние limit визитов, показатели читаются только у них и у исследований.
 */
function collectLabs(c) {
  const { db, pid, exclude, limit, found } = c;
  const vsOrigin = hasColumn(db, 'visit_services', 'sync_origin') ? 'vs.sync_origin' : 'NULL';
  const { rows, more } = capRows(db.prepare(`
    SELECT vs.id, vs.visit_id, vs.status, vs.verified_at, ${vsOrigin} AS vs_origin, v.visit_date,
           ${SERVICE_COLS},
           du.full_name AS doctor_name
      FROM visit_services vs
      JOIN visits v ON v.id = vs.visit_id
      LEFT JOIN services s ON s.id = vs.service_id
      LEFT JOIN departments dp ON dp.id = s.department_id
      LEFT JOIN users du ON du.id = vs.doctor_id
     WHERE v.patient_id = ? AND vs.clinic_item_id IS NULL AND COALESCE(vs.status, '') <> 'cancelled'
       AND EXISTS (SELECT 1 FROM lab_results lr WHERE lr.visit_service_id = vs.id)
     ORDER BY v.visit_date DESC, vs.id DESC
     LIMIT ?`).all(pid, SCAN_LIMIT + 1), SCAN_LIMIT);
  if (more) { c.cut.labs = true; c.cut.diag = true; }
  const labVisits = [];
  const labLines = [];
  const measureLines = [];
  for (const l of rows) {
    if (exclude && l.id === exclude) continue;
    const kind = lineKind(l);
    if (kind === 'labs') {
      if (!labVisits.includes(l.visit_id)) {
        if (labVisits.length >= limit) { c.cut.labs = true; continue; }
        labVisits.push(l.visit_id);
      }
      labLines.push(l);
    } else if (kind === 'diag') {
      if (c.cutLines.has(l.id)) { c.cut.diag = true; continue; }   // описание исследования не взято пределом — измерения с ним
      measureLines.push(l);
    }
  }
  const results = latestResults(db, [...labLines, ...measureLines].map((l) => l.id));
  const unverifiedOf = (l) => l.status !== 'completed' && !l.verified_at;

  const byVisit = new Map();
  for (const l of labLines) {
    const rowsOf = results.get(l.id);
    if (!rowsOf || !rowsOf.length) continue;
    const origin = panelOrigin(l, rowsOf);
    let doc = byVisit.get(l.visit_id);
    if (!doc) {
      doc = {
        id: 'labs:' + l.visit_id, kind: 'labs', source: 'lab', visit_id: l.visit_id, visit_service_id: null,
        title: 'Результаты анализов', doctor: '', at: l.visit_date, unverified: false, origin: null, panels: [],
      };
      byVisit.set(l.visit_id, doc);
      found.labs.push(doc);
    }
    const unverified = unverifiedOf(l);
    doc.panels.push({ visit_service_id: l.id, title: l.name, unverified, origin, rows: rowsOf.map(({ origin: _o, ...r }) => r) });
    if (unverified) doc.unverified = true;
  }
  for (const doc of byVisit.values()) {
    doc.panels.sort((a, b) => a.visit_service_id - b.visit_service_id);
    const letters = new Set(doc.panels.map((p) => p.origin));
    doc.origin = letters.size === 1 ? doc.panels[0].origin : null;
  }

  // Документ строки — первый (новейший) из её документов: у УЗИ бывают копия «Приёма» и копия «Диагностики».
  const diagByLine = new Map();
  for (const d of found.diag) if (d.visit_service_id != null && !diagByLine.has(d.visit_service_id)) diagByLine.set(d.visit_service_id, d);
  for (const l of measureLines) {
    const rowsOf = results.get(l.id);
    if (!rowsOf || !rowsOf.length) continue;
    const origin = panelOrigin(l, rowsOf);
    const unverified = unverifiedOf(l);
    const section = {
      key: 'measurements', label: 'Измерения', html: resultsTableHtml(rowsOf.map(({ origin: _o, ...r }) => r)),
      origin, unverified,
    };
    const doc = diagByLine.get(l.id);
    if (doc) {
      doc.sections.push(section);
      if (unverified) doc.unverified = true;
    } else {
      found.diag.push({
        id: 'line:' + l.id, kind: 'diag', source: 'lab', visit_service_id: l.id,
        title: l.name, doctor: l.doctor_name || '', at: l.verified_at || l.visit_date, origin, unverified, sections: [section],
      });
    }
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
 * Ревью M1/L7 — сначала лёгкий список, текст записи — только у тех, кто уйдёт в ответ.
 */
function collectInpatient(c) {
  const { db, pid, limit, found } = c;
  const titles = loadCaseDocTitles(db);
  const { rows, more } = capRows(db.prepare(`
    SELECT r.id, r.kind, r.type_kind, r.published_at, r.entry_date, u.full_name AS author_name, a.admission_no
      FROM admission_reviews r
      JOIN admissions a ON a.id = r.admission_id
      LEFT JOIN users u ON u.id = r.author_id
     WHERE a.patient_id = ? AND r.published_at IS NOT NULL AND r.superseded_by IS NULL
     ORDER BY COALESCE(r.entry_date, r.published_at) DESC, r.id DESC
     LIMIT ?`).all(pid, SCAN_LIMIT + 1), SCAN_LIMIT);
  if (more) c.cut.inpatient = true;
  const textOf = db.prepare('SELECT complaints, objective, diagnosis, plan, body, sections_json FROM admission_reviews WHERE id = ?');
  let made = 0;
  for (const r of rows) {
    if (made >= limit) { c.cut.inpatient = true; break; }
    const text = textOf.get(r.id) || {};
    const kind = r.type_kind || r.kind;
    const secs = reviewSections(text);
    const own = secs.titles && typeof secs.titles === 'object' ? secs.titles : {};
    const out = [];
    for (const key of REVIEW_KEYS) {
      const label = String(own[key] || (key === 'body' && REVIEW_BODY_LABEL[kind]) || REVIEW_LABEL[key]);
      pushSection(out, key, label, key === 'diagnosis' ? textPart(text.diagnosis) : sectionPart(text[key], true));
    }
    (Array.isArray(secs.extra) ? secs.extra : []).forEach((x, i) => {
      if (!x || typeof x !== 'object') return;
      pushSection(out, 'extra' + i, String(x.title || '').trim() || 'Раздел', sectionPart(x.html, true));
    });
    if (!out.length) continue;
    made += 1;
    found.inpatient.push({
      id: 'review:' + r.id, kind: 'inpatient', source: 'review', visit_service_id: null,
      doc_kind: kind, title: String(titles.get(kind) || ''), doctor: r.author_name || '',
      admission_no: r.admission_no || null, at: r.entry_date || r.published_at, sections: out,
    });
  }
}

/**
 * Загруженные файлы пациента: только название, путь и «лежит ли на этом
 * компьютере» (тем же правилом, что карта пациента, — fileOnThisMachine).
 * Отозванный документ не показывается. Вставлять нечего — окно его открывает.
 * Ревью M1 — лишний файл сверх limit помечает группу truncated.
 */
function collectFiles(c) {
  const { db, pid, limit, found } = c;
  const { rows, more } = capRows(db.prepare(`
    SELECT d.id, d.title, d.file_name, d.file_path, d.created_at, u.full_name AS created_by_name
      FROM visit_documents d
      LEFT JOIN users u ON u.id = d.created_by
     WHERE d.patient_id = ? AND d.voided_at IS NULL AND COALESCE(d.file_path, '') <> ''
     ORDER BY d.created_at DESC, d.id DESC
     LIMIT ?`).all(pid, limit + 1), limit);
  if (more) c.cut.files = true;
  for (const r of rows) {
    found.files.push({
      id: 'file:' + r.id, kind: 'files', source: 'file', document_id: r.id, visit_service_id: null,
      title: r.title || r.file_name || '', file_name: r.file_name || '', file_path: r.file_path,
      file_available: fileOnThisMachine(r.file_path), doctor: r.created_by_name || '', at: r.created_at,
    });
  }
}
