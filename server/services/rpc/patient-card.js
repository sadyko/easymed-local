// PATIENT_TAB_ACCESS_V1 — ЕДИНСТВЕННАЯ ДВЕРЬ КАРТЫ ПАЦИЕНТА.
//
// Жалоба владельца: «we need to add a patients card tabs to the view/edit/delete
// option. the informations about the patients are available for anyone who has
// access to the patients section». Так и было: ключ `patients` открывал всю
// карту целиком — услуги, анализы, документы, СЧЕТА, визиты и анкету.
//
// ПОЧЕМУ RPC, А НЕ ПРОВЕРКА В /api/db. Данные вкладок лежат в таблицах, которые
// нужны половине приложения: visit_services читают кабинет врача, лаборатория,
// журнал визитов и касса; invoices и payments — касса и отчёты; visit_documents
// — кабинет врача. Закрыть таблицу значило бы погасить эти экраны. Поэтому
// закрыт не СТОЛ, а ДВЕРЬ: карта пациента больше не ходит в /api/db за
// содержимым вкладок, она спрашивает ЭТОТ обработчик, и он отдаёт ровно те
// вкладки, которые роли выданы. Спрятать вкладку в браузере — не защита:
// проверка живёт здесь, на сервере, и curl её не обойдёт.
//
// ЧТО ОСТАЁТСЯ ВНЕ ЭТОЙ ДВЕРИ (сказано прямо, чтобы никто не считал защиту
// шире, чем она есть): роль, которой реестр таблиц (schema-registry.js) и так
// разрешает читать visit_services или invoices, может прочитать их через
// /api/db — как читает их её собственный экран. Право вкладки сужает КАРТУ
// ПАЦИЕНТА, оно не переопределяет реестр. Внешняя граница — реестр, внутренняя
// — вкладки.
//
// ПО УМОЛЧАНИЮ НИКТО НИЧЕГО НЕ ТЕРЯЕТ: вкладка без явной настройки в роли —
// полный доступ (roles.js patientTabLevel), а сеяные роли (013/059/091)
// patient_tabs не содержат вовсе.

import {
  effectiveRoles, canViewSection,
  PATIENT_CARD_TABS, PATIENT_TAB_CAPS,
  patientTabLevel, canEditPatientTab, canDeletePatientTab,
} from '../roles.js';
import { canRead, canWrite, readableColumns, writableColumns } from '../../db/schema-registry.js';
import { RpcError } from './crm-config.js';
// PATIENT_FILE_ATTACH_V1
import fs from 'node:fs';
import path from 'node:path';
import { getDataDir } from '../control/config.js';
import { patientFileRefusal, refusalText } from '../../../public/js/shared/patient-file-limits.js';

const SECTION = 'patients';

// Русские подписи вкладок — ими сервер называет отказ. Текст один и тот же на
// сервере и на экране (i18n-strings.js переводит его целиком).
export const TAB_LABELS = Object.freeze({
  services: 'Услуги', labs: 'Лаборатория', docs: 'Документы',
  billing: 'Счёт', visits: 'Визиты', details: 'Деталь',
});

const label = (tab) => TAB_LABELS[tab] || tab;

// I18N_COVERAGE_V1 — ШАБЛОН + params, а не склейка. Сообщение уезжает в toast()
// клиента, который переводит его целиком по словарю и только потом подставляет
// значения; собранная на сервере фраза не нашлась бы в словаре ни на одном
// языке. Тот же приём, что у service_save и calendar_book.
function tabError(template, tab, status = 403) {
  const e = new RpcError(template, status);
  e.params = { tab: label(tab) };
  return e;
}

export const DENIED_TEMPLATE = 'Вкладка «{tab}» закрыта для вашей роли.'
  + ' Доступ открывает администратор клиники: «Настройки» → «Роли» → «Карта пациента — вкладки».';

/** Отказ, который НАЗЫВАЕТ вкладку и говорит, к кому идти. */
export function tabDeniedMessage(tab) {
  return DENIED_TEMPLATE.split('{tab}').join(label(tab));
}

function requireCard(db, user) {
  const roles = effectiveRoles(user);
  if (!canViewSection(db, user, SECTION) || !canRead('patients', roles)) {
    throw new RpcError('Раздел «Пациенты» вашей роли не выдан.', 403);
  }
  return roles;
}

