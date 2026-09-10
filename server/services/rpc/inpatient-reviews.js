// INPATIENT_REVIEW_V1 — первичный осмотр главного врача и назначение лечащего
// врача (Задача 3 плана docs/plans/2026-09-04-inpatient-workflow.md).
//
// ─── ЧТО ЭТОТ ФАЙЛ РЕШАЕТ ───────────────────────────────────────────────────
//
// Решение владельца (2026-09-04) дословно: «нет первичного осмотра — нет
// назначений; нет лечащего врача — нет лечения». Задача 1 построила замок
// (assertCanPrescribe: пациент обязан дойти до 'active'), Задача 2 довела
// пациента до койки — и на этом маршрут КОНЧАЛСЯ. Из 'admitted' наружу не вело
// ничего: ни один RPC не умел провести осмотр, значит ни один пациент,
// положенный медсестрой, не мог получить ни назначения, ни — до этой правки —
// даже выписки. Здесь маршрут продолжается.
//
// Два шага, и оба делает главный врач:
//   admission_review_save     осмотр как ДОКУМЕНТ; публикация первичного
//                             двигает 'admitted' → 'examined';
//   admission_set_attending   лечащий врач; двигает 'examined' → 'active' и
//                             тем самым ОТКРЫВАЕТ лечение.
//
// …и чтение, без которого второй шаг слеп:
//   admission_attending_candidates  КОГО можно назначить — тем же признаком
//                             (isDoctorRow), которым назначение потом проверяет
//                             выбранного. Экран не собирает этот список сам:
//                             собранный отдельно, он расходится с сервером
//                             молча (см. шапку функции).
//
// ─── ПОЧЕМУ ЧЕРНОВИК И ПУБЛИКАЦИЯ — РАЗНЫЕ ВЕЩИ ─────────────────────────────
//
// Осмотр набирают у постели или в кабинете, между двумя другими делами, и
// дописывают. Если бы сохранение сразу двигало маршрут, врач был бы обязан
// написать документ целиком с первого раза — иначе пациент уходит в 'examined'
// с половиной записи, и назначения открываются по недописанному осмотру.
// Поэтому сохранение и публикация — два разных действия с разными правами:
// черновик пишет и правит АВТОР, публикует первичный — ТОЛЬКО главный врач.
//
// ─── ПОЧЕМУ ИСПРАВЛЕНИЕ — ЭТО НОВАЯ ЗАПИСЬ ──────────────────────────────────
//
// Опубликованный осмотр не переписывается никогда: врач публикует следующий, а
// прежний получает `superseded_by` и остаётся в истории целиком (миграция
// 095). Переписать медицинский документ на месте — значит стереть то, на
// основании чего уже приняли решения: по прежнему диагнозу успели назначить
// лечение и выставить счёт.
//
// ─── ЧЕГО ЗДЕСЬ НЕТ ─────────────────────────────────────────────────────────
//
// Своих правил маршрута и своей матрицы прав: и «дошёл ли пациент», и «вправе
// ли этот человек» спрашиваются у rpc/inpatient-flow.js — там же, где их
// спрашивают Задачи 2, 4 и 8. Вторая копия этих правил разошлась бы с первой, и
// разошлась бы молча.
//
// Подбора кода МКБ: `diagnosis` — свободный текст (см. шапку 095).
//
// Выписки: 'discharge'-запись здесь можно написать и опубликовать, но маршрут
// она НЕ двигает — двухшаговую выписку строит Задача 8.

import {
  RpcError, loadAdmission, assertAdmissionAtLeast, assertCanPrescribe,
  assertMayTransition, admissionTransition, CLOSED_STATUSES,
  isAdmittingDoctor,   // ADMITTING_DOCTOR_V1
} from './inpatient-flow.js';
import { hasAnyRole, effectiveRoles } from '../roles.js';
import { titleSheetCaseItem, sheetView } from './title-sheet.js';   // TITLE_SHEET_V1
import { sanitizeStoredHtml, htmlToText } from '../../../public/js/shared/rich-text.js';   // CASE_DOC_A4_V1

export { RpcError };

// ─── CASE_DOCS_V1 — ОБЯЗАТЕЛЬНЫЙ НАБОР ДОКУМЕНТОВ ИСТОРИИ БОЛЕЗНИ ───────────
//
// Одиннадцать бумаг в регламентном порядке — тот самый список, который владелец
// показал мокапом. Словарь родов живёт в базе (миграция 104), ПОРЯДОК и СРОКИ —
// здесь, потому что срок это вычисление, а не хранимое поле: дату
// госпитализации правят (ADMISSION_DATE_EDIT_V1), и хранимая копия срока
// разошлась бы с ней в первый же раз.
//
// ─── ОТКУДА БЕРЁТСЯ СРОК ────────────────────────────────────────────────────
//
// Точка отсчёта одна — `admitted_at`, момент размещения на койке. Не
// `ordered_at`: заявку оформляют за неделю до плановой госпитализации, и
// «согласие в течение 2 часов» от даты заявки означало бы просроченное
// согласие у каждого планового пациента. Пока пациент не на койке, часы не
// идут вовсе: у всех пунктов срока нет, и чек-лист говорит это словами.
//
// Четыре рода срока, и каждый отвечает на свой вопрос:
//   'clock'         — разовый документ к сроку: `hours` от размещения.
//   'period'        — ПОВТОРЯЮЩИЙСЯ документ: на каждые `hours` нужен свой.
//                     Дневник наблюдения — период 24 ч, этапный эпикриз — 240 ч
//                     (10 суток). Это одно правило с двумя числами, а не два
//                     разных: «просрочен» у обоих значит одно и то же — период
//                     закрылся, а документа за него нет.
//   'surgical'      — `hours` от НАЧАЛА хирургического блока (см. ниже).
//   'at_discharge'  — «при выписке». Часов нет и быть не может: срок этого
//                     документа — событие, а не время. Просроченным он не
//                     бывает никогда, но без него выписку не принимают.
//
// ─── ХИРУРГИЧЕСКИЙ БЛОК — ПО ДАННЫМ, А НЕ ПО ПРОФИЛЮ ────────────────────────
//
// Мокап подписывает набор ярлыком «Хирург. профиль». Профиля отделения в этом
// продукте СЕГОДНЯ НЕТ и подделать его нечем: `admissions.department` — это
// свободный текст (миграция 092), справочника отделений в базе не существует.
// Поэтому три хирургические бумаги (осмотр анестезиолога, предоперационный
// эпикриз, протокол операции) включаются СОБЫТИЕМ: появился хотя бы один из
// них — значит оперируют, и остальные два становятся обязательными, а часы им
// идут от первого. У терапевтического пациента блока просто нет.
//
// Следующий шаг назван вслух и здесь не сделан: DEPARTMENT_PROFILE_V2 —
// справочник отделений с профилем и составом набора на профиль.
// CONSENT_OUT_V1 (2026-09-08) — «Согласие на госпитализацию и вмешательство»
// из набора УБРАНО (владелец: «the consent shouldn't be there»). Согласие —
// бумага, которую пациент подписывает при поступлении, и её отметка живёт на
// титульном листе (INPATIENT_DOCS_V1: договор / согласие / памятка); врачебной
// записью она не является и в чек-листе врача только занимала «следующий
// шаг». Уже написанные записи рода 'consent' остаются читаемыми и печатаются
// в собранной истории первыми (LEGACY_KINDS ниже).
export const CASE_DOC_SET = Object.freeze([
  { kind: 'intake',      due: 'clock',        hours: 2 },
  { kind: 'anesthesia',  due: 'surgical',     hours: 24, block: 'surgical' },
  { kind: 'preop',       due: 'surgical',     hours: 24, block: 'surgical' },
  { kind: 'head_review', due: 'clock',        hours: 72 },
  { kind: 'primary',     due: 'clock',        hours: 24 },
  { kind: 'rationale',   due: 'clock',        hours: 72 },
  { kind: 'operation',   due: 'surgical',     hours: 24, block: 'surgical' },
  { kind: 'round',       due: 'period',       hours: 24 },
  { kind: 'interim',     due: 'period',       hours: 240 },
  { kind: 'discharge',   due: 'at_discharge', hours: null },
].map(Object.freeze));

/** Второй раздел мокапа: всё, что клиника подшивает сверх набора. */
export const OTHER_KIND = 'other';

/** Роды, которых в наборе больше нет, но записи которых у клиник уже есть (CONSENT_OUT_V1). */
export const LEGACY_KINDS = Object.freeze(['consent']);

// ---------------------------------------------------------------------------
// CASE_DOC_SET_V2 (2026-09-08) — НАБОР ЗАДАЁТ КЛИНИКА, А НЕ КОД.
//
// Владелец: «this list is hardcoded and the system asks for filling them, we
// need to make not hardcoded, and able to add a title document. its maybe
// before operation it can be anesthesist list etc etc. but we shoud give basic
// templates list + option».
//
// Набор выше остаётся — но уже как ЗАСЕВАЕМЫЙ ОБРАЗЕЦ (миграция 115 кладёт
// ровно эти десять строк) и как запасной вариант для базы, до этой миграции не
// дошедшей. Читает же чек-лист таблицу case_doc_types.
//
// ЧТО ОСТАЁТСЯ КОДОМ. Правила срока: их четыре с половиной, и каждое — своя
// арифметика (от койки, периодом, от начала хирургического блока, при выписке,
// без срока). Клиника выбирает правило и часы; изобрести пятое правило она не
// может, потому что новое правило — это новый код, а не строка справочника.
//
// ЧИТАЕТСЯ ПРИ КАЖДОМ ЗАПРОСЕ И НЕ КЭШИРУЕТСЯ. Набор правят редко, а сервер
// живёт неделями: кэш означал бы, что клиника меняет состав и не видит
// изменений до перезапуска. Запрос — десять строк по индексу.
const DOC_SET_SQL = 'SELECT kind, title, due_rule, due_hours, block FROM case_doc_types WHERE active = 1 ORDER BY sort_order, id';

/**
 * Имена ВСЕХ родов, включая убранные из набора.
 *
 * CASE_DOC_KEEP_WRITTEN_V1 — убранный род пропадает из набора, но написанные
 * им документы остаются документами, и на бумаге у них должно быть имя. Набор
 * (loadCaseDocSet) их имён уже не знает: он отдаёт только действующие.
 */