function patientId(args) {
  const id = Number(args && args.patient_id);
  if (!Number.isInteger(id) || id <= 0) throw new RpcError('Не указан пациент.', 400);
  return id;
}

// SELECT только по колонкам реестра: обработчик не может отдать больше, чем
// отдаёт /api/db той же роли.
const cols = (t, alias) => readableColumns(t).map((c) => alias + '."' + c + '"').join(', ');
const pick = (row, list) => { const out = {}; for (const c of list) out[c] = row[c] ?? null; return out; };

// «Деталь» закрыта → карта всё равно должна знать, ЧЬЯ она: имя, номер карты и
// пол показывает уже СПИСОК пациентов, из которого человек сюда и пришёл.
// Всё остальное — адрес, паспорт, почта, страховка, контакты, заметки — это
// содержимое закрытой вкладки, и его здесь нет.
// Телефон здесь тоже: он стоит в СПИСКЕ пациентов и в поиске, то есть закрытая
// «Деталь» его всё равно не спрятала бы, а без него нельзя записать визит с
// карты (мастер визита передаёт его дальше).
const IDENTITY_COLUMNS = Object.freeze([
  'id', 'mrn', 'full_name', 'first_name', 'last_name', 'middle_name',
  'gender', 'date_of_birth', 'phone', 'branch_id', 'active', 'registration_date',
]);

const inClause = (n) => Array(n).fill('?').join(',');

// ---------------------------------------------------------------------------
// PATIENT_FILE_ATTACH_V1 — ФАЙЛЫ ПАЦИЕНТА.
//
// ГДЕ ОНИ ЛЕЖАТ. <dataDir>/storage/clinic-docs/patients/<id>/docs/<ключ>, то
// есть внутри той же папки данных, что и easymed.db, — на компьютере клиники и
// нигде больше. Это оффлайн-продукт: облачного ведра нет и не будет.
//
// ИМЯ НА ДИСКЕ ОБЕЗЛИЧЕНО (<время>-<случайное>-<обеззараженное имя>): имя,
// которое дал файлу человек, живёт в БАЗЕ (file_name) и показывается в карте,
// а на диске стоит ключ, который нельзя угадать и который не столкнётся со
// вторым файлом того же имени.
//
// ЧТО СЧИТАЕТСЯ ПУТЁМ ДОКУМЕНТА ЭТОГО ПАЦИЕНТА. Ровно `patients/<id>/docs/<имя>`
// — та же форма, которую отдельно проверяет routes/storage.js. Проверяется
// ЗДЕСЬ ТОЖЕ, потому что строка в базе — это то, по чему файл потом читают:
// пустив в file_path чужой путь, можно было бы приделать к своему пациенту
// чужой скан.
const DOC_PREFIX = (patientId) => 'patients/' + patientId + '/docs/';

const storageRoot = () => path.join(getDataDir(), 'storage', 'clinic-docs');

/**
 * Лежит ли файл на ЭТОМ компьютере. Пустой file_path (заключение из кабинета
 * врача — оно в body, не в файле) считается «вопрос не про файл» и не
 * помечается недоступным.
 */
function fileOnThisMachine(filePath) {
  if (!filePath) return true;
  const rel = String(filePath);
  if (rel.includes('..') || rel.includes('\\') || rel.includes('\0')) return false;
  const abs = path.resolve(storageRoot(), ...rel.split('/').filter(Boolean));
  const root = path.resolve(storageRoot());
  if (abs !== root && !abs.startsWith(root + path.sep)) return false;
  try { return fs.statSync(abs).isFile(); } catch { return false; }
}

function parseJson(v) {
  if (v == null || typeof v !== 'string') return v ?? null;
  try { return JSON.parse(v); } catch { return v; }
}

/**
 * Всё содержимое карты пациента одним ответом — по вкладкам, которые роли
 * выданы. Закрытая вкладка приходит как null, а её уровень — в `tabs`, чтобы
 * экран мог ОБЪЯСНИТЬ отказ, а не молча недосчитаться вкладки.
 */
export function patientCard(db, args, user) {
  const roles = requireCard(db, user);
  const id = patientId(args);

  const tabs = {};
  for (const t of PATIENT_CARD_TABS) tabs[t] = patientTabLevel(db, user, t);

  const full = db.prepare('SELECT ' + cols('patients', 'p') + ' FROM patients p WHERE p.id = ?').get(id);
  if (!full) throw new RpcError('Пациент не найден.', 404);

  const seeDetails = tabs.details !== 'none';
  const out = {
    tabs,
    caps: PATIENT_TAB_CAPS,
    patient: seeDetails ? full : pick(full, IDENTITY_COLUMNS),
    patient_limited: !seeDetails,
    payer_name: null,
    visits: null, services: null, lab_orders: null, lab_results: null,
    invoices: null, invoice_items: null, payments: null,
    docs: null, doc_notes: null,
    visit_count: null, last_visit_date: null,
  };

  if (seeDetails && full.payer_id != null && canRead('payers', roles)) {
    const row = db.prepare('SELECT name FROM payers WHERE id = ?').get(full.payer_id);
    out.payer_name = (row && row.name) || null;
  }

  // Визиты пациента нужны СЕРВЕРУ для всех остальных вкладок (услуги и
  // документы живут под визитом), поэтому читаются всегда — а ОТДАЮТСЯ только
  // если вкладка «Визиты» выдана.
  const visitRows = canRead('visits', roles)
    ? db.prepare('SELECT ' + cols('visits', 'v') + ', du.full_name AS _doctor_name,'
        + ' pp.full_name AS _p_name, pp.mrn AS _p_mrn, pp.phone AS _p_phone'
        + ' FROM visits v'
        + ' LEFT JOIN users du ON du.id = v.doctor_id'
        + ' LEFT JOIN patients pp ON pp.id = v.patient_id'
        + ' WHERE v.patient_id = ? ORDER BY v.visit_date DESC LIMIT 200').all(id)
    : [];
  const visitIds = visitRows.map((v) => v.id);
  const visitDate = new Map(visitRows.map((v) => [v.id, v.visit_date]));

  if (tabs.visits !== 'none') {
    out.visits = visitRows.map((v) => {
      const { _doctor_name, _p_name, _p_mrn, _p_phone, ...rest } = v;
      return {
        ...rest,
        doctor: v.doctor_id ? { id: v.doctor_id, full_name: _doctor_name } : null,
        patients: { id: v.patient_id, full_name: _p_name, mrn: _p_mrn, phone: _p_phone },
      };
    });
    out.visit_count = out.visits.length;
    out.last_visit_date = out.visits.length ? out.visits[0].visit_date : null;
  }

  // Строки услуг читают ТРИ вкладки — «Услуги» (сами строки), «Лаборатория»
  // (к какому заказу относится результат) и «Документы» (подписанные
  // заключения лежат в visit_services.notes).
  const needServices = tabs.services !== 'none' || tabs.labs !== 'none' || tabs.docs !== 'none';
  let vsRows = [];
  if (needServices && visitIds.length && canRead('visit_services', roles)) {
    vsRows = db.prepare('SELECT ' + cols('visit_services', 'vs') + ','
      + ' s.name AS _s_name, s.result_unit AS _s_unit, s.ref_low AS _s_low,'
      + ' s.ref_high AS _s_high, s.is_lab AS _s_is_lab, s.type AS _s_type,'
      + ' du.full_name AS _d_name'
      + ' FROM visit_services vs'
      + ' LEFT JOIN services s ON s.id = vs.service_id'
      + ' LEFT JOIN users du ON du.id = vs.doctor_id'
      + ' WHERE vs.visit_id IN (' + inClause(visitIds.length) + ')').all(...visitIds);
  }
  const shapeVs = (r) => {
    const { _s_name, _s_unit, _s_low, _s_high, _s_is_lab, _s_type, _d_name, ...rest } = r;
    return {
      ...rest,
      visit_date: visitDate.get(r.visit_id) || null,
      services: { name: _s_name, result_unit: _s_unit, ref_low: _s_low, ref_high: _s_high, is_lab: _s_is_lab, type: _s_type },
      users: r.doctor_id ? { full_name: _d_name } : null,
    };
  };

  if (tabs.services !== 'none') out.services = vsRows.map(shapeVs);

  if (tabs.labs !== 'none' && vsRows.length && canRead('lab_results', roles)) {
    const vsIds = vsRows.map((r) => r.id);
    const lr = db.prepare('SELECT ' + cols('lab_results', 'lr') + ' FROM lab_results lr'
      + ' WHERE lr.visit_service_id IN (' + inClause(vsIds.length) + ')').all(...vsIds);
    const withResults = new Set(lr.map((x) => x.visit_service_id));
    out.lab_results = lr;
    // Отдаём ТОЛЬКО те строки услуг, у которых есть результат: вкладка
    // «Лаборатория» — про анализы, а не про весь перечень услуг пациента.
    out.lab_orders = vsRows.filter((r) => withResults.has(r.id)).map(shapeVs);
  }

  if (tabs.billing !== 'none' && canRead('invoices', roles)) {
    const inv = db.prepare('SELECT ' + cols('invoices', 'i') + ' FROM invoices i'
      + ' WHERE i.patient_id = ? ORDER BY i.created_at DESC LIMIT 200').all(id);
    out.invoices = inv;
    const invIds = inv.map((i) => i.id);
    if (invIds.length && canRead('invoice_items', roles)) {
      // Врач строки счёта приезжает вместе со строкой: иначе экрану пришлось бы
      // делать три запроса в обход этой двери.
      out.invoice_items = db.prepare('SELECT ' + cols('invoice_items', 'it')
        + ', s.name AS _s_name, du.full_name AS _doctor_name'
        + ' FROM invoice_items it'
        + ' LEFT JOIN services s ON s.id = it.service_id'
        + ' LEFT JOIN visit_services vs ON vs.invoice_item_id = it.id'
        + ' LEFT JOIN users du ON du.id = vs.doctor_id'
        + ' WHERE it.invoice_id IN (' + inClause(invIds.length) + ') LIMIT 1000').all(...invIds)
        .map((r) => {
          const { _s_name, _doctor_name, ...rest } = r;
          return { ...rest, services: { name: _s_name }, doctor_name: _doctor_name || null };
        });
    }
    if (invIds.length && canRead('payments', roles)) {
      out.payments = db.prepare('SELECT ' + cols('payments', 'pay') + ' FROM payments pay'
        + ' WHERE pay.invoice_id IN (' + inClause(invIds.length) + ') LIMIT 1000').all(...invIds);
    }
  }

  if (tabs.docs !== 'none' && canRead('visit_documents', roles)) {
    // PATIENT_FILE_ATTACH_V1 — к колонкам реестра добавлены свои:
    //   • кто и когда отозвал документ (миграция 105) — карта показывает
    //     отозванные серым, а не прячет: смысл отзыва в том, что запись
    //     остаётся;
    //   • имя того, кто приложил файл — иначе в колонке «Врач» у каждого
    //     загруженного файла стоял бы «—», и спросить «кто это принёс» было
    //     бы не у кого;
    //   • file_available — ЛЕЖИТ ЛИ ФАЙЛ НА ЭТОМ КОМПЬЮТЕРЕ. Ответ считается
    //     здесь, а не в браузере, и он не косметика: файлы не ездят между
    //     зданиями и не попадали в резервную копию до этой работы. Без него
    //     карта показывала бы обычную ссылку, которая молча открывает 404.
    out.docs = db.prepare('SELECT ' + cols('visit_documents', 'd')
      + ', d.voided_at, d.voided_by, d.void_reason'
      + ', au.full_name AS created_by_name, vu.full_name AS voided_by_name'
      + ' FROM visit_documents d'
      + ' LEFT JOIN users au ON au.id = d.created_by'
      + ' LEFT JOIN users vu ON vu.id = d.voided_by'
      + ' WHERE d.patient_id = ? ORDER BY d.created_at DESC LIMIT 300').all(id)
      .map((r) => ({ ...r, body: parseJson(r.body), file_available: fileOnThisMachine(r.file_path) }));
    // Подписанные заключения кабинета врача живут в visit_services.notes.
    out.doc_notes = vsRows
      .filter((r) => r.notes != null && r.notes !== '')
      .map((r) => ({
        id: r.id, notes: r.notes,
        services: { name: r._s_name },
        users: { full_name: r._d_name },
      }));
  }

  return out;
}