export function loadCaseDocTitles(db) {
  try {
    const rows = db.prepare('SELECT kind, title FROM case_doc_types').all();
    return new Map(rows.map((r) => [r.kind, r.title || '']));
  } catch (e) { return new Map(); }   // база старше миграции 115
}

export function loadCaseDocSet(db) {
  let rows = null;
  try { rows = db.prepare(DOC_SET_SQL).all(); }
  catch (e) { rows = null; }   // база старше миграции 115
  if (!rows || !rows.length) return CASE_DOC_SET;
  return rows.map((r) => Object.freeze({
    kind: r.kind,
    title: r.title || '',
    due: r.due_rule,
    hours: r.due_hours === null || r.due_hours === undefined ? null : Number(r.due_hours),
    block: r.block || undefined,
  }));
}

/** Документы, само наличие которых означает «этого пациента оперируют». */
export function surgicalKinds(docSet) {
  return docSet.filter((d) => d.block === 'surgical').map((d) => d.kind);
}

/**
 * РАЗОВЫЕ документы: второй опубликованный ЗАКРЫВАЕТ прежний (superseded_by) —
 * это и есть «исправление не стирает исходник». Повторяющиеся (дневник,
 * этапный эпикриз) так не закрывают: там второй документ — следующая запись, а
 * не исправление предыдущей, и закрыть её значило бы стереть вчерашний день.
 */
export function singleKinds(docSet) {
  return docSet.filter((d) => d.due !== 'period').map((d) => d.kind);
}

/** Всё, что вообще принимается как род записи: набор + прежние роды + «прочее». */
export function knownKinds(db) {
  return [...loadCaseDocSet(db).map((d) => d.kind), ...LEGACY_KINDS, OTHER_KIND];
}

/** Три документа операции — для тех мест, где набор ещё не загружен. */
export const SURGICAL_KINDS = Object.freeze(['anesthesia', 'preop', 'operation']);

// ДОКУМЕНТ, КОТОРЫЙ ВЕДЁТ ЛЕЧАЩИЙ ВРАЧ. У этих публикация спрашивает
// assertCanPrescribe — «лечение начато и это свой пациент»: дневник, этапный и
// выписной эпикризы, обоснование диагноза — записи ВЕДЕНИЯ, и чужой врач их не
// пишет.
//
// Всё остальное (согласие, осмотр приёмного врача, осмотр анестезиолога,
// предоперационный эпикриз, протокол операции, осмотр заведующего, прочие) —
// НАОБОРОТ: их автор по определению НЕ лечащий врач. Требовать от них
// assertCanPrescribe значило бы запретить анестезиологу написать свой осмотр, а
// приёмному врачу — свой: осмотр приёмного врача пишется в час поступления,
// когда лечащего врача ещё нет вовсе.
const ATTENDING_DOC_KINDS = ['round', 'interim', 'discharge', 'rationale'];

// Кто вообще ПИШЕТ врачебную запись. Медсестры здесь нет: осмотр — врачебный
// документ, а сестринская запись в этой базе — отметка в листе назначений
// (rpc/treatment-orders.js). Право написать ЧЕРНОВИК шире права ОПУБЛИКОВАТЬ:
// см. шапку.
const WRITE_ROLES = ['doctor', 'head_doctor', 'admin'];

// Читают записи все, кто ведёт пациента в отделении — тот же круг, что у листа
// назначений (READ_ROLES в treatment-orders.js). Касса и склад в историю
// болезни не ходят.
const READ_ROLES = ['admin', 'doctor', 'head_doctor', 'nurse', 'senior_nurse'];

// СМЕНУ ЛЕЧАЩЕГО ВРАЧА делает тот же, кто его НАЗНАЧАЕТ — главный врач или
// администратор. Рядовой врач здесь отсутствует намеренно, и это не про
// иерархию: «лечащий врач» — подпись под лечением и под деньгами за него, и
// возможность переписать её на себя означала бы, что любой врач может забрать
// чужого пациента вместе с его назначениями и выработкой.
const CHANGE_ATTENDING_ROLES = ['head_doctor', 'admin'];

// КТО СПРАШИВАЕТ СПИСОК ВРАЧЕЙ ДЛЯ НАЗНАЧЕНИЯ. Ровно те же, кто вправе
// назначить и сменить: 'examined→active' в TRANSITION_ROLES и
// CHANGE_ATTENDING_ROLES — один и тот же круг. Список шире права был бы
// справочником сотрудников для всех, кто открыл стационар, а он здесь не за
// этим.
// ADMITTING_DOCTOR_V1 — список стал шире: приёмный врач назначает лечащего
// (ему нужен список), а медсестра при размещении называет приёмного врача
// (ей — тот же список). Это имена действующих врачей, не более.
const ATTENDING_ROLES = ['head_doctor', 'admin', 'doctor', 'nurse', 'senior_nurse'];

// ГДЕ лечащего врача МЕНЯЮТ. До 'active' его НАЗНАЧАЮТ (первичный осмотр
// главного врача, admission_set_attending) — там менять ещё нечего;
// 'discharging' входит сюда намеренно: между заявкой на выписку и её
// оформлением проходят часы, врач уходит с дежурства, а заявку можно отозвать
// и лечение продолжить — тогда подписывать его должен тот, кто на месте.
// Закрытая госпитализация (выписан / отменена) не меняется вовсе.
const CHANGE_ATTENDING_STATUSES = ['active', 'discharging'];

function str(v, max, fallback = '') {
  if (v === null || v === undefined) return fallback;
  return String(v).trim().slice(0, max);
}

/**
 * CASE_DOC_A4_V1 — раздел документа: разметка, очищенная до оформления.
 *
 * Обрезка идёт ПО ТЕКСТУ, а не по разметке: срезать HTML посередине значит
 * сохранить документ с недописанным тегом, который потом сломает вёрстку у
 * читающего. Слишком длинный раздел падает до простого текста — он остаётся
 * читаемым, теряя только оформление.
 */
function rich(v, max) {
  const html = sanitizeStoredHtml(v);
  if (html.length <= max) return html;
  return htmlToText(html).slice(0, max);
}

function posIntOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function nowUtc(db) {
  return db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now') t").get().t;
}

function requireRole(user, allowed, what) {
  if (!hasAnyRole(user, allowed)) {
    throw new RpcError(`${what} — недоступно вашей роли.`, 403);
  }
}

// РОЛЬ, КОТОРОЙ ВОСПОЛЬЗОВАЛИСЬ, — не «первая роль человека». Главный врач
// носит надстройку поверх врача (extra_roles, миграция 091), и в записи должно
// стоять то, ЧЕМ он подписал: разбор «кто пустил пациента в лечение без
// осмотра» приходит именно за этим (см. шапку 095). Порядок в `preferred` —
// это и есть «старшинство подписи».
function usedRole(user, preferred) {
  const mine = effectiveRoles(user);
  return preferred.find((r) => mine.includes(r)) || (user && user.role) || '';
}

/**
 * ПРИЗНАК ВРАЧА — не текст роли.
 *
 * Инвариант этой базы (ADMIN_DOCTOR_LIST_V1, public/js/admin/data.js:416 и
 * service-editor-logic.js): администратор клиники может быть врачом, и у такой
 * учётной записи role='admin', specialty пустая — по тексту роли она врачом не
 * выглядит. Поэтому первым спрашивается `is_doctor`, а role/specialty остаются
 * как поддержка старых строк, заведённых до миграции 018.
 */
export function isDoctorRow(u) {
  if (!u) return false;
  if (u.is_doctor === 1 || u.is_doctor === true) return true;
  if (String(u.role || '').toLowerCase() === 'doctor') return true;
  if (String(u.specialty || '').trim()) return true;
  if (String(u.license_number || '').trim()) return true;
  return false;
}

// CASE_DOC_SET_V2 — ДЕЙСТВУЮЩИЙ РОД СТРОКИ.
//
// Свой род клиники хранится родом 'other' (он в CHECK колонки есть) плюс
// настоящим родом в type_kind: снять CHECK можно только пересборкой таблицы, а
// пересборок мы не делаем (урок 1.1.0, миграция 116). Читатели про это не
// знают: они спрашивают род, и получают тот, который есть на самом деле.
const effKind = (r) => (r && r.type_kind ? r.type_kind : (r && r.kind));
const withKind = (r) => (r && r.type_kind ? Object.assign({}, r, { kind: r.type_kind }) : r);

/** Как род ложится в базу: встроенный — как есть, свой — в type_kind. */
function storedKind(db, kind) {
  const own = loadCaseDocSet(db).some((d) => d.kind === kind) && !BUILTIN_KINDS.includes(kind);
  return own ? { kind: OTHER_KIND, type_kind: kind } : { kind, type_kind: null };
}

/** Роды, которые колонка admission_reviews.kind принимает как есть (CHECK миграции 095). */
const BUILTIN_KINDS = Object.freeze([...CASE_DOC_SET.map((d) => d.kind), ...LEGACY_KINDS, OTHER_KIND]);

function loadReview(db, reviewId) {
  const id = posIntOrNull(reviewId);
  if (id === null) throw new RpcError('review_id must be a positive integer.', 400);
  const row = db.prepare('SELECT * FROM admission_reviews WHERE id = ?').get(id);
  if (!row) throw new RpcError('Запись осмотра не найдена.', 400);
  return withKind(row);
}

// ─── 1. Сохранить / опубликовать осмотр ─────────────────────────────────────

/**
 * Осмотр: черновик или публикация.
 *
 * ПОРЯДОК ПРОВЕРОК ПРИ ПУБЛИКАЦИИ ПЕРВИЧНОГО — СНАЧАЛА РОЛЬ, ПОТОМ СОСТОЯНИЕ,
 * и это обратно тому, что делает admission_admit. Там койка была важнее роли,
 * потому что «пациент уже лежит» отменяет весь вопрос. Здесь наоборот: суть
 * решения владельца в том, ЧЕЙ это осмотр. Врачу, открывшему чужую форму,
 * правильный ответ — «первичный осмотр проводит главный врач», а не «пациент
 * ещё не на койке»: второй отправляет его звать медсестру там, где дело вообще
 * не в койке.
 *
 * @param {{admission_id:number, kind?:'primary'|'round'|'discharge',
 *          review_id?:number, complaints?:string, objective?:string,
 *          diagnosis?:string, plan?:string, body?:string,
 *          publish?:boolean, supersedes?:number}} args
 */