// ---------------------------------------------------------------------------
// ЗАПИСЬ. Та же дверь и та же проверка, только уровнем выше: «Редактирование»
// для правки, «Удаление» для удаления. Реестр таблиц проверяется ВТОРЫМ шагом
// (canWrite + writableColumns), чтобы вкладка не могла выдать роли больше, чем
// ей вообще положено: право вкладки СУЖАЕТ, оно ничего не расширяет.
// ---------------------------------------------------------------------------

function requireView(db, user, tab) {
  if (patientTabLevel(db, user, tab) === 'none') throw tabError(DENIED_TEMPLATE, tab);
}

function requireEdit(db, user, tab) {
  requireView(db, user, tab);
  if (!canEditPatientTab(db, user, tab)) {
    throw tabError('У вас доступ «Только просмотр» на вкладке «{tab}».'
      + ' Изменение открывает администратор клиники в «Настройки» → «Роли».', tab);
  }
}

function requireDelete(db, user, tab) {
  requireEdit(db, user, tab);
  if (!PATIENT_TAB_CAPS[tab] || !PATIENT_TAB_CAPS[tab].del) {
    throw tabError('На вкладке «{tab}» удаление не предусмотрено.', tab, 400);
  }
  if (!canDeletePatientTab(db, user, tab)) {
    throw tabError('Удаление на вкладке «{tab}» вашей роли не выдано.'
      + ' Право «Удаление» открывает администратор клиники в «Настройки» → «Роли».', tab);
  }
}

/** Гарды для чужих RPC (index.js): строку услуги правит и удаляет вкладка «Услуги». */
export function requireServicesEdit(db, user)   { requireCard(db, user); requireEdit(db, user, 'services'); }
export function requireServicesDelete(db, user) { requireCard(db, user); requireDelete(db, user, 'services'); }

function assertWrite(table, op, roles) {
  if (!canWrite(table, op, roles)) throw new RpcError('Недостаточно прав для этого действия.', 403);
}

/** Правка анкеты/отметок/плательщика пациента — вкладка «Деталь». */
export function patientCardSavePatient(db, args, user) {
  const roles = requireCard(db, user);
  requireEdit(db, user, 'details');
  const id = patientId(args);
  assertWrite('patients', 'update', roles);

  const allowed = new Set(writableColumns('patients', 'update'));
  const values = (args && args.values && typeof args.values === 'object') ? args.values : {};
  const set = [];
  const params = [];
  for (const [k, v] of Object.entries(values)) {
    if (!allowed.has(k)) continue;
    set.push('"' + k + '" = ?');
    params.push(v === undefined ? null : v);
  }
  if (!set.length) throw new RpcError('Нечего сохранять.', 400);
  params.push(id);
  db.prepare('UPDATE patients SET ' + set.join(', ') + ' WHERE id = ?').run(...params);
  return db.prepare('SELECT ' + cols('patients', 'p') + ' FROM patients p WHERE p.id = ?').get(id);
}

/**
 * Загрузка документа в карту — вкладка «Документы».
 *
 * PATIENT_FILE_ATTACH_V1 — сюда приходит строка ПОСЛЕ того, как байты уже
 * легли в хранилище (POST /api/storage). Поэтому здесь три вещи, которых
 * раньше не было, и каждая закрывает свой способ получить строку, которой
 * нельзя верить:
 *
 *   1. АВТОРА СТАВИТ СЕРВЕР. `created_by` брался из тела запроса, то есть
 *      подписаться под чужим именем можно было одним curl'ом. Кто приложил
 *      файл — это то, ради чего запись вообще ведётся; такое не спрашивают у
 *      клиента. Тот же довод, что у cashier_id в кассе.
 *   2. ФАЙЛ ДОЛЖЕН БЫТЬ ЭТОГО ПАЦИЕНТА И ДОЛЖЕН СУЩЕСТВОВАТЬ. Иначе в карте
 *      появлялась бы строка, которая либо открывает чужой скан, либо не
 *      открывает ничего.
 *   3. ПРЕДЕЛЫ ПРОВЕРЯЮТСЯ ЗАНОВО (размер и тип) — теми же правилами, по
 *      которым отказывает браузер и маршрут хранилища.
 */