/**
 * СВОИ РАЗДЕЛЫ ДОКУМЕНТА — то, чего в пяти колонках нет.
 *
 * CASE_DOC_FREE_SEC_V1 (2026-09-09) — владелец: «add option to create "free
 * field without/with name" editable». Раздел без имени — законный случай:
 * врач дописывает абзац, которому имя не нужно, и требовать его значило бы
 * требовать всегда.
 *
 * Чистится ЗДЕСЬ, а не только на экране: /api/rpc открыт с любого компьютера
 * клиники. Пределы те же, что у обычных разделов, и число разделов ограничено
 * — иначе один документ мог бы вырасти в базу данных.
 */
const MAX_EXTRA_SECS = 20;
/** Разделы, у которых есть своя колонка: только их подписи и переименовывают. */
const SECTION_KEYS = Object.freeze(['complaints', 'objective', 'diagnosis', 'plan', 'body']);

function parseSections(a) {
  const src = a && a.sections;
  if (!src || typeof src !== 'object') return null;

  const titles = {};
  const t = src.titles && typeof src.titles === 'object' ? src.titles : {};
  for (const key of SECTION_KEYS) {
    const v = str(htmlToText(t[key]), 80);
    if (v) titles[key] = v;
  }

  const extra = [];
  const list = Array.isArray(src.extra) ? src.extra.slice(0, MAX_EXTRA_SECS) : [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const title = str(htmlToText(item.title), 80);
    const html = rich(item.html, 8000);
    // Пустой раздел не сохраняется вовсе: строка без имени и без текста — это
    // не раздел, а забытое нажатие «добавить».
    if (!title && !html) continue;
    extra.push({ title, html });
  }

  // CASE_DOC_SEC_MANAGER_V1 — СОСТАВ РАЗДЕЛОВ этого документа: врач убрал
  // ненужные и добавил нужные, как в кабинете. Пустой список не значит
  // «разделов нет» — он значит «экран о них не сказал», и тогда состав
  // берётся из рода документа, как и раньше.
  const secs = Array.isArray(src.secs)
    ? src.secs.map((k) => str(k, 20)).filter((k) => SECTION_KEYS.includes(k))
    : null;

  if (!Object.keys(titles).length && !extra.length && !secs) return null;
  return JSON.stringify(secs ? { titles, extra, secs } : { titles, extra });
}

/** Свои разделы записи — всегда объект, даже когда колонка пуста или испорчена. */
export function reviewSections(row) {
  const raw = row && row.sections_json;
  if (!raw) return { titles: {}, extra: [] };
  try {
    const v = JSON.parse(raw);
    return {
      titles: v && typeof v.titles === 'object' && v.titles ? v.titles : {},
      extra: Array.isArray(v && v.extra) ? v.extra : [],
      secs: Array.isArray(v && v.secs) ? v.secs : null,
    };
  } catch (e) { return { titles: {}, extra: [] }; }
}

export function admissionReviewSave(db, args, user) {
  const a = args || {};
  const kind = str(a.kind, 20, 'primary') || 'primary';
  // CASE_DOC_SET_V2 — род проверяется по НАБОРУ КЛИНИКИ: свой род, заведённый в
  // «Документах», обязан приниматься так же, как встроенный.
  if (!knownKinds(db).includes(kind)) throw new RpcError(`Неизвестный род записи: ${kind}.`, 400);

  requireRole(user, WRITE_ROLES, 'Врачебная запись');

  const publish = a.publish === true || a.publish === 1 || a.publish === 'true';
  // CASE_DOC_A4_V1 — разделы документа пишутся форматируемым текстом (лист A4,
  // как в кабинете врача), то есть приходят разметкой. Чистит её СЕРВЕР, а не
  // только экран: /api/rpc открыт с любого компьютера клиники, и «наш экран уже
  // почистил» — не проверка. Пределы удвоены: разметка занимает место, а текста
  // столько же.
  //
  // ДИАГНОЗ ОСТАЁТСЯ ПРОСТЫМ ТЕКСТОМ. Он показывается в обзоре, в журнале
  // госпитализаций и в списках — там разметка была бы мусором, а не
  // оформлением.
  const sectionsJson = parseSections(a);
  // DIARY_ENTRY_DATE_V1 — ДЕНЬ, О КОТОРОМ ЗАПИСЬ. Дневник наблюдения пишут
  // каждый день, и написан он бывает утром следующего: время публикации
  // отвечает «когда напечатали», а лечение читают по «за какое число». Пусто —
  // как было: днём записи считается день публикации.
  const entryDate = /^\d{4}-\d{2}-\d{2}$/.test(String(a.entry_date || '')) ? String(a.entry_date) : null;
  const fields = {
    complaints: rich(a.complaints, 4000),
    objective:  rich(a.objective, 8000),
    diagnosis:  str(htmlToText(a.diagnosis), 500),
    plan:       rich(a.plan, 8000),
    body:       rich(a.body, 16000),
  };

  const run = db.transaction(() => {
    const adm = loadAdmission(db, a.admission_id);

    // Черновик, который правят, — только СВОЙ и только черновик.
    let existing = null;
    if (a.review_id !== undefined && a.review_id !== null && a.review_id !== '') {
      existing = loadReview(db, a.review_id);
      if (existing.admission_id !== adm.id) {
        throw new RpcError('Эта запись относится к другой госпитализации.', 400);
      }
      if (existing.published_at) {
        // Ровно то правило, ради которого в 095 есть superseded_by.
        throw new RpcError('Опубликованный осмотр не переписывают: сохраните исправление — оно станет новой записью, а прежняя останется в истории.', 400);
      }
      if (existing.author_id !== (user && user.id) && !hasAnyRole(user, ['admin'])) {
        throw new RpcError('Черновик осмотра правит только его автор.', 403);
      }
    }

    // ── Право на ПУБЛИКАЦИЮ (у черновика его не спрашивают) ─────────────────
    let authorRole = usedRole(user, ['head_doctor', 'admin', 'doctor']);
    if (publish) {
      if (kind === 'primary') {
        // 1. Роль — текст отказа называет действие и тех, кто его делает
        //    (ACTION_NAME/ROLE_TITLE в inpatient-flow.js: «Первичный осмотр —
        //    недоступно вашей роли. Это делает: главный врач, администратор.»).
        assertMayTransition('admitted', 'examined', user);
        // 2. Состояние: осматривают ЛЕЖАЩЕГО и ещё не осмотренного. 'examined'
        //    тоже пускаем — это исправление уже опубликованного осмотра.
        if (adm.status !== 'admitted' && adm.status !== 'examined') {
          throw new RpcError(primaryStateRefusal(db, adm), 400);
        }
        authorRole = usedRole(user, ['head_doctor', 'admin']);
      } else if (kind === 'intake') {
        // ADMITTING_DOCTOR_V1 — «Осмотр приёмного врача» пишет ПРИЁМНЫЙ ВРАЧ:
        // тот, кого медсестра назвала при размещении. Главный врач и
        // администратор — как и прежде (они закрывают любой пробел). Чужому
        // врачу отказ называет, кого ждут.
        if (CLOSED_STATUSES.includes(adm.status)) {
          throw new RpcError('Госпитализация закрыта — документы в неё больше не подшивают.', 400);
        }
        if (!hasAnyRole(user, ['head_doctor', 'admin']) && !isAdmittingDoctor(adm, user)) {
          const who = adm.admitting_doctor_id
            ? (db.prepare('SELECT full_name FROM users WHERE id = ?').get(adm.admitting_doctor_id) || {}).full_name
            : '';
          throw new RpcError(who
            ? `Осмотр приёмного врача пишет приёмный врач этого пациента — ${who} (или главный врач).`
            : 'Осмотр приёмного врача пишет приёмный врач, которого медсестра называет при размещении, или главный врач. Приёмный врач у этой госпитализации не назначен.', 403);
        }
        authorRole = isAdmittingDoctor(adm, user)
          ? usedRole(user, ['doctor', 'head_doctor', 'admin'])
          : usedRole(user, ['head_doctor', 'admin', 'doctor']);
      } else if (ATTENDING_DOC_KINDS.includes(kind)) {
        // Обход и эпикриз ведёт тот, кто лечит: лечащий врач СВОЕГО пациента,
        // главный врач, администратор — и только по начатому лечению. Это тот
        // же вопрос, что задаёт назначение, поэтому и функция та же.
        assertCanPrescribe(db, adm.id, user);
        authorRole = adm.attending_doctor_id === (user && user.id)
          ? usedRole(user, ['doctor', 'head_doctor', 'admin'])
          : usedRole(user, ['head_doctor', 'admin', 'doctor']);
      } else {
        // CASE_DOCS_V1 — документы, автор которых по определению НЕ лечащий
        // врач (см. ATTENDING_DOC_KINDS выше). Спрашивается ровно одно: жива ли
        // ещё история болезни. Дописывать документы в закрытую — то же самое,
        // что дописать услугу выписанному: запись задним числом в документ,
        // который уже отдан на руки.
        if (CLOSED_STATUSES.includes(adm.status)) {
          throw new RpcError('Госпитализация закрыта — документы в неё больше не подшивают.', 400);
        }
      }
    }

    const at = nowUtc(db);
    const publishedAt = publish ? at : null;

    let reviewId;
    // CASE_DOC_SET_V2 — свой род клиники ложится в type_kind, а колонка kind
    // получает 'other': её CHECK написан до настраиваемого набора и снимается
    // только пересборкой таблицы, которой мы не делаем.
    const st = storedKind(db, kind);
    if (existing) {
      db.prepare(`UPDATE admission_reviews
                     SET kind = ?, type_kind = ?, complaints = ?, objective = ?, diagnosis = ?, plan = ?, body = ?,
                         sections_json = ?, author_role = ?, updated_at = ?, published_at = ?,
                         entry_date = COALESCE(?, entry_date)
                   WHERE id = ?`)
        .run(st.kind, st.type_kind, fields.complaints, fields.objective, fields.diagnosis, fields.plan, fields.body,
             sectionsJson, authorRole, at, publishedAt, entryDate, existing.id);
      reviewId = existing.id;
    } else {
      reviewId = db.prepare(`INSERT INTO admission_reviews
          (admission_id, kind, type_kind, complaints, objective, diagnosis, plan, body,
           sections_json, author_id, author_role, published_at, entry_date)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(adm.id, st.kind, st.type_kind, fields.complaints, fields.objective, fields.diagnosis, fields.plan,
             fields.body, sectionsJson, (user && user.id) || null, authorRole, publishedAt, entryDate).lastInsertRowid;
    }

    // ── Что публикация МЕНЯЕТ вокруг себя ──────────────────────────────────
    if (publish) {
      // Явное исправление конкретной записи (любой род) — по её id.
      const supersedes = posIntOrNull(a.supersedes);
      if (supersedes !== null && supersedes !== reviewId) {
        const prev = loadReview(db, supersedes);
        if (prev.admission_id !== adm.id) throw new RpcError('Исправляемая запись относится к другой госпитализации.', 400);
        db.prepare('UPDATE admission_reviews SET superseded_by = ? WHERE id = ?').run(reviewId, prev.id);
      }
      // РАЗОВЫЙ документ у госпитализации ОДИН действующий. Второй
      // опубликованный автоматически закрывает прежний: две «действующие»
      // редакции одного документа — это вопрос «по какой из них лечим», на
      // который никто не сможет ответить. CASE_DOCS_V1 распространил правило с
      // первичного осмотра на весь разовый набор (SINGLE_KINDS) — оно там ровно
      // такое же, и именно оно делает счётчик редакций в чек-листе настоящим.
      if (singleKinds(loadCaseDocSet(db)).includes(kind)) {
        // Ищется по ДЕЙСТВУЮЩЕМУ роду: у своего рода он в type_kind, и сравнение
        // по одной колонке kind закрыло бы все «прочие документы» разом.
        db.prepare(`UPDATE admission_reviews
                       SET superseded_by = ?
                     WHERE admission_id = ? AND COALESCE(type_kind, kind) = ? AND id <> ?
                       AND published_at IS NOT NULL AND superseded_by IS NULL`)
          .run(reviewId, adm.id, kind, reviewId);
      }
      if (kind === 'primary') {
        // И только теперь — шаг маршрута. Исправление осмотра у пациента,
        // который уже в 'examined', ничего не двигает: он там и стоит.
        if (adm.status === 'admitted') {
          admissionTransition(db, { admission_id: adm.id, to: 'examined', at }, user);
        }
      }
      // ADMITTING_DOCTOR_V1 — осмотр приёмного врача ТОЖЕ закрывает шаг
      // «осмотрен»: после него лечащего врача назначают (главный или сам
      // приёмный). Подпись шага — того, кто опубликовал осмотр.
      if (kind === 'intake' && adm.status === 'admitted') {
        admissionTransition(db, { admission_id: adm.id, to: 'examined', at }, user, { admittingDoctorOk: true });
      }
    }

    return {
      review: db.prepare('SELECT * FROM admission_reviews WHERE id = ?').get(reviewId),
      admission: db.prepare('SELECT * FROM admissions WHERE id = ?').get(adm.id),
      published: !!publish,
    };
  });

  return run();
}

// Почему первичный осмотр нельзя опубликовать ИМЕННО СЕЙЧАС — словами
// маршрута. `assertAdmissionAtLeast` уже умеет называть недостающий шаг
// («Пациент ещё не размещён на койке — позовите медсестру»), поэтому для
// «слишком рано» зовём её, а «слишком поздно» описываем здесь.
function primaryStateRefusal(db, adm) {
  try {
    assertAdmissionAtLeast(db, adm.id, 'admitted');
  } catch (e) {
    return e.message;
  }
  return 'Первичный осмотр уже закрыт назначением лечащего врача — исправление вносят записью обхода.';
}

// ─── 2. Назначить лечащего врача ────────────────────────────────────────────

/**
 * Лечащий врач: 'examined' → 'active'. Это и есть тот шаг, после которого
 * открываются назначения, услуги и стол.
 *
 * @param {{admission_id:number, doctor_id:number}} args
 */
export function admissionSetAttending(db, args, user) {
  const a = args || {};
  const doctorId = posIntOrNull(a.doctor_id);
  if (doctorId === null) throw new RpcError('doctor_id must be a positive integer.', 400);

  const run = db.transaction(() => {
    const adm = loadAdmission(db, a.admission_id);

    // 1. Роль. «Назначение лечащего врача — недоступно вашей роли. Это делает:
    //    главный врач, администратор.» ADMITTING_DOCTOR_V1 — и приёмный врач
    //    ЭТОГО пациента: владелец — «head doctor or selected doctor should
    //    fill the treating doctor».
    const asAdmitting = isAdmittingDoctor(adm, user);
    if (!asAdmitting) assertMayTransition('examined', 'active', user);

    // 2. Состояние: назначать лечащего можно только ОСМОТРЕННОМУ. До осмотра
    //    отказ называет недостающий шаг сам (assertAdmissionAtLeast).
    assertAdmissionAtLeast(db, adm.id, 'examined');
    if (adm.status !== 'examined') {
      // Текст обещает отдельное действие — и оно есть: admissionChangeAttending
      // ниже (RPC `admission_change_attending`). До этой правки обещание было
      // пустым: смены лечащего врача не существовало нигде, и госпитализация,
      // дошедшая до 'active' с пустым attending_doctor_id (старый admit_patient
      // позволял это, и 091 переносит такие строки как есть), не лечилась
      // вообще — назначения отвечали 403, а назначить врача было нечем.
      throw new RpcError('Лечащий врач уже назначен — смена лечащего врача делается отдельно (главный врач).', 400);
    }

    // 3. ВРАЧ ЛИ ЭТО. Отдельная проверка, а не доверие экрану: список врачей в
    //    браузере собирается по тому же признаку, но /api/rpc открыт curl'ом с
    //    любого компьютера клиники, а лечащий врач — это подпись под лечением.
    const u = db.prepare('SELECT id, full_name, role, is_doctor, specialty, license_number, active FROM users WHERE id = ?').get(doctorId);
    if (!u) throw new RpcError('Врач не найден.', 400);
    if (!isDoctorRow(u)) {
      throw new RpcError('Лечащим врачом можно назначить только врача: у выбранного сотрудника нет признака врача.', 400);
    }
    if (u.active === 0) throw new RpcError('Сотрудник уволен — лечащим врачом его назначить нельзя.', 400);

    // Лечащий врач — это ОТДЕЛЬНАЯ колонка, а не перезапись doctor_id:
    // doctor_id хранит НАПРАВИВШЕГО, и потерять его значило бы потерять ответ
    // на вопрос «кто прислал пациента».
    //
    // НО ЕСЛИ НАПРАВИВШЕГО НЕТ, ДЫРУ ЗАПОЛНЯЕМ. Пациент, поступивший без
    // направления (заявка регистратуры, приёмный покой), приходит с пустым
    // doctor_id, а на него смотрят старые экраны и отчёты — они показывали
    // прочерк там, где врач есть. COALESCE заполняет пустое и НЕ ТРОГАЕТ
    // заполненное: это и есть «согласованы», обещанные шапкой миграции 091, —
    // не равенство двух колонок, а отсутствие пустоты там, где ответ известен.
    db.prepare(
      'UPDATE admissions SET attending_doctor_id = ?, doctor_id = COALESCE(doctor_id, ?) WHERE id = ?',
    ).run(doctorId, doctorId, adm.id);
    const res = admissionTransition(db, { admission_id: adm.id, to: 'active' }, user, { admittingDoctorOk: asAdmitting });

    return { admission: res.admission, attending: { id: u.id, full_name: u.full_name, specialty: u.specialty || '' } };
  });

  return run();
}

// ─── 2b. СМЕНИТЬ лечащего врача ─────────────────────────────────────────────

/**
 * СМЕНА ЛЕЧАЩЕГО ВРАЧА — и ЕДИНСТВЕННЫЙ способ вытащить госпитализацию,
 * которая осталась без него совсем.
 *
 * ─── ЧЕГО НЕ ХВАТАЛО ────────────────────────────────────────────────────────
 *
 * `admission_set_attending` отказывал словами «смена лечащего врача делается
 * отдельно», и ничего отдельного не существовало. Пустое обещание стоило
 * дорого сразу в двух местах:
 *
 *   1. ОБЫЧНАЯ ЖИЗНЬ ОТДЕЛЕНИЯ. Лечащий врач уходит в отпуск, увольняется,
 *      уезжает на неделю — пациент остаётся, и назначения ему подписывать
 *      некому: assertCanPrescribe пускает лечащего врача ЭТОГО пациента,
 *      главного врача и администратора, а обычный врач, которому пациента
 *      передали по-человечески, получает 403.
 *
 *   2. ГОСПИТАЛИЗАЦИИ БЕЗ ЛЕЧАЩЕГО ВРАЧА ВООБЩЕ. Миграция 091 переносит
 *      attending_doctor_id := doctor_id, а старый `admit_patient` разрешал
 *      класть пациента с пустым doctor_id. На живом отделении это означает
 *      десятки открытых госпитализаций, у которых attending_doctor_id NULL:
 *      назначения им отвечают 403 всем без исключения, а `set_attending`
 *      отказывает, потому что смотрит на СТАТУС ('active' — «уже назначен»),
 *      а не на колонку. Такая госпитализация не лечилась и не чинилась ничем.
 *      ЭТО И ЕСТЬ ГЛАВНАЯ РАБОТА ЭТОГО RPC: он спасает их поимённо.
 *
 * ─── ГДЕ ЭТО ЗАПИСАНО И ПОЧЕМУ ИМЕННО ТАМ ──────────────────────────────────
 *
 * В `admission_transfers` — журнале ДВИЖЕНИЙ госпитализации, kind='attending'.
 * Тем же приёмом и по тому же доводу, что отзыв заявки на выписку
 * (kind='discharge_cancel', rpc/inpatient.js): эта таблица уже отвечает на
 * вопрос «что происходило с этой госпитализацией и кто это сделал» — заявка,
 * поступление, перевод, отмена, выписка, отзыв, правка даты. Смена лечащего
 * врача — событие ровно того же рода: не документ, а факт с подписью и
 * временем, который читают подряд с остальными.
 *
 * `admission_reviews` (095) для этого не годится, и это не вкусовщина: там
 * живут ВРАЧЕБНЫЕ ЗАПИСИ — осмотр, обход, эпикриз. У каждой есть автор,
 * публикация, замещение исправлением и правило «опубликованное не
 * переписывают». Смена врача ни одного из этих свойств не имеет: у неё нет
 * черновика, её не публикуют и не исправляют новой редакцией. Положить её
 * туда значило бы завести запись, которую экран истории болезни обязан
 * показывать как документ, а она им не является.
 *
 * ─── ПОЧЕМУ ПРИЧИНА ОБЯЗАТЕЛЬНА НЕ ВСЕГДА ───────────────────────────────────
 *
 * Когда лечащий врач БЫЛ и его меняют — причина обязательна: замена врача
 * посреди лечения это решение, за которым завтра придут («почему пациента
 * забрали у Азизы?»), и журнал без ответа бесполезен. Когда лечащего НЕ БЫЛО
 * (та самая мигрировавшая строка) — это не смена, а НАЗНАЧЕНИЕ, и требовать
 * объяснения за починку данных значит мешать чинить.
 *
 * @param {{admission_id:number, doctor_id:number, reason?:string}} args
 */
export function admissionChangeAttending(db, args, user) {
  const a = args || {};
  const doctorId = posIntOrNull(a.doctor_id);
  if (doctorId === null) throw new RpcError('doctor_id must be a positive integer.', 400);
  const reason = str(a.reason, 300);

  const run = db.transaction(() => {
    const adm = loadAdmission(db, a.admission_id);

    // 1. РОЛЬ — первой. Врачу, открывшему чужую карту, правильный ответ —
    //    «это делает главный врач», а не «пациент ещё не дошёл до лечения».
    requireRole(user, CHANGE_ATTENDING_ROLES, 'Смена лечащего врача');

    // 2. СОСТОЯНИЕ.
    if (CLOSED_STATUSES.includes(adm.status)) {
      throw new RpcError(adm.status === 'discharged'
        ? 'Пациент уже выписан — госпитализация закрыта, лечащего врача в ней не меняют.'
        : 'Заявка на госпитализацию отменена — лечащего врача в ней не меняют.', 400);
    }
    if (!CHANGE_ATTENDING_STATUSES.includes(adm.status)) {
      // До 'active' лечащего ещё НАЗНАЧАЮТ, а не меняют, и делает это первичный
      // осмотр главного врача. Отказ называет тот шаг, а не этот.
      throw new RpcError(
        'Лечащего врача ещё не назначали — его назначает главный врач вместе с первичным осмотром.', 400);
    }

    // 3. ВРАЧ ЛИ ЭТО. Тот же вопрос и тем же признаком, что у назначения:
    //    /api/rpc открыт curl'ом, а лечащий врач — подпись под лечением.
    const u = db.prepare(
      'SELECT id, full_name, role, is_doctor, specialty, license_number, active FROM users WHERE id = ?').get(doctorId);
    if (!u) throw new RpcError('Врач не найден.', 400);
    if (!isDoctorRow(u)) {
      throw new RpcError('Лечащим врачом можно назначить только врача: у выбранного сотрудника нет признака врача.', 400);
    }
    if (u.active === 0) throw new RpcError('Сотрудник уволен — лечащим врачом его назначить нельзя.', 400);

    const previousId = adm.attending_doctor_id || null;

    // Повтор — не ошибка: нажали дважды, открыли на двух экранах. Ничего не
    // меняем и не пишем в журнал вторую одинаковую строку.
    if (previousId === doctorId) {
      return {
        admission: adm,
        attending: { id: u.id, full_name: u.full_name, specialty: u.specialty || '' },
        previous_attending_doctor_id: previousId,
        changed: false,
      };
    }

    // 4. ПРИЧИНА — см. шапку: обязательна там, где это СМЕНА.
    if (previousId && !reason) {
      throw new RpcError('Укажите причину смены лечащего врача.', 400);
    }

    // 5. ЗАПИСЬ. doctor_id (направивший) не перезаписывается — только
    //    заполняется, если он пуст: см. тот же COALESCE в set_attending выше и
    //    исправленную шапку миграции 091.
    db.prepare(
      'UPDATE admissions SET attending_doctor_id = ?, doctor_id = COALESCE(doctor_id, ?) WHERE id = ?',
    ).run(doctorId, doctorId, adm.id);

    const previous = previousId
      ? db.prepare('SELECT full_name FROM users WHERE id = ?').get(previousId)
      : null;
    // Строка журнала читается человеком подряд с поступлением и переводами,
    // поэтому в ней ИМЕНА, а не id: разбор через полгода не должен идти в
    // таблицу users за каждой строкой. Койка и палата — только `to_*`: пациент
    // никуда не переезжает, он остаётся там, где лежал.
    const note = (previous
      ? `Лечащий врач: ${previous.full_name || ('#' + previousId)} → ${u.full_name || ('#' + doctorId)}`
      : `Лечащий врач назначен: ${u.full_name || ('#' + doctorId)} (был не указан)`)
      + (reason ? ` · ${reason}` : '');
    db.prepare(`
      INSERT INTO admission_transfers (admission_id, to_bed_id, to_ward_id, kind, reason, transferred_at, transferred_by)
      VALUES (?, ?, ?, 'attending', ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'), ?)
    `).run(adm.id, adm.bed_id, adm.ward_id, note, (user && user.id) || null);

    return {
      admission: db.prepare('SELECT * FROM admissions WHERE id = ?').get(adm.id),
      attending: { id: u.id, full_name: u.full_name, specialty: u.specialty || '' },
      previous_attending_doctor_id: previousId,
      changed: true,
    };
  });

  return run();
}

// ─── 3. Чтение ──────────────────────────────────────────────────────────────

/**
 * КОГО МОЖНО НАЗНАЧИТЬ ЛЕЧАЩИМ — СПИСКОМ, ОТ ТОГО ЖЕ ПРАВИЛА, ЧТО И ПРИНИМАЕТ.
 *
 * ПОЧЕМУ ЭТО RPC, А НЕ ЗАПРОС ЭКРАНА К ТАБЛИЦЕ users. Список врачей окно
 * «Назначить лечащего врача» собирало у себя: `.from('users').select('id,
 * full_name, specialty, role, is_doctor, license_number')`. Реестр
 * (server/db/schema-registry.js) колонку `license_number` у users НЕ отдаёт, а
 * компилятор на неразрешённое поле не «пропускает лишнее» — он отказывает
 * ВСЕМУ запросу («unknown column», 400, server/db/query-compiler.js). Ответ
 * приходил пустым, окно рисовало один «Выберите врача», и главный врач видел
 * экран, на котором в клинике будто нет ни одного врача. Тот же класс ошибки
 * уже ронял раздел «Стационар» (patients(phone)) и «Календарь записи» (пять
 * колонок) — здесь он закрыт иначе: экран больше не перечисляет колонки users
 * вообще, и добавить туда лишнюю нечем.
 *
 * И ГЛАВНОЕ — ПРАВИЛО ОДНО. Кто «врач», решает isDoctorRow, и решает ЗДЕСЬ, той
 * же функцией, которой admission_set_attending и admission_change_attending
 * потом проверяют выбранного. Две копии признака (одна в браузере, другая на
 * сервере) — это ровно тот случай, когда экран показывает человека, а сервер
 * его не принимает, или наоборот; сойтись руками они могут, а остаться
 * сошедшимися — нет.
 *
 * ФИЛИАЛ ЗДЕСЬ НЕ ФИЛЬТРУЕТСЯ НАМЕРЕННО. `users.branch_id` ездит между
 * зданиями справочником (STAFF_SYNC_V1), у привезённых из главной клиники он
 * несёт чужое значение, а isDoctorRow про здание не спрашивает вовсе. Отфильтруй
 * мы список по зданию — сервер принимал бы врача, которого экран не показал:
 * та самая расхождение, ради устранения которого этот RPC и написан.
 *
 * ПУСТОЙ ОТВЕТ ОБЪЯСНЯЕТ СЕБЯ. Врачей нет вовсе и «врачи есть, но все уволены» —
 * разные беды с разными починками, поэтому `dismissed` считается и уезжает
 * рядом со списком: окно скажет словами, что именно случилось, вместо пустого
 * выпадающего списка, который читается как поломка.
 *
 * @param {{}} _args не нужны: это справочник клиники, а не свойство пациента
 * @returns {{doctors:Array<{id:number,full_name:string,specialty:string}>, dismissed:number}}
 */
export function admissionAttendingCandidates(db, _args, user) {
  requireRole(user, ATTENDING_ROLES, 'Список врачей для назначения лечащим');

  const rows = db.prepare(
    'SELECT id, full_name, role, is_doctor, specialty, license_number, active FROM users ORDER BY full_name',
  ).all();

  // ТОТ ЖЕ ПРЕДИКАТ И ТОТ ЖЕ ПОРЯДОК ПРОВЕРОК, что у назначения ниже по файлу:
  // сначала «врач ли», потом «не уволен ли». Уволенных считаем отдельно — это и
  // есть третье состояние пустоты.
  const all = rows.filter(isDoctorRow);
  const working = all.filter((u) => u.active !== 0);

  return {
    doctors: working.map((u) => ({
      id: u.id,
      full_name: u.full_name || '',
      specialty: u.specialty || '',
    })),
    dismissed: all.length - working.length,
  };
}

/**
 * Все врачебные записи госпитализации, по порядку.
 *
 * ЧЕРНОВИКИ ВИДНЫ НЕ ВСЕМ. Недописанный осмотр — это ещё не документ, и
 * показывать его отделению значило бы дать читать половину диагноза как целый.
 * Его видит автор, главный врач и администратор — те, кто его и допишет.
 */
export function admissionReviewsList(db, args, user) {
  requireRole(user, READ_ROLES, 'Врачебные записи');
  const adm = loadAdmission(db, args && args.admission_id);

  const rows = db.prepare(`
    SELECT r.*, u.full_name AS author_name
      FROM admission_reviews r
      LEFT JOIN users u ON u.id = r.author_id
     WHERE r.admission_id = ?
     ORDER BY r.id
  `).all(adm.id).map(withKind);

  const seesDrafts = hasAnyRole(user, ['admin', 'head_doctor']);
  const uid = (user && user.id) || null;
  const reviews = rows.filter((r) => r.published_at || seesDrafts || (uid && r.author_id === uid));

  return {
    admission_id: adm.id,
    status: adm.status,
    attending_doctor_id: adm.attending_doctor_id,
    examined_at: adm.examined_at,
    examined_by: adm.examined_by,
    reviews,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// CASE_DOCS_V1 — ЧЕК-ЛИСТ ДОКУМЕНТОВ ИСТОРИИ БОЛЕЗНИ И СБОРКА ИСТОРИИ
// ═══════════════════════════════════════════════════════════════════════════
//
// Владелец: «можно сделать список стационарной госпитализации вот так? и
// собрать документы в один файл?» — мокап 040926/doc-checklist-mockup.html.
//
// Мокап — картинка: в нём нет ни одного вычисленного срока (все одиннадцать
// написаны буквами), нет модели «что обязательно», нет истории редакций
// (захардкожена пара строк), а действия появляются по наведению мыши. Здесь —
// то, чего в нём нет:
//
//   admission_case_docs   СОСТОЯНИЕ набора: что оформлено, что просрочено, что
//                         следующее, к какому сроку и сколько у документа
//                         редакций. Все сроки — вычисление от даты размещения
//                         (CASE_DOC_SET выше), «просрочен» — результат
//                         сравнения с часами, а не флаг в базе.
//   admission_case_file   СБОРКА: опубликованные документы одной
//                         госпитализации в регламентном порядке, с обложкой,
//                         для печати одним файлом.
//
// Оба ТОЛЬКО ЧИТАЮТ и потому стоят в READ_ONLY_RPCS (control/gate.js): история
// болезни — документ, а не услуга, и клиника с просроченной лицензией обязана
// видеть и собрать её целиком.

const MS_HOUR = 3600 * 1000;

/** ISO → миллисекунды, null на всём, что временем не является. */
function msOf(iso) {
  if (!iso) return null;
  const t = Date.parse(String(iso));
  return Number.isFinite(t) ? t : null;
}

/** Миллисекунды → 'YYYY-MM-DDTHH:MM:SSZ' — тот же вид, в котором время лежит в базе. */
function isoOf(ms) {
  return ms === null || ms === undefined ? null : new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * ЦЕПОЧКИ РЕДАКЦИЙ. Одна цепочка — один документ со всеми его исправлениями:
 * [оригинал, испр.1, испр.2 …], где каждый следующий указан в `superseded_by`
 * предыдущего. Хвост цепочки, никем не закрытый, — ДЕЙСТВУЮЩАЯ редакция.
 *
 * Считается по данным, а не по счётчику в строке: счётчик разошёлся бы с
 * действительностью в первый же раз, когда исправление сделали в обход RPC,
 * а цепочка не может — она И ЕСТЬ данные.
 */
function chainsOf(publishedRows) {
  const byId = new Map(publishedRows.map((r) => [r.id, r]));
  const closed = new Set(publishedRows.map((r) => r.superseded_by).filter((x) => x && byId.has(x)));
  const roots = publishedRows.filter((r) => !closed.has(r.id));
  const chains = roots.map((root) => {
    const chain = [];
    const seen = new Set();
    let cur = root;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      chain.push(cur);
      cur = cur.superseded_by ? byId.get(cur.superseded_by) : null;
    }
    return chain;
  });
  chains.sort((a, b) => String(a[0].published_at || '').localeCompare(String(b[0].published_at || '')) || a[0].id - b[0].id);
  return chains;
}

/** Редакции документа для экрана: настоящие номера, авторы и времена. */
function revisionsOf(chain) {
  return chain.map((r, i) => ({
    id: r.id,
    no: i + 1,
    at: r.published_at,
    entry_date: r.entry_date || null,   // DIARY_ENTRY_DATE_V1 — за какой день запись
    author_id: r.author_id,
    author_name: r.author_name || '',
    author_role: r.author_role || '',
    current: i === chain.length - 1,
  }));
}

/** Действующая (никем не закрытая) цепочка среди опубликованных, или null. */
function currentChain(chains) {
  for (let i = chains.length - 1; i >= 0; i--) {
    const tail = chains[i][chains[i].length - 1];
    if (!tail.superseded_by) return chains[i];
  }
  return null;
}

/**
 * ПОВТОРЯЮЩИЙСЯ ДОКУМЕНТ: дневник наблюдения (сутки) и этапный эпикриз (10
 * суток) — одно правило с разным периодом. Окна нарезаются от размещения на
 * койке; окно считается закрытым документом, если в него попала публикация.
 *
 * «Просрочен» здесь означает ровно одно и проверяемое: закрылось окно, за
 * которое документа нет. Не флаг, не догадка — арифметика по часам.
 */
/**
 * За какой МОМЕНТ считается запись.
 *
 * DIARY_ENTRY_DATE_V1 — если врач указал день (дневник за вчера, дописанный
 * утром), период закрывает ТОТ день, а не минута печати. Полдень взят
 * намеренно: дата без времени иначе попадала бы в полночь — на границу двух
 * суточных окон, и запись за 9-е закрывала бы то 9-е, то 8-е.
 */
function stampOf(row) {
  if (row && row.entry_date) {
    const t = Date.parse(String(row.entry_date) + 'T12:00:00Z');
    if (!Number.isNaN(t)) return t;
  }
  return msOf(row && row.published_at);
}

function periodState(base, now, periodMs, publishedRows) {
  if (base === null) return { index: 0, missing: [], covered: false, dueAt: null };
  const index = Math.max(0, Math.floor((now - base) / periodMs));
  const stamps = publishedRows.map(stampOf).filter((t) => t !== null);
  const inWindow = (w) => stamps.some((t) => t >= base + w * periodMs && t < base + (w + 1) * periodMs);
  const missing = [];
  for (let w = 0; w < index; w++) if (!inWindow(w)) missing.push(w);
  return { index, missing, covered: inWindow(index), dueAt: base + (index + 1) * periodMs };
}

/** Что за документы подшиты к этой госпитализации — одним запросом, с авторами. */
function loadCaseRows(db, admissionId) {
  return db.prepare(`
    SELECT r.*, u.full_name AS author_name
      FROM admission_reviews r
      LEFT JOIN users u ON u.id = r.author_id
     WHERE r.admission_id = ?
     ORDER BY r.id
  `).all(admissionId).map(withKind);
}

function groupRowsByKind(rows) {
  const byKind = new Map();
  for (const r of rows) {
    if (!byKind.has(r.kind)) byKind.set(r.kind, []);
    byKind.get(r.kind).push(r);
  }
  return byKind;
}

/**
 * СОСТОЯНИЕ НАБОРА ДОКУМЕНТОВ ГОСПИТАЛИЗАЦИИ.
 *
 * Пять состояний мокапа — 'published' / 'draft' / 'overdue' / 'next' /
 * 'pending' — и каждое здесь РЕЗУЛЬТАТ ДАННЫХ, а не поле:
 *   published  есть опубликованная действующая редакция;
 *   overdue    срок прошёл, документа нет (часы, а не флаг);
 *   draft      черновик есть, срок ещё не вышел;
 *   next       ПЕРВЫЙ по порядку из тех, что можно сделать прямо сейчас, —
 *              РОВНО ОДИН на весь список: заметное действие, у которого два
 *              адресата, перестаёт быть указанием, что делать дальше;
 *   pending    срок ещё не наступил или очередь не дошла.
 *
 * Просроченный пункт «следующим» не бывает НАМЕРЕННО (так же в мокапе): «что
 * делать дальше» и «что уже провалено» — два разных вопроса, и смешать их
 * значит спрятать второй за первым.
 *
 * @param {{admission_id:number, now?:string}} args `now` — только для тестов:
 *        состояния считаются по часам, и проверять их можно лишь на заданном
 *        времени.
 */
export function admissionCaseDocs(db, args, user) {
  requireRole(user, READ_ROLES, 'Документы истории болезни');
  const adm = loadAdmission(db, args && args.admission_id);
  const nowIso = str(args && args.now, 40) || nowUtc(db);
  const now = msOf(nowIso);

  // ТОЧКА ОТСЧЁТА — размещение на койке, и спрашивается она у СОСТОЯНИЯ, а не
  // у колонки. Колонка `admitted_at` объявлена NOT NULL DEFAULT now (миграция
  // 015 и следом 091): у заявки, которая койки ещё не видела, она ЗАПОЛНЕНА
  // временем оформления. Поверь мы ей — плановая заявка, оформленная за неделю,
  // приехала бы в чек-лист с одиннадцатью просроченными документами в первую же
  // секунду. Экран карточки обходит ту же ловушку тем же способом
  // (views/admission-modal.js смотрит на `admitted_by`).
  const placed = !['ordered', 'cancelled'].includes(adm.status);
  const baseIso = placed ? (adm.admitted_at || null) : null;
  const baseSource = baseIso ? 'admitted' : null;
  const base = msOf(baseIso);

  const rows = loadCaseRows(db, adm.id);
  const byKind = groupRowsByKind(rows);

  // ADMITTING_DOCTOR_V1 — кого ждут с осмотром при поступлении: экран называет
  // приёмного врача рядом с пунктом, пока осмотр не написан.
  const admittingName = adm.admitting_doctor_id
    ? ((db.prepare('SELECT full_name FROM users WHERE id = ?').get(adm.admitting_doctor_id) || {}).full_name || '')
    : '';

  // CASE_DOC_SET_V2 — состав чек-листа берётся у клиники.
  const docSet = loadCaseDocSet(db);

  // Хирургический блок — по данным: появился хоть один документ, помеченный
  // блоком, значит оперируют. Какие это документы, решает набор клиники.
  const surgicalRows = surgicalKinds(docSet).flatMap((k) => byKind.get(k) || []);
  const surgical = surgicalRows.length > 0;
  const surgStamps = surgicalRows.map((r) => msOf(r.created_at)).filter((t) => t !== null).sort((a, b) => a - b);
  const surgBase = surgStamps.length ? surgStamps[0] : null;

  const items = docSet.map((def, i) => {
    const kindRows = byKind.get(def.kind) || [];
    const published = kindRows.filter((r) => r.published_at);
    const drafts = kindRows.filter((r) => !r.published_at);
    const chains = chainsOf(published);
    const chain = currentChain(chains);
    const draft = drafts.length ? drafts[drafts.length - 1] : null;

    let applies = true;
    let required = true;
    let dueAt = null;
    let state;
    let periodsMissing = 0;

    // CASE_DOC_SET_V2 — часы приходят из набора и могут быть пустыми: у правил
    // «при выписке» и «без срока» их не бывает, а у остальных пустое число
    // значит «срок не задан», а не «просрочено немедленно».
    const hours = Number.isFinite(Number(def.hours)) ? Number(def.hours) : null;
    if (def.due === 'clock') {
      dueAt = (base === null || hours === null) ? null : base + hours * MS_HOUR;
    } else if (def.due === 'surgical') {
      applies = surgical;
      required = surgical;
      dueAt = (surgBase === null || hours === null) ? null : surgBase + hours * MS_HOUR;
    } else if (def.due === 'period' && hours !== null) {
      const p = periodState(base, now, hours * MS_HOUR, published);
      dueAt = p.dueAt;
      periodsMissing = p.missing.length;
      // Этапный эпикриз становится обязательным, только когда первый его период
      // (10 суток) закрылся: требовать его от пациента, лежащего второй день, —
      // значит выдумать нарушение там, где его нет.
      required = def.kind === 'round' ? true : (p.index >= 1 || p.missing.length > 0);
      if (p.missing.length) state = 'overdue';
      else if (p.covered) state = 'published';
      else if (draft) state = 'draft';
      else state = 'pending';
    }

    if (state === undefined) {
      if (chain) state = 'published';
      else if (dueAt !== null && now > dueAt) state = 'overdue';
      else if (draft) state = 'draft';
      else state = 'pending';
    }
    // «При выписке» — событие, а не час: просроченным этот документ не бывает.
    // «Без срока» — тем более: клиника завела документ в набор, но часов ему
    // не назначила, и выдумывать их за неё нельзя.
    if ((def.due === 'at_discharge' || def.due === 'none') && state === 'overdue') state = 'pending';

    const tail = chain ? chain[chain.length - 1] : null;
    return {
      kind: def.kind,
      group: 'required',
      order: i,
      applies,
      required: applies && required,
      state,
      // CASE_DOC_SET_V2 — имя СВОЕГО рода клиника пишет сама, и переводить его
      // некому: экран показывает его как есть. У встроенных пусто — их имена
      // живут в словаре и переводятся на три языка.
      title: def.title || '',
      due_rule: def.due,
      due_at: isoOf(dueAt),
      period_hours: def.due === 'period' ? hours : null,
      periods_missing: periodsMissing,
      entries: chains.length,
      block: def.block || null,
      review_id: tail ? tail.id : null,
      published_at: tail ? tail.published_at : null,
      author_name: tail ? (tail.author_name || '') : '',
      // ADMITTING_DOCTOR_V1 — у «Осмотра приёмного врача» есть адресат.
      assignee_name: def.kind === 'intake' ? admittingName : '',
      revisions: chain ? revisionsOf(chain) : [],
      revision_count: chain ? chain.length : 0,
      draft_id: draft ? draft.id : null,
      has_draft: !!draft,
    };
  });

  // TITLE_SHEET_V1 — титульный лист медсестры: ПЕРВОЙ строкой, в прогрессе и в
  // списке «не оформлено», но НЕ в «следующем шаге»: «следующий» — одно
  // заметное действие ВРАЧА, а лист — дело поста.
  const titleItem = titleSheetCaseItem(db, adm, base, now);

  // «Прочие документы» — второй раздел мокапа. Каждая цепочка здесь отдельный
  // документ: это открытый род, и второй такой же — не исправление первого.
  const otherRows = byKind.get(OTHER_KIND) || [];
  const otherChains = chainsOf(otherRows.filter((r) => r.published_at));
  const otherDrafts = otherRows.filter((r) => !r.published_at);
  const blankOther = {
    kind: OTHER_KIND, group: 'other', applies: true, required: false,
    due_rule: 'none', due_at: null, period_hours: null, periods_missing: 0, block: null,
  };
  const other = otherChains.map((chain, i) => Object.assign({}, blankOther, {
    order: CASE_DOC_SET.length + i,
    state: 'published',
    entries: 1,
    review_id: chain[chain.length - 1].id,
    published_at: chain[chain.length - 1].published_at,
    author_name: chain[chain.length - 1].author_name || '',
    revisions: revisionsOf(chain),
    revision_count: chain.length,
    draft_id: null,
    has_draft: false,
  })).concat(otherDrafts.map((d, i) => Object.assign({}, blankOther, {
    order: CASE_DOC_SET.length + otherChains.length + i,
    state: 'draft',
    entries: 0,
    review_id: null,
    published_at: null,
    author_name: d.author_name || '',
    revisions: [],
    revision_count: 0,
    draft_id: d.id,
    has_draft: true,
  })));

  // ─── РОВНО ОДНО ЗАМЕТНОЕ ДЕЙСТВИЕ ────────────────────────────────────────
  const openSet = items.filter((it) => it.required && it.state !== 'published');
  const eligible = (it) => {
    if (!it.required) return false;
    if (it.state !== 'pending' && it.state !== 'draft') return false;
    // Выписной эпикриз пишут, когда пациента выписывают, а не в первый день:
    // предложить его лежащему пациенту первым — значит указать не туда.
    if (it.due_rule === 'at_discharge') {
      return adm.status === 'discharging' || openSet.every((o) => o.kind === it.kind);
    }
    return true;
  };
  const next = items.find(eligible) || null;
  if (next) next.state = 'next';

  // NEXT_STEP_OVERDUE_V1 (2026-09-08) — «СЛЕДУЮЩИЙ ШАГ» НЕ БЫВАЕТ ПУСТЫМ, ПОКА
  // ЕСТЬ ЧТО ОФОРМЛЯТЬ.
  //
  // В СПИСКЕ просроченный пункт «следующим» не становится намеренно: «что
  // делать» и «что провалено» — разные вопросы, и заметная кнопка чек-листа
  // остаётся ровно одна. Но у госпитализации, где просрочено ВСЁ открытое,
  // выполнимых пунктов не остаётся: next_kind оказывался пустым, и обзор писал
  // «Все документы оформлены» прямо над строкой «оформлено 0 из 8, просрочено
  // 7». Владелец сфотографировал ровно это.
  //
  // Указатель и состояние — разные вещи. Сюда идёт самый ранний просроченный,
  // а его state остаётся 'overdue': счётчик «просрочено» не меняется, красная
  // отметка в списке не пропадает, заметная кнопка не раздваивается. Выписной
  // эпикриз в указатель не попадает по тому же правилу, что и выше, — пока
  // пациента не выписывают, это указание не туда.
  const overdueNext = next ? null : (items.find((it) => it.required && it.state === 'overdue'
    && (it.due_rule !== 'at_discharge' || adm.status === 'discharging')) || null);
  const nextKind = next ? next.kind : (overdueNext ? overdueNext.kind : null);

  // CASE_DOC_KEEP_WRITTEN_V1 (2026-09-09) — ВОПРОС ВЛАДЕЛЬЦА: «what about the
  // saved documents?». Ответ до этой правки был плохой: документ, написанный
  // родом, который клиника потом убрала из набора, ИСЧЕЗАЛ с экрана. Строка
  // оставалась в базе, но в чек-лист не попадала (набор её больше не называет)
  // и в «прочие» тоже (там только род 'other'). История болезни выписанного
  // пациента молча теряла документ из-за настройки, сделанной месяцем позже.
  //
  // Теперь такие документы стоят среди «прочих»: из обязательного списка род
  // ушёл — спрашивать его больше не с кого, — а написанное осталось видимым,
  // открывается и печатается.
  const setKinds = new Set(docSet.map((d) => d.kind));
  const goneTitles = loadCaseDocTitles(db);
  const goneDocs = [];
  for (const kind of byKind.keys()) {
    if (kind === OTHER_KIND || setKinds.has(kind)) continue;
    const chains = chainsOf((byKind.get(kind) || []).filter((r) => r.published_at));
    chains.forEach((chain) => {
      const cur = chain[chain.length - 1];
      if (cur.superseded_by) return;
      goneDocs.push(Object.assign({}, blankOther, {
        kind,
        title: goneTitles.get(kind) || '',
        order: CASE_DOC_SET.length + other.length + goneDocs.length,
        state: 'published',
        entries: 1,
        review_id: cur.id,
        published_at: cur.published_at,
        author_name: cur.author_name || '',
        revisions: revisionsOf(chain),
        revision_count: chain.length,
        draft_id: null,
        has_draft: false,
      }));
    });
  }
  if (goneDocs.length) other.push(...goneDocs);

  const allItems = [titleItem, ...items];
  const progress = {
    done: allItems.filter((it) => it.required && it.state === 'published').length,
    total: allItems.filter((it) => it.required).length,
    overdue: allItems.filter((it) => it.state === 'overdue').length,
    draft: allItems.filter((it) => it.state === 'draft' || it.state === 'next').length,
  };

  // ─── ГЕЙТ ВЫПИСКИ, КОТОРЫЙ УЖЕ СУЩЕСТВУЕТ ────────────────────────────────
  //
  // Заявку на выписку сегодня останавливает РОВНО ОДИН документ — выписной
  // эпикриз (rpc/inpatient.js, admission_discharge_request), и у отказа там две
  // разные формулировки: «не написан» и «сохранён черновиком». Чек-лист
  // повторяет это ОДИН В ОДИН, а не придумывает свой гейт: пообещать здесь, что
  // выписку держит весь набор, значило бы соврать про поведение сервера — врач
  // дописал бы одиннадцать бумаг и всё равно услышал бы отказ про эпикриз, или
  // наоборот подал бы заявку там, где чек-лист обещал блокировку.
  //
  // Остальной недооформленный набор называется отдельным списком (`incomplete`)
  // и словом «не оформлено», а не «блокирует». Расширить сам гейт на весь
  // набор — решение владельца и правка в rpc/inpatient.js, не здесь.
  const epicrisis = items.find((it) => it.kind === 'discharge');
  const blocking = epicrisis && epicrisis.state !== 'published'
    ? [{ kind: 'discharge', reason: epicrisis.has_draft ? 'draft' : 'absent' }]
    : [];
  const incomplete = allItems.filter((it) => it.required && it.state !== 'published').map((it) => it.kind);

  return {
    admission_id: adm.id,
    status: adm.status,
    now: nowIso,
    base_at: baseIso,
    base_source: baseSource,
    surgical,
    surgical_from: isoOf(surgBase),
    items: allItems,
    other,
    progress,
    next_kind: nextKind,
    discharge_gate: { blocked: blocking.length > 0, blocking, incomplete },
  };
}

/**
 * СБОРКА ИСТОРИИ БОЛЕЗНИ В ОДИН ФАЙЛ.
 *
 * Три решения, и каждое — ответ на вопрос, которого мокап не задаёт:
 *
 * 1. КАКАЯ РЕДАКЦИЯ ИДЁТ В СБОРКУ — ДЕЙСТВУЮЩАЯ, одна. Исправленный документ
 *    существует в двух видах, и подшить оба значило бы выдать историю болезни,
 *    в которой два разных диагноза стоят подряд без указания, по какому лечили.
 *    Исходник при этом никуда не девается: он в базе целиком и виден в
 *    чек-листе списком редакций, а в сборке у документа стоит «редакция N»,
 *    чтобы читатель ЗНАЛ, что документ правили, и знал, где искать прежний.
 *
 * 2. ЧЕРНОВИКИ НЕ ВХОДЯТ. Черновик — не документ (миграция 095): он никого
 *    никуда не двигает, его правит автор и он может не иметь ни диагноза, ни
 *    подписи. Собранный вместе с настоящими, он выглядел бы как настоящий.
 *    Сколько их осталось за бортом, сборка говорит числом (`drafts_excluded`):
 *    молча выброшенный черновик — это «а где мой документ?».
 *
 * 3. НЕПОЛНЫЙ НАБОР — СОБИРАЕМ, НО НАЗЫВАЕМ ПРОБЕЛЫ. Отказ был бы удобен нам и
 *    бесполезен клинике: историю болезни просят посмотреть в том числе на
 *    третий день госпитализации, когда половины документов ЗАКОННО ещё нет.
 *    Поэтому сборка идёт всегда, а на обложке стоит список того, чего не
 *    хватает, — тот же самый, что показывает чек-лист. Выписку по-прежнему
 *    держит гейт эпикриза, а не эта кнопка.
 */
/**
 * CASE_FILE_SAVE_V1 (2026-09-06) — СОБРАННАЯ ИСТОРИЯ БОЛЕЗНИ ЛОЖИТСЯ В
 * ДОКУМЕНТЫ ПАЦИЕНТА, А НЕ ТОЛЬКО В ОКНО ПЕЧАТИ.
 *
 * Владелец: «when the pressed the collect history, its will be saved in the
 * documents section of the patient».
 *
 * До сих пор «Собрать историю» открывала окно печати и на этом заканчивалась:
 * закрыл вкладку — и собранного документа нет нигде. Между тем это и есть та
 * бумага, которую спрашивают через год: при разборе, при запросе пациента, при
 * проверке. Она обязана лежать в карте.
 *
 * ЧТО СОХРАНЯЕТСЯ. Снимок (`body`) — тот же самый, что уходит в печать: те же
 * опубликованные редакции, тот же регламентный порядок, та же обложка. Это
 * ВАЖНО: документ в карте и документ на бумаге должны быть одним и тем же, а
 * не двумя сборками, которые однажды разойдутся.
 *
 * ЧЕРНОВИКИ НЕ ПОПАДАЮТ — их не берёт и сама сборка. Незаконченная запись врача
 * не имеет права оказаться в подшитой истории болезни, поэтому число
 * пропущенных черновиков едет рядом (`drafts_excluded`), чтобы собравший видел,
 * что осталось за бортом.
 *
 * НЕПОЛНУЮ ИСТОРИЮ СОБРАТЬ МОЖНО. Пока не хватает документов, `complete` равен
 * false и список недостающих лежит в `gaps` — но собрать всё равно дают: врачу
 * бывает нужна выписка «как есть» до того, как оформлены все бумаги. Запрет
 * здесь означал бы, что до последней подписи история недоступна никому.
 */
export function admissionCaseFileSave(db, args, user) {
  const file = admissionCaseFile(db, args, user);
  const adm = loadAdmission(db, args && args.admission_id);
  if (!adm.patient_id) {
    throw new RpcError('У госпитализации нет пациента — историю болезни некуда подшить.', 400);
  }

  const cover = file.cover || {};
  const no = cover.admission_no ? ' № ' + cover.admission_no : '';
  const title = 'История болезни' + no;

  const row = db.prepare(`
    INSERT INTO visit_documents (title, doc_type, patient_id, body, created_by)
    VALUES (?, 'case_file', ?, ?, ?)
  `).run(title, adm.patient_id, JSON.stringify(file), user && user.id ? user.id : null);

  return {
    document_id: Number(row.lastInsertRowid),
    title,
    patient_id: adm.patient_id,
    // Тот же снимок, что записан в карту: печать берёт ЕГО, а не собирает
    // второй раз — две сборки однажды разойдутся, и бумага перестанет
    // соответствовать подшитому документу.
    file,
    complete: file.complete,
    gaps: file.gaps,
    drafts_excluded: file.drafts_excluded,
  };
}

export function admissionCaseFile(db, args, user) {
  requireRole(user, READ_ROLES, 'История болезни');
  const state = admissionCaseDocs(db, args, user);
  const adm = loadAdmission(db, args && args.admission_id);

  const cover = db.prepare(`
    SELECT a.id, a.admission_no, a.status, a.department, a.admitted_at, a.discharged_at,
           a.planned_discharge_at, a.ordered_at, a.admission_type, a.stay_mode,
           p.full_name AS patient_name, p.mrn AS patient_mrn, p.date_of_birth AS patient_birth_date,
           w.name AS ward_name, b.code AS bed_code,
           doc.full_name AS attending_name, doc.specialty AS attending_specialty
      FROM admissions a
      LEFT JOIN patients p ON p.id = a.patient_id
      LEFT JOIN wards w ON w.id = a.ward_id
      LEFT JOIN beds b ON b.id = a.bed_id
      LEFT JOIN users doc ON doc.id = a.attending_doctor_id
     WHERE a.id = ?`).get(adm.id);

  const rows = loadCaseRows(db, adm.id);
  const byKind = groupRowsByKind(rows);

  const documents = [];
  // CASE_DOC_SET_V2 — имя своего рода едет вместе с документом: на бумаге его
  // взять больше неоткуда, словарь знает только встроенные.
  // Имя берётся из справочника ЦЕЛИКОМ, а не из действующего набора: убранный
  // род иначе печатался бы без имени. Один запрос на всю сборку, а не по
  // запросу на документ.
  const allTitles = loadCaseDocTitles(db);
  const titleOf = (k) => allTitles.get(k) || '';
  const push = (kind, chain, order) => {
    const cur = chain[chain.length - 1];
    documents.push({
      kind,
      title: titleOf(kind),
      order,
      review_id: cur.id,
      published_at: cur.published_at,
      author_id: cur.author_id,
      author_name: cur.author_name || '',
      author_role: cur.author_role || '',
      complaints: cur.complaints || '',
      objective: cur.objective || '',
      diagnosis: cur.diagnosis || '',
      plan: cur.plan || '',
      body: cur.body || '',
      // CASE_DOC_FREE_SEC_V1 — свои разделы и переименованные подписи едут на
      // бумагу вместе с документом: они часть ЭТОГО документа, а не набора.
      sections: reviewSections(cur),
      revision_no: chain.length,
      revision_count: chain.length,
    });
  };

  // РЕГЛАМЕНТНЫЙ ПОРЯДОК, а не порядок написания: история болезни читается
  // сверху вниз как документ, и дневник, вклинившийся между согласием и
  // осмотром приёмного врача только потому, что его написали раньше, делает её
  // нечитаемой.
  // CONSENT_OUT_V1 — старые записи согласия (род больше не в наборе) идут в
  // истории первыми, как и шли: бумага о согласии открывает историю болезни.
  LEGACY_KINDS.forEach((kind, i) => {
    const chain = currentChain(chainsOf((byKind.get(kind) || []).filter((r) => r.published_at)));
    if (chain) push(kind, chain, -LEGACY_KINDS.length + i);
  });
  const docSet = loadCaseDocSet(db);
  docSet.forEach((def, i) => {
    const chains = chainsOf((byKind.get(def.kind) || []).filter((r) => r.published_at));
    if (def.due === 'period') {
      // Повторяющийся документ идёт ВЕСЬ, по датам: дневник наблюдения — это и
      // есть течение болезни, и одна «последняя» запись вместо всех превратила
      // бы историю в снимок.
      chains.forEach((chain) => { if (!chain[chain.length - 1].superseded_by) push(def.kind, chain, i); });
    } else {
      const chain = currentChain(chains);
      if (chain) push(def.kind, chain, i);
    }
  });
  // CASE_DOC_KEEP_WRITTEN_V1 — документы, написанные родом, который клиника
  // потом убрала из набора. На бумаге они идут за регламентными: из набора род
  // ушёл, а документ был написан и остаётся частью истории болезни.
  const setKinds = new Set(docSet.map((d) => d.kind));
  for (const kind of byKind.keys()) {
    if (kind === OTHER_KIND || setKinds.has(kind) || LEGACY_KINDS.includes(kind)) continue;
    chainsOf((byKind.get(kind) || []).filter((r) => r.published_at)).forEach((chain) => {
      if (!chain[chain.length - 1].superseded_by) push(kind, chain, docSet.length);
    });
  }

  const otherChains = chainsOf((byKind.get(OTHER_KIND) || []).filter((r) => r.published_at));
  otherChains.forEach((chain) => {
    if (!chain[chain.length - 1].superseded_by) push(OTHER_KIND, chain, docSet.length + 1);
  });

  const assembledBy = user && user.id
    ? ((db.prepare('SELECT full_name FROM users WHERE id = ?').get(user.id) || {}).full_name || '')
    : '';

  return {
    admission_id: adm.id,
    cover: Object.assign({}, cover, { assembled_at: state.now, assembled_by: assembledBy }),
    documents,
    gaps: state.discharge_gate.incomplete,
    complete: state.discharge_gate.incomplete.length === 0,
    drafts_excluded: rows.filter((r) => !r.published_at).length,
    title_sheet: sheetView(db, adm),   // TITLE_SHEET_V1 — первая страница собранной истории
    progress: state.progress,
  };
}