export function patientCardAddDocument(db, args, user) {
  const roles = requireCard(db, user);
  requireEdit(db, user, 'docs');
  const id = patientId(args);
  assertWrite('visit_documents', 'insert', roles);

  const allowed = new Set(writableColumns('visit_documents', 'insert'));
  const row = (args && args.row && typeof args.row === 'object') ? args.row : {};

  const filePath = row.file_path == null ? '' : String(row.file_path);
  if (filePath) {
    if (!filePath.startsWith(DOC_PREFIX(id)) || filePath.slice(DOC_PREFIX(id).length).includes('/')) {
      throw new RpcError('Файл не относится к этому пациенту.', 400);
    }
    const bad = patientFileRefusal({ name: row.file_name || filePath, size: row.file_size });
    if (bad) {
      // Код обработчика важнее статусного: по нему экран узнаёт СВОЙ отказ
      // (routes/rpc.js кладёт e.code в ответ как есть).
      const err = new RpcError(refusalText(bad), bad.code === 'file_too_large' ? 413 : 415);
      err.code = bad.code;
      throw err;
    }
    if (!fileOnThisMachine(filePath)) {
      throw new RpcError('Файл не загрузился — попробуйте ещё раз.', 400);
    }
  }

  const keys = ['patient_id'];
  const params = [id];
  for (const [k, v] of Object.entries(row)) {
    // created_by приходит от сервера (ниже), а не из тела запроса.
    if (!allowed.has(k) || k === 'patient_id' || k === 'created_by') continue;
    keys.push(k);
    params.push(v === undefined ? null : (v !== null && typeof v === 'object' ? JSON.stringify(v) : v));
  }
  const uid = user && user.id != null ? Number(user.id) : null;
  keys.push('created_by');
  params.push(Number.isInteger(uid) && uid > 0 ? uid : null);

  const sql = 'INSERT INTO visit_documents (' + keys.map((k) => '"' + k + '"').join(', ') + ')'
    + ' VALUES (' + keys.map(() => '?').join(', ') + ')';
  const info = db.prepare(sql).run(...params);
  return { id: info.lastInsertRowid };
}

/**
 * ОТЗЫВ документа — вкладка «Документы», уровень «Удаление».
 *
 * PATIENT_FILE_ATTACH_V1 — РАНЬШЕ ЭТО БЫЛО НАСТОЯЩЕЕ УДАЛЕНИЕ: строка
 * исчезала из visit_documents, а карта следом звала DELETE /api/storage и
 * стирала файл. Клиническую запись в этом продукте не стирают нигде: отметку
 * медсестры гасит voided_at (093), счёт аннулируется в 'void', результат
 * анализа не удаляется вовсе. Скан направления — такая же запись, и вопрос
 * «а куда делся документ, который вчера был» должен иметь ответ.
 *
 * Поэтому: строка остаётся, помечается voided_at/voided_by/void_reason и
 * перестаёт открываться (routes/storage.js отвечает 410 на файл отозванного
 * документа). Файл на диске НЕ трогаем — отзыв это решение клиники, а не
 * команда уничтожить содержимое.
 *
 * Имя `patientCardDeleteDocument` сохранено: под ним RPC зарегистрирован и
 * его зовут уже установленные у клиник сборки.
 */
export function patientCardDeleteDocument(db, args, user) {
  const roles = requireCard(db, user);
  requireDelete(db, user, 'docs');
  assertWrite('visit_documents', 'delete', roles);
  const docId = Number(args && args.document_id);
  if (!Number.isInteger(docId) || docId <= 0) throw new RpcError('Не указан документ.', 400);
  const row = db.prepare('SELECT id, patient_id, file_path, voided_at FROM visit_documents WHERE id = ?').get(docId);
  if (!row) throw new RpcError('Документ не найден.', 404);
  if (row.voided_at) return { id: docId, voided_at: row.voided_at, already: true };

  const reason = String((args && args.reason) || '').trim().slice(0, 500) || null;
  const uid = user && user.id != null ? Number(user.id) : null;
  db.prepare("UPDATE visit_documents SET voided_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),"
    + ' voided_by = ?, void_reason = ? WHERE id = ?')
    .run(Number.isInteger(uid) && uid > 0 ? uid : null, reason, docId);
  const after = db.prepare('SELECT voided_at FROM visit_documents WHERE id = ?').get(docId);
  return { id: docId, voided_at: after.voided_at, file_path: row.file_path || null };
}

/** Смена врача в строке услуги — вкладка «Услуги». */
export function patientCardSetServiceDoctor(db, args, user) {
  const roles = requireCard(db, user);
  requireEdit(db, user, 'services');
  assertWrite('visit_services', 'update', roles);
  const vsId = Number(args && args.visit_service_id);
  if (!Number.isInteger(vsId) || vsId <= 0) throw new RpcError('Не указана строка услуги.', 400);
  const doctorId = args && args.doctor_id != null && args.doctor_id !== '' ? Number(args.doctor_id) : null;
  db.prepare('UPDATE visit_services SET doctor_id = ? WHERE id = ?').run(doctorId, vsId);
  return { id: vsId, doctor_id: doctorId };
}
