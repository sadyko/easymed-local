import { Router } from 'express';
import { surgeryWithoutBedRefusal } from '../services/domain/surgery-bed.js';   // CASHIER_HEAD_V1 (ревью I4)
import { setLiveColumns, setForeignKeyColumns, compile, CompileError } from '../db/query-compiler.js';
import { readableColumns, MAIN_CLINIC_TABLES, rowScope } from '../db/schema-registry.js';
import { zeroRowRefusal } from '../db/schema-registry.js';   // CABINET_FIX_V1_R1 — 0 строк у шаблонов — отказ, а не 200
import { scopeLifted } from '../db/row-scope.js';   // V3120_FIX — кто назначает заявку CRM другому
// STAFF_SYNC_V1 — «филиал я или сама по себе клиника» решается по базе, а не по
// сборке: одна и та же установка сегодня одиночная, завтра филиал.
import { readIdentity } from '../services/branch-sync/identity.js';
import { COMPANY_CLINIC_WIDE, COMPANY_PARTNER, storedProfileProblems } from '../../public/js/shared/clinic-profile.js';   // CLINIC_PROFILE_V1, BRANCH_PROFILE_V1 (COMPANY_PARTNER)
import { BRANCH_MESSAGES, BRANCH_MAIN_COLUMNS, OWN_FROM_COMPANY, storedBranchProblems, ownBuildingProblems } from '../../public/js/shared/branch-profile.js';   // BRANCH_PROFILE_V1
import { CONSULT_API_KINDS, CONSULT_MESSAGES, consultTypeProblem } from '../../public/js/shared/consultation-price.js';   // DOCTOR_PROFILE_V1
import { keepLegacyLogo } from '../services/clinic-logo-legacy.js';   // CLINIC_PROFILE_V1 (ревью M3)
import { companyAddressRefusal, branchAddressRefusal } from '../services/api/partner-address.js';   // CLINIC_API_STEP7_V1
import { targetBranches } from '../services/branch-targets.js';   // CLINIC_API_STEP7_V1 (ревью слияния №3) — одна на двух стражей
import { lockedResponse } from '../services/control/gate.js';   // LICENCE_CORE_V1
import { recordEvent } from '../services/ops-log.js';   // OPS_EVENTS_V1
import { constraintRefusal, errorBody } from '../services/server-message.js';   // V3120_I18N
import { notesWriteRefusal, storedIsCabinet, NOTES_BASE_KEY, NOTES_CONFLICT_MESSAGE, notesCompatValue } from '../services/domain/cabinet-notes.js';   // CABINET_FIX_V1_R4 · CABINET_FIX_V1_R5 · CABINET_FIX_V1_R6
// CRM_REAL_BOOKING_V1 — статус услуги двигают экраны, и двигают они его через
// эту дверь: работа над пациентом доказывает, что он пришёл.
import { crmServiceEvidence, EVIDENCE_SERVICE_STATUSES } from '../services/crm/visit-status.js';
import { tagInsertRefusal } from '../services/crm/config.js';   // CRM_HEAD_MERGE_TAGS_V1 (ревью M4)
import { crmSourcesWrite, CrmSourcesError } from '../services/crm/sources.js';   // CRM_MULTI_SOURCE_V1
import { roleWriteRefusal } from '../services/role-guard.js';   // ADMIN_ROWS_GRANTABLE_V1
import { packageStampRefusal } from '../services/rpc/billing.js';   // PACKAGES_V1 (ревью I-3)
import { PROXY_MODEL_REQUIRED } from '../services/rpc/lis.js';   // LIS_PROXY_V1 (ревью, Р21)
import { PROXY_MODELS } from '../../public/js/shared/lisproxy-models.js';   // LIS_PROXY_V1 (ревью, Р21)
// CRM_CALENDAR_MIRROR_V1 — строки записи и строки заявки — одна запись.
import { mirrorBefore, mirrorAfter } from '../services/crm/booking-mirror-db.js';
import { taskAssigneeRefusal, canOwnLead, ownerRefusal, rehomeOrphanTasks } from '../services/crm/tasks-follow.js';   // CRM_UNIFY_V1
import { geoCodeRefusal } from '../services/geo-codes-guard.js';   // REFERENCE_LISTS_V1 (полировка) — коды географии не меняются

// The one HTTP door onto the database: every request is compiled through
// the allow-list registry (query-compiler.js) before it touches SQLite.
// Nothing here ever builds SQL text from the request body directly.
// STAR_MEETS_SCHEMA_V1 — настоящие колонки таблиц, спрошенные у самой базы.
// Читаются лениво и запоминаются: PRAGMA на каждый запрос — это лишний поход в
// базу там, где схема не меняется между перезапусками (миграции идут ДО того,
// как поднимутся маршруты).
// EMPTY_ID_IS_NULL_V1 — какие колонки таблицы являются ССЫЛКАМИ на другие
// таблицы. Спрашиваем саму базу: список внешних ключей меняется миграциями, и
// вторая его копия в коде разошлась бы с первой.
function foreignKeyColumnsReader(db) {
    const cache = new Map();
    return (table) => {
        if (cache.has(table)) return cache.get(table);
        let set = null;
        try {
            const rows = db.prepare(`PRAGMA foreign_key_list("${String(table).replace(/"/g, '')}")`).all();
            if (rows && rows.length) set = new Set(rows.map((r) => r.from));
        } catch { set = null; }
        cache.set(table, set);
        return set;
    };
}

function liveColumnsReader(db) {
    const cache = new Map();
    return (table) => {
        if (cache.has(table)) return cache.get(table);
        let set = null;
        try {
            const rows = db.prepare(`PRAGMA table_info("${String(table).replace(/"/g, '')}")`).all();
            if (rows && rows.length) set = new Set(rows.map((r) => r.name));
        } catch { set = null; }
        cache.set(table, set);
        return set;
    };
}


// SURGERY_NEEDS_BED_V1 — вернуть текст отказа или null, если всё в порядке.
//
// Считается по ЛЮБОЙ строке запроса: одним вызовом можно добавить несколько
// услуг, и достаточно одной хирургической без койки, чтобы отказать целиком —
// иначе половина списка молча осела бы в базе.
//
// Госпитализация ищется по ПАЦИЕНТУ визита, а не по самому визиту: операцию
// заводят и на визит-осмотр, оформленный отдельно от лежания, и он к
// admissions не привязан. Открытой считается запись без даты выписки.
function refuseSurgeryWithoutBed(db, meta, body) {
  if (!meta || meta.table !== 'visit_services') return null;
  if (meta.op !== 'insert' && meta.op !== 'upsert' && meta.op !== 'update') return null;

  const rows = Array.isArray(body && body.values) ? body.values
    : (body && body.values ? [body.values] : []);
  // CASHIER_HEAD_V1 (ревью I4) — само правило теперь одно на все двери
  // (services/domain/surgery-bed.js): им же пользуется касса.
  for (const row of rows) {
    const serviceId = row && (row.service_id ?? row.serviceId);
    const visitId = row && (row.visit_id ?? row.visitId);
    const refusal = surgeryWithoutBedRefusal(db, serviceId, visitId);
    if (refusal) return refusal;
  }
  return null;
}

// LIS_PROXY_V1 (ревью, Р21; решение владельца 2026-10-09, п. 6) — прибор за LIS
// Proxy — только BS-200, BC-780 или AutoLumo A1000. «Добавить» (RPC
// lis_device_add) это требует; здесь — та же стена у правки через /api/db: иначе
// строке прокси ставилась любая модель или пустая. Задета хоть одна строка
// прокси — отказ целиком (пачка не делится). Строки своего порта — как прежде.
function refuseProxyModelWrite(db, meta, body, user) {
  if (!meta || meta.table !== 'lab_devices' || (meta.op !== 'update' && meta.op !== 'upsert')) return null;
  const rows = Array.isArray(body && body.values) ? body.values : (body && body.values ? [body.values] : []);
  const offModel = rows.some((r) => r && Object.prototype.hasOwnProperty.call(r, 'profile') && !PROXY_MODELS.includes(r.profile));
  if (!offModel) return null;
  let proxy = false;
  try {
    const sel = compile({ table: body.table, op: 'select', columns: 'id,via', filters: body.filters }, user, { db });
    proxy = db.prepare(sel.sql).all(...sel.params).some((r) => r.via === 'lisproxy');
  } catch { proxy = false; }
  return proxy ? PROXY_MODEL_REQUIRED : null;
}

// PACKAGES_V1 (ревью I-3) — текст отказа или null. Вставка: пакет строки
// проверяется по местному дню её визита (то же правило, что у счёта —
// billing.js linePackage). Правка: package_id только снимается (реестр,
// onlyValues), и только со строки вне счёта.
function refusePackageWrite(db, meta, body, user) {
  if (!meta || meta.table !== 'visit_services') return null;
  const rows = Array.isArray(body && body.values) ? body.values
    : (body && body.values ? [body.values] : []);
  if (meta.op === 'insert' || meta.op === 'upsert') return packageStampRefusal(db, rows);
  if (meta.op === 'update' && rows.some((r) => r && Object.prototype.hasOwnProperty.call(r, 'package_id'))) {
    let invoiced = false;
    try {
      const sel = compile({ table: body.table, op: 'select', columns: 'id,invoice_item_id', filters: body.filters }, user, { db });
      invoiced = db.prepare(sel.sql).all(...sel.params).some((r) => r.invoice_item_id != null);
    } catch { invoiced = false; }
    if (invoiced) {
      return 'Строка уже в счёте: скидку пакета в нём меняют через счёт — замените или уберите услугу в карточке пациента.';
    }
  }
  return null;
}

// INPATIENT_MONEY_FIX_V1 (D7) — текст отказа или null для правки и удаления
// строк стационара табличным путём (admission_services).
//
// Реестр уже не даёт писать деньги строки (invoice_item_id, status, цена) и
// заводить её. Остаются «в счёт / в учёт» (billable), примечание и «Убрать» —
// и они проверяются ПО СТРОКЕ, до выполнения:
//   • выставленная строка (invoice_item_id) не трогается вовсе — за ней счёт,
//     и снимают её со счёта в кассе (remove_admission_line_from_invoice);
//   • удаление товарной строки — только возвратом (void_dispensed_admission_item):
//     DELETE мимо него оставлял выданный товар списанным навсегда;
//   • удалять строки закрытой госпитализации нельзя — её деньги уже итог.
// Строки выбираются тем же compile(), что и сама правка: те же права, тот же
// отбор, так что проверяется ровно то, что было бы изменено.
function refuseAdmissionLineWrite(db, meta, body, user) {
  if (!meta || meta.table !== 'admission_services') return null;
  if (meta.op !== 'update' && meta.op !== 'delete') return null;
  let rows = [];
  try {
    const sel = compile({ table: body.table, op: 'select', columns: 'id,invoice_item_id,clinic_item_id,admission_id', filters: body.filters }, user, { db });
    rows = db.prepare(sel.sql).all(...sel.params);
  } catch { return 'Строки госпитализации не выбраны — правка не выполнена.'; }
  const status = db.prepare('SELECT status FROM admissions WHERE id = ?');
  for (const r of rows) {
    if (r.invoice_item_id != null) {
      return 'Строка уже в счёте — сначала уберите её из счёта (кнопка «Из счёта» или касса).';
    }
    if (meta.op !== 'delete') continue;
    if (r.clinic_item_id != null) {
      return 'Это выданный товар — уберите его кнопкой «Убрать»: товар вернётся туда, откуда его взяли.';
    }
    const adm = status.get(r.admission_id);
    if (adm && (adm.status === 'discharged' || adm.status === 'cancelled')) {
      return 'Госпитализация закрыта — её строки больше не удаляют.';
    }
  }
  return null;
}

// V3120_FINAL (S2) — текст отказа или null для строк ВИЗИТА табличным путём.
//
// Реестр пускает администратора и регистратуру удалять строки визита, и
// удаление шло мимо денег и склада: выданный товар (clinic_item_id) исчезал
// без возврата — движение склада оставалось висеть расходом без строки, — а
// строка оплаченного счёта уходила, оставляя позицию счёта без услуги. Теперь:
//   • строку в счёте (invoice_item_id) не удаляют и вид приёма у неё не
//     меняют — снимают её касса (отмена позиции / возврат строкой);
//   • выданный товар убирают кнопкой «Убрать» (void_dispensed_visit_item):
//     товар возвращается туда, откуда взят;
//   • строку без услуги, без товара и без вида приёма («свободная цена») не
//     заводят: у неё нет каталожной цены, и сумму задавал бы браузер.
//     Администратор — исключение (исправление вручную), как и в остальном.
// Строки выбираются тем же compile(), что и сама правка (те же права и отбор).
function refuseVisitLineWrite(db, meta, body, user) {
  if (!meta || meta.table !== 'visit_services') return null;
  if (meta.op === 'insert' || meta.op === 'upsert') {
    const roles = [user && user.role, ...((user && user.extra_roles) || [])];
    if (roles.includes('admin')) return null;
    const rows = Array.isArray(body && body.values) ? body.values : (body && body.values ? [body.values] : []);
    const bare = rows.some((r) => r && r.service_id == null && r.consultation_type_id == null && r.clinic_item_id == null);
    return bare ? 'Строка визита без услуги и без вида приёма не заводится — выберите услугу из каталога.' : null;
  }
  if (meta.op !== 'update' && meta.op !== 'delete') return null;
  const values = body && body.values && !Array.isArray(body.values) ? body.values : {};
  if (meta.op === 'update' && !Object.prototype.hasOwnProperty.call(values, 'consultation_type_id')) return null;
  let rows = [];
  try {
    const sel = compile({ table: body.table, op: 'select', columns: 'id,invoice_item_id,clinic_item_id', filters: body.filters }, user, { db });
    rows = db.prepare(sel.sql).all(...sel.params);
  } catch { return 'Строки визита не выбраны — правка не выполнена.'; }
  for (const r of rows) {
    if (meta.op === 'delete' && r.clinic_item_id != null && r.invoice_item_id == null) {
      return 'Это выданный товар — уберите его кнопкой «Убрать»: товар вернётся туда, откуда его взяли.';
    }
    if (r.invoice_item_id != null) {
      return meta.op === 'delete'
        ? 'Строка уже в счёте — снимают её в кассе (отмена позиции или возврат), а не удалением.'
        : 'Строка уже в счёте — вид приёма у неё не меняют: замените услугу через счёт.';
    }
  }
  return null;
}

// CABINET_FIX_V1_R4 (ревью 4, п. 2) · CABINET_FIX_V1_R5 (ревью 5, A) — ЗАПИСИ КАБИНЕТА   // CABINET_FIX_V1_R5
// ВРАЧА — «СРАВНИТЬ И ЗАМЕНИТЬ» (правило — public/js/shared/cabinet-notes.js).   // CABINET_FIX_V1_R5
// Запись notes строки, у которой лежит JSON кабинета, обязана нести основу   // CABINET_FIX_V1_R5
// (__notes_base — отпечаток notes, с которых её сделали), совпавшую с тем, что   // CABINET_FIX_V1_R5
// лежит, быть JSON кабинета и сохранить все подписанные версии; иначе — 409.   // CABINET_FIX_V1_R5
// Сохранённые notes читаются ПРОСТЫМ чтением сервера (без отбора прав): отказ   // CABINET_FIX_V1_R5
// чтения не должен открывать дверь. Правка нескольких строк сразу, затрагивающая   // CABINET_FIX_V1_R5
// записи кабинета, — отказ; не прочитать строки такой правки — отказ.   // CABINET_FIX_V1_R5
function takeNotesBase(body) {   // CABINET_FIX_V1_R5
  const v = body && body.values;   // CABINET_FIX_V1_R5
  const rows = Array.isArray(v) ? v : (v && typeof v === 'object' ? [v] : []);   // CABINET_FIX_V1_R5
  let base = null;   // CABINET_FIX_V1_R5
  for (const r of rows) {   // CABINET_FIX_V1_R5
    if (r && Object.prototype.hasOwnProperty.call(r, NOTES_BASE_KEY)) {   // CABINET_FIX_V1_R5
      if (typeof r[NOTES_BASE_KEY] === 'string') base = r[NOTES_BASE_KEY];   // CABINET_FIX_V1_R5
      delete r[NOTES_BASE_KEY];   // CABINET_FIX_V1_R5
    }   // CABINET_FIX_V1_R5
  }   // CABINET_FIX_V1_R5
  return base;   // CABINET_FIX_V1_R5
}   // CABINET_FIX_V1_R5
// CABINET_FIX_V1_R6 — out.rewrite: запись одной строки без основы (вкладка 3.15.0),   // CABINET_FIX_V1_R6
// к которой сервер добавляет сохранённую заметку медсестры (notesCompatValue).   // CABINET_FIX_V1_R6
export function refuseNotesWrite(db, meta, body, user, base, out = null) {   // CABINET_FIX_V1_R5 — экспорт для проверки · CABINET_FIX_V1_R6
  if (!meta || meta.table !== 'visit_services' || (meta.op !== 'update' && meta.op !== 'upsert')) return null;   // CABINET_FIX_V1_R5
  const values = body && body.values && !Array.isArray(body.values) ? body.values : null;   // CABINET_FIX_V1_R5
  if (!values || !Object.prototype.hasOwnProperty.call(values, 'notes')) return null;   // CABINET_FIX_V1_R5
  const byId = db.prepare('SELECT id, notes FROM visit_services WHERE id = ?');   // CABINET_FIX_V1_R5
  const f = Array.isArray(body.filters) ? body.filters : [];   // CABINET_FIX_V1_R5
  let rows = [];   // CABINET_FIX_V1_R5
  if (meta.op === 'upsert') {   // CABINET_FIX_V1_R5
    if (values.id != null) rows = byId.all(values.id);   // CABINET_FIX_V1_R5
  } else if (f.length === 1 && f[0] && f[0].col === 'id' && f[0].op === 'eq') {   // CABINET_FIX_V1_R5
    rows = byId.all(f[0].val);   // CABINET_FIX_V1_R5
  } else {   // CABINET_FIX_V1_R5
    try {   // CABINET_FIX_V1_R5
      const sel = compile({ table: body.table, op: 'select', columns: 'id', filters: body.filters }, user, { db });   // CABINET_FIX_V1_R5
      rows = db.prepare(sel.sql).all(...sel.params).map((r) => byId.get(r.id)).filter(Boolean);   // CABINET_FIX_V1_R5
    } catch { return { reason: 'unread', message: 'Записи строки не прочитаны — правка не выполнена.' }; }   // CABINET_FIX_V1_R5
    if (rows.length > 1 && rows.some((r) => storedIsCabinet(r.notes))) return { reason: 'multi', message: NOTES_CONFLICT_MESSAGE };   // CABINET_FIX_V1_R5
  }   // CABINET_FIX_V1_R5
  for (const r of rows) {   // CABINET_FIX_V1_R5
    const refusal = notesWriteRefusal(r.notes, values.notes, base);   // CABINET_FIX_V1_R5
    if (refusal) return refusal;   // CABINET_FIX_V1_R5
  }   // CABINET_FIX_V1_R5
  if (out && rows.length === 1) {   // CABINET_FIX_V1_R6 — совместимость, убрать вместе с правилом «без основы»
    const v = notesCompatValue(rows[0].notes, values.notes, base);   // CABINET_FIX_V1_R6
    if (v != null) out.rewrite = v;   // CABINET_FIX_V1_R6
  }   // CABINET_FIX_V1_R6
  return null;   // CABINET_FIX_V1_R5
}   // CABINET_FIX_V1_R5

/**
 * CRM_REAL_BOOKING_V1 — РАБОТА НАД ПАЦИЕНТОМ ДОКАЗЫВАЕТ, ЧТО ОН ПРИШЁЛ.
 *
 * Статус услуги двигают ЧЕТЫРЕ экрана (кабинет врача, лаборатория, процедуры,
 * счёт визита), и двигают они его отсюда: колонка `status` открыта на правку в
 * реестре (schema-registry, visit_services.update). Поэтому правило стоит в
 * единственной двери /api/db — ровно по той же причине, по которой здесь стоит
 * запрет хирургии без койки: проверка в одном экране означала бы правило,
 * которое соблюдают три экрана из четырёх.
 *
 * Строки выбираются ДО правки: фильтр запроса часто сам ссылается на статус
 * («всем, кто ещё не in_progress»), и после UPDATE он не нашёл бы ничего. Тем
 * же compile(), то есть с теми же правами и тем же отбором по роли.
 *
 * Пустой список — обычный случай, и он ничего не стоит: ни одного запроса в
 * базу, пока в правке нет доказательного статуса.
 */
function crmEvidenceTargets(db, meta, body, user) {
  if (!meta || meta.table !== 'visit_services' || meta.op !== 'update') return [];
  if (!hasEvidenceStatus(body)) return [];
  try {
    const sel = compile({ table: body.table, op: 'select', columns: 'id', filters: body.filters }, user, { db });
    return db.prepare(sel.sql).all(...sel.params).map((r) => r.id);
  } catch { return []; }   // отбор не сложился — заявке это не повод падать
}

/** Несёт ли запрос статус, который человек ставит, только работая с пациентом. */
function hasEvidenceStatus(body) {
  const status = body && body.values && body.values.status;
  return !!status && EVIDENCE_SERVICE_STATUSES.includes(String(status));
}

// CLINIC_PROFILE_V1 (ревью M3) — storageDir: хранилище файлов (<dataDir>/storage),
// куда ложится копия прежнего логотипа перед его заменой. app.js передаёт его
// всегда; без него (юнит-монтирование маршрута) защита не включается.
export function dbRoutes(db, { storageDir = null } = {}) {
    setLiveColumns(liveColumnsReader(db));
    setForeignKeyColumns(foreignKeyColumnsReader(db));
  const r = Router();

  r.post('/', (req, res) => {
    // CABINET_FIX_V1_R5 — основа записи записей кабинета — не колонка: снимается до compile().
    const notesBase = takeNotesBase(req.body);   // CABINET_FIX_V1_R5
    let compiled;
    try {
      compiled = compile(req.body || {}, req.user, { db });   // CRM_HEAD_MERGE_TAGS_V1 — база нужна праву «crm.all»
    } catch (e) {
      if (e instanceof CompileError) {
        const status = e.status || 400;
        return res.status(status).json({ error: errorBody(status === 403 ? 'forbidden' : 'bad_request', e) });   // V3120_I18N — с шаблоном, если он есть
      }
      throw e;
    }

    // LICENCE_CORE_V1 — a lapsed clinic reads its own records freely and changes
    // nothing. Placed after compile() so we know the operation, and before
    // execution so nothing has touched the database yet.
    if (req.control?.locked && compiled.meta.op !== 'select') return lockedResponse(res, req.control);

    // STAFF_SYNC_V1 (ревью Фазы 3, I3) — ТАБЛИЦЫ ГЛАВНОЙ КЛИНИКИ В ФИЛИАЛЕ
    // ТОЛЬКО ДЛЯ ЧТЕНИЯ.
    //
    // role_permissions приезжает по каналу справочника (catalogue.js, migration
    // 086), и правка, сделанная в филиале, молча откатывается ближайшей
    // синхронизацией — через час, без единого сообщения. Ровно этот призрак и
    // закрывает 409 в routes/users.js для сотрудников; здесь тот же ответ для
    // прав ролей.
    //
    // Стоит ЗДЕСЬ, а не в реестре: реестр статичен и роль установки ему не
    // видна (см. MAIN_CLINIC_TABLES в schema-registry.js). И стоит ПОСЛЕ
    // compile() — так известна и таблица, и операция, — но ДО выполнения:
    // база ещё не тронута.
    //
    // ЧИТАТЬ по-прежнему можно всем: экран «Роли» в филиале обязан показывать
    // то, что реально действует, а не пустоту.
    const managed = MAIN_CLINIC_TABLES[compiled.meta.table];
    if (managed && compiled.meta.op !== 'select' && isSecondary(db)) {
      // 409, а не 403, и той же формы, что у routes/users.js: запрос
      // правильный, и права у администратора есть — не даёт устройство самой
      // клиники.
      return res.status(409).json({ error: { code: 'conflict', message: managed } });
    }

    // CLINIC_PROFILE_V1 — «КОМПАНИЯ» В ФИЛИАЛЕ: общее для клиники (название,
    // описание, логотипы, сайт и соцсети, лицензия, цвет) приходит из главного
    // здания (branch-sync/catalogue.js), и правка здесь откатилась бы ближайшей
    // синхронизацией — тот же призрак, что закрывает 409 выше. Отказ — только
    // если общее поле МЕНЯЕТСЯ: экран, приславший название как было, сохраняет
    // адрес и телефон своего здания.
    const companyRefusal = companyBranchRefusal(db, compiled.meta, req.body);
    if (companyRefusal) return res.status(409).json({ error: { code: 'conflict', message: companyRefusal } });

    // REFERENCE_LISTS_V1 (полировка, 2026-10-10) — КОДЫ ГЕОГРАФИИ КЛИНИКА НЕ
    // МЕНЯЕТ: партнёры получают коды страны, города и района. Код строки не
    // меняется и не стирается, строка бланка не удаляется (её выключают), новый
    // код не повторяет занятый. Названия и «активна» — как прежде
    // (services/geo-codes-guard.js).
    const geoRefusal = geoCodeRefusal(db, compiled.meta, req.body, req.user);
    if (geoRefusal) return res.status(409).json({ error: { code: 'conflict', message: geoRefusal } });

    // CLINIC_PROFILE_V1 (ревью I2) — ФОРМАТ ПРОФИЛЯ КЛИНИКИ. CHECK миграции 240
    // — запасной замок, и он пропускал «..» в пути логотипа, разметку в адресе
    // сайта и чужой хост карты. Здесь — те же строгие правила, что у экрана
    // (shared/clinic-profile.js storedProfileProblems), до того как база
    // тронута; отказ — первым объяснением, тем же, что видно под полем.
    const profileRefusal = companyProfileRefusal(compiled.meta, req.body);
    if (profileRefusal) return res.status(400).json({ error: { code: 'bad_request', message: profileRefusal.message, field: profileRefusal.field } });
    // CLINIC_API_STEP7_V1 — решение владельца 11: пока включено подключение API,
    // «Компания» без адреса для партнёров не сохраняется (поле — то, что
    // подсветит экран).
    const addressRefusal = companyAddressRefusal(db, compiled.meta, req.body);
    if (addressRefusal) {
      return res.status(400).json({ error: { code: 'partner_address_required', message: addressRefusal.message, field: addressRefusal.field } });
    }

    // BRANCH_PROFILE_V1 — «ФИЛИАЛЫ»: КТО ЧТО ПРАВИТ (shared/branch-profile.js).
    //   • филиал: название, телефон, профиль, часы, показ на сайте любого здания
    //     приходят из главного (catalogue.js roster) — правка здесь откатилась
    //     бы синхронизацией, тот же призрак, что закрывает 409 выше; новое
    //     здание заводит главное;
    //   • главное: адрес для партнёров, карта и телефон СВОЕГО здания живут в
    //     «Компании» (одно место на здание) — в строке branches их не правят.
    // Отказ — только если значение МЕНЯЕТСЯ: экран, приславший неизменённое,
    // сохраняет своё.
    const branchRefusal = branchWriteRefusal(db, compiled.meta, req.body);
    if (branchRefusal) return res.status(409).json({ error: { code: 'conflict', message: branchRefusal } });
    // BRANCH_PROFILE_V1 — формат: карта, часы, отметки, коды — те же правила, что у экрана.
    const branchFormat = branchFormatRefusal(compiled.meta, req.body);
    if (branchFormat) return res.status(400).json({ error: { code: 'bad_request', message: branchFormat.message, field: branchFormat.field } });
    // DOCTOR_PROFILE_V1 — «Виды консультаций»: длительность приёма и вид для
    // партнёров — те же правила, что у экрана (shared/consultation-price.js);
    // одно значение «для партнёров» — у одного вида (UNIQUE мигр. 243 — запасной замок).
    const consultFormat = consultTypeFormatRefusal(compiled.meta, req.body);
    if (consultFormat) return res.status(400).json({ error: { code: 'bad_request', message: consultFormat.message, field: consultFormat.field } });
    const consultKind = consultKindRefusal(db, compiled.meta, req.body);
    if (consultKind) return res.status(409).json({ error: { code: 'conflict', message: consultKind, field: 'api_kind' } });
    // CLINIC_API_STEP7_V1 — решение владельца 11 по зданиям: пока включено
    // подключение API, филиал, показанный на сайте (работает и «Показывать на
    // сайте»), без полного адреса для партнёров не сохраняется, и отметку у
    // такого филиала не включить (services/api/partner-address.js).
    const branchAddress = branchAddressRefusal(db, compiled.meta, req.body);
    if (branchAddress) {
      return res.status(400).json({ error: { code: 'partner_address_required', message: branchAddress.message, field: branchAddress.field } });
    }

    // CLINIC_PROFILE_V1 (ревью M3) — ПРЕЖНИЙ ЛОГОТИП НЕ ЗАТИРАЕТСЯ НЕСКОПИРОВАННЫМ.
    // Копия при запуске (index.js → clinic-logo-legacy.js) могла не лечь, а
    // правка, которая заменяет или снимает прежний логотип, уничтожила бы
    // единственный экземпляр. Поэтому копия кладётся ещё раз здесь, до
    // записи; не легла — отказ 409, логотип остаётся на бланках.
    if (legacyLogoAtRisk(db, compiled.meta, req.body, storageDir)) {
      return res.status(409).json({ error: { code: 'legacy_logo_not_saved', message: LEGACY_LOGO_NOT_SAVED } });
    }

    // ADMIN_ROWS_GRANTABLE_V1 — «Роли: Изменение» у не-администратора: ни роли
    // администратора, ни своих ролей, ни прав выше собственных. Компилятор уже
    // пустил запись по ключу плитки; содержание записи проверяется здесь, до
    // выполнения (services/role-guard.js).
    const roleRefusal = roleWriteRefusal(db, req.user, compiled.meta, req.body);
    if (roleRefusal) return res.status(403).json({ error: { code: 'forbidden', message: roleRefusal } });

    // SURGERY_NEEDS_BED_V1 — операция оформляется НА ГОСПИТАЛИЗАЦИЮ.
    //
    // Владелец: «the surgery is bundled so it goes with the hospitalization —
    // which means only in bed located patients service bill created».
    //
    // Стоит ЗДЕСЬ, в единственной двери /api/db, а не в окне добавления
    // услуги: строку visit_services заводят ЧЕТЫРЕ разных экрана (кабинет
    // врача, счёт визита, окно визита в двух местах). Проверка в одном из них
    // означала бы правило, которое соблюдают три экрана из четырёх, — а
    // необходимость правила как раз денежная.
    // CRM_HEAD_MERGE_TAGS_V1 (ревью M4) — метку на заявку ставят только
    // существующую и видимую: скрытую экран не предлагает, а несуществующую
    // внешний ключ отверг бы голой ошибкой базы.
    // V3120_FIX — заявку CRM «на другого» назначают только те, кто видит всю
    // доску (администратор, руководитель колл-центра — crm.all). Оператор
    // берёт заявку себе или отпускает её в общую стопку (NULL).
    const assignRefusal = crmAssignRefusal(db, compiled.meta, req.body, req.user);
    if (assignRefusal) return res.status(403).json({ error: { code: 'forbidden', message: assignRefusal } });
    // CRM_UNIFY_V1 — ответственный за задачу обязан видеть её карточку (crm/tasks-follow.js).
    const taskRefusal = taskAssigneeRefusal(db, compiled.meta, req.body, req.user);
    if (taskRefusal) return res.status(403).json({ error: { code: 'forbidden', message: taskRefusal } });
    // CRM_MULTI_SOURCE_V1 — источники заявки: сервер проверяет `sources` и сам
    // ставит главный `source = sources[0]`; запись одного `source` сбрасывает
    // `sources` в [source]. Тело правится на месте и собирается заново тем же
    // compile() — те же права и отбор. Кривой `sources` — 400 словами.
    try {
      if (crmSourcesWrite(db, compiled.meta, req.body, req.user)) compiled = compile(req.body, req.user, { db });   // CRM_MULTI_SOURCE_V1
    } catch (e) {
      if (e instanceof CrmSourcesError) return res.status(400).json({ error: errorBody('bad_request', e) });   // CRM_MULTI_SOURCE_V1
      throw e;
    }
    if (compiled.meta.table === 'crm_request_tags' && compiled.meta.op === 'insert') {
      const tagRefusal = tagInsertRefusal(db, req.body && req.body.values);
      if (tagRefusal) return res.status(400).json({ error: { code: 'bad_request', message: tagRefusal } });
    }
    const surgeryRefusal = refuseSurgeryWithoutBed(db, compiled.meta, req.body);
    if (surgeryRefusal) {
      return res.status(409).json({ error: { code: 'conflict', message: surgeryRefusal } });
    }
    // PACKAGES_V1 (ревью I-3) — пакет вне срока визита отказывается В МИГ, когда
    // его ставят на строку, а не у кассы, когда счёт уже не выставить.
    // Снять пакет правкой (package_id = NULL) можно только со строки, ещё не
    // попавшей в счёт: у выставленной скидка уже записана в позиции счёта, и
    // правится она через счёт (замена / удаление строки в карточке пациента).
    const packageRefusal = refusePackageWrite(db, compiled.meta, req.body, req.user);
    if (packageRefusal) {
      return res.status(409).json({ error: { code: 'conflict', message: packageRefusal } });
    }
    // LIS_PROXY_V1 (ревью, Р21) — модель прибора за LIS Proxy: см. refuseProxyModelWrite.
    const proxyModelRefusal = refuseProxyModelWrite(db, compiled.meta, req.body, req.user);
    if (proxyModelRefusal) {
      return res.status(409).json({ error: { code: 'proxy_model_required', message: proxyModelRefusal } });   // код — как у RPC lis_device_add
    }
    // INPATIENT_MONEY_FIX_V1 (D7) — строки стационара: см. refuseAdmissionLineWrite.
    const admLineRefusal = refuseAdmissionLineWrite(db, compiled.meta, req.body, req.user);
    if (admLineRefusal) {
      return res.status(409).json({ error: { code: 'conflict', message: admLineRefusal } });
    }
    // V3120_FINAL (S2) — строки визита: см. refuseVisitLineWrite.
    const visitLineRefusal = refuseVisitLineWrite(db, compiled.meta, req.body, req.user);
    if (visitLineRefusal) {
      return res.status(409).json({ error: { code: 'conflict', message: visitLineRefusal } });
    }
    const notesOut = {};   // CABINET_FIX_V1_R6
    const notesRefusal = refuseNotesWrite(db, compiled.meta, req.body, req.user, notesBase, notesOut);   // CABINET_FIX_V1_R4 · CABINET_FIX_V1_R5 · CABINET_FIX_V1_R6
    if (notesRefusal) return res.status(409).json({ error: { code: 'notes_conflict', reason: notesRefusal.reason, message: notesRefusal.message } });   // CABINET_FIX_V1_R5
    // CABINET_FIX_V1_R6 — СОВМЕСТИМОСТЬ (убрать в следующем выпуске): вкладка 3.15.0 пишет   // CABINET_FIX_V1_R6
    // записи без заметки медсестры — сохранённая заметка добавляется, правка собирается заново   // CABINET_FIX_V1_R6
    // (тот же синхронный путь: между чтением и записью ничего не вклинится).   // CABINET_FIX_V1_R6
    if (notesOut.rewrite != null) {   // CABINET_FIX_V1_R6
      req.body.values.notes = notesOut.rewrite;   // CABINET_FIX_V1_R6
      compiled = compile(req.body, req.user, { db });   // CABINET_FIX_V1_R6
    }   // CABINET_FIX_V1_R6

    // CRM_CALENDAR_MIRROR_V1 — что заденет правка (и отказ, если она трогает
    // услугу заявки, уже выставленную или начатую). До выполнения: база ещё
    // не тронута.
    const mirror = mirrorBefore(db, compiled.meta, req.body, req.user);
    if (mirror.refusal) return res.status(409).json({ error: { code: 'conflict', message: mirror.refusal } });

    try {
      const { sql, params, meta } = compiled;

      if (meta.op === 'select') {
        const rows = db.prepare(sql).all(...params);
        const count = meta.count === 'exact' ? countMatching(db, req.body, req.user) : null;
        return respondRows(res, rows, meta, count);
      }

      if (meta.op === 'insert') {
        // Batch (array) inserts — the Excel importer — compile to one statement
        // per row (ragged keys keep their DB defaults); all-or-nothing in a
        // transaction, and the importer never asks for returning on batches.
        if (meta.multi) {
          // CRM_DEDUP_SEARCH_TASKS_V1 — строка, не прошедшая ограничение по
          // родителю (meta.guarded), откатывает весь пакет: половина пакета
          // хуже, чем ничего.
          let refused = false;
          try {
            db.transaction(() => {
              for (const st of compiled.statements) {
                const inf = db.prepare(st.sql).run(...st.params);
                if (meta.guarded && inf.changes === 0) { refused = true; throw new Error('guarded insert refused'); }
              }
            })();
          } catch (e) { if (!refused) throw e; }
          if (refused) return res.status(403).json({ error: { code: 'forbidden', message: 'not allowed' } });
          mirrorAfter(db, mirror, meta, req.body, req.user);   // CRM_CALENDAR_MIRROR_V1
          rehomeAfterRolesWrite(db, meta);   // CRM_UNIFY_V1
          return res.json({ data: null });
        }
        const info = db.prepare(sql).run(...params);
        // CRM_DEDUP_SEARCH_TASKS_V1 — вставка на чужого родителя не записала ничего.
        if (meta.guarded && info.changes === 0) {
          return res.status(403).json({ error: { code: 'forbidden', message: 'not allowed' } });
        }
        // CRM_REAL_BOOKING_V1 — строку услуги заводят и СРАЗУ в рабочем
        // статусе: кабинет врача добавляет услугу «с ходу» уже начатой. Такая
        // вставка — то же доказательство прихода, что и перевод статуса
        // правкой, и пропускать её только потому, что она пришла другой
        // операцией, значило бы держать правило, работающее через раз.
        //
        // Пакетная (массивом) вставка сюда не доходит и не должна: это
        // выгрузка Excel, а не работа с пациентом у стойки.
        if (meta.table === 'visit_services' && hasEvidenceStatus(req.body)) {
          crmServiceEvidence(db, [Number(info.lastInsertRowid)]);
        }
        mirrorAfter(db, mirror, meta, req.body, req.user, { insertedId: Number(info.lastInsertRowid) });   // CRM_CALENDAR_MIRROR_V1
        rehomeAfterRolesWrite(db, meta);   // CRM_UNIFY_V1
        if (!meta.returning) return res.json({ data: null });
        const row = db.prepare(
          `SELECT ${readableColumns(meta.table).map((c) => `"${c}"`).join(', ')} FROM "${meta.table}" WHERE rowid = ?`
        ).get(info.lastInsertRowid);
        return respondRows(res, [row], meta, null);
      }

      if (meta.op === 'upsert') {
        db.prepare(sql).run(...params);
        mirrorAfter(db, mirror, meta, req.body, req.user);   // CRM_CALENDAR_MIRROR_V1
        rehomeAfterRolesWrite(db, meta);   // CRM_UNIFY_V1
        // A bulk (array) upsert has no single row to hand back; callers that use
        // it don't request returning. Single-row upsert re-selects below.
        if (!meta.returning || meta.multi) return res.json({ data: null });
        // Re-select by the conflict-target values so `returning` reflects the
        // upserted row whether the write inserted or updated (lastInsertRowid
        // is unreliable on the DO UPDATE path).
        const vals = req.body.values || {};
        const filters = meta.conflictTarget.map((c) => ({ col: c, op: 'eq', val: vals[c] }));
        const sel = compile({ table: meta.table, op: 'select', columns: '*', filters }, req.user, { db });
        const rows = db.prepare(sel.sql).all(...sel.params);
        return respondRows(res, rows, meta, null);
      }

      if (meta.op === 'update') {
        // CRM_REAL_BOOKING_V1 — кого коснётся правка, спрашиваем ДО неё (см.
        // crmEvidenceTargets), а заявки считаем ПОСЛЕ: хук молчит при любой
        // ошибке, но и запускать его по строкам, которые не записались, незачем.
        const evidence = crmEvidenceTargets(db, meta, req.body, req.user);
        const updInfo = db.prepare(sql).run(...params);
        // CABINET_FIX_V1_R1 — таблица, где 0 задетых строк значит «ограничение не
        // пропустило» (шаблоны: правит автор или администратор), отвечает отказом.
        if (updInfo.changes === 0 && zeroRowRefusal(meta.table)) return res.status(403).json({ error: { code: 'forbidden', message: zeroRowRefusal(meta.table) } });
        if (evidence.length) crmServiceEvidence(db, evidence);
        mirrorAfter(db, mirror, meta, req.body, req.user);   // CRM_CALENDAR_MIRROR_V1
        rehomeAfterRolesWrite(db, meta);   // CRM_UNIFY_V1
        if (!meta.returning) return res.json({ data: null });
        // Re-select the affected rows using the SAME filters that scoped the
        // update (never the whole table) so `returning` reflects only what
        // was actually touched.
        const sel = compile({ table: req.body.table, op: 'select', columns: '*', filters: req.body.filters }, req.user, { db });
        const rows = db.prepare(sel.sql).all(...sel.params);
        return respondRows(res, rows, meta, null);
      }

      if (meta.op === 'delete') {
        const delInfo = db.prepare(sql).run(...params);
        if (delInfo.changes === 0 && zeroRowRefusal(meta.table)) return res.status(403).json({ error: { code: 'forbidden', message: zeroRowRefusal(meta.table) } });   // CABINET_FIX_V1_R1
        mirrorAfter(db, mirror, meta, req.body, req.user);   // CRM_CALENDAR_MIRROR_V1
        rehomeAfterRolesWrite(db, meta);   // CRM_UNIFY_V1
        return res.json({ data: null });
      }
    } catch (e) {
      // DB_CONSTRAINT_ERRORS_V1 — a violated constraint is the CALLER's problem,
      // and the caller is the only one who can fix it. Flattening it into
      // 500 «Query failed.» sent the reason to the server console and left the
      // user with nothing: a laborant linking a service another panel already
      // owns (UNIQUE index, migration 048) simply saw the save fail forever.
      //
      // The detail names a table and column the client already knows from the
      // registry, so echoing it leaks nothing and lets the UI say what happened.
      // Anything that is NOT a constraint stays an opaque 500 — an unexpected
      // failure must not describe the server's internals.
      //
      // V3120_I18N — английский текст SQLite («UNIQUE constraint failed: …»)
      // человеку больше не показывается: constraintRefusal даёт русскую фразу
      // (с шаблоном для перевода), а код SQLite и исходный текст едут рядом —
      // `sqlite_code` и `detail` — для логов и поддержки. Отказ ТРИГГЕРА
      // (RAISE(ABORT, '…')) — правило клиники её словами («Процент кэшбэка
      // должен быть от 0 до 100.»), он идёт как есть (V3120_FIX).
      const refusal = constraintRefusal(e);
      if (refusal) {
        return res.status(refusal.status).json({ error: {
          ...errorBody(refusal.code, refusal), sqlite_code: refusal.sqlite_code, detail: refusal.detail,
        } });
      }
      // V3120_FIX — upsert по колонке без уникального ключа: ошибка запроса.
      if (/ON CONFLICT clause does not match/i.test(String(e && e.message))) {
        return res.status(400).json({ error: { code: 'bad_request', message: 'Сохранение «добавить или обновить» возможно только по уникальному полю.' } });
      }
      console.error('[db query failed]', e.message);
      // OPS_EVENTS_V1 — same reasoning as rpc.js's 500 branch: this catch
      // answers directly (never next(e)), so app.js's global handler never
      // sees a /api/db failure either. meta.table is a schema-registry name
      // (fixed vocabulary, not a patient value), the same kind of identifier
      // rpc.js's RPC name already is.
      recordEvent(db, 'server_error', '/api/db/' + compiled.meta.table);
      return res.status(500).json({ error: { code: 'internal', message: 'Запрос к базе не выполнен. Повторите позже.' } });
    }
  });

  return r;
}

// V3120_FIX — текст отказа или null: назначение заявки CRM на ДРУГОГО
// сотрудника. Оператор колл-центра инспекцией вставлял заявку с assigned_to
// коллеги — и она исчезала у него с доски, появляясь у другого без следа.
// Кто видит всё (scopeLifted — то же правило, что у доски), назначает кого
// угодно; остальные — себя или никого.
// CRM_UNIFY_V1 (ревью задачи 10, R4/R5/R10) — «кого угодно» — из тех, кто может
// вести заявки (crm/tasks-follow.js canOwnLead: активен, пишет задачи CRM,
// «CRM: изменение»). Иначе карточка — и её задачи, идущие за ней, — уходили
// кассиру, врачу, уволенному, наблюдателю или несуществующему номеру.
// CRM_UNIFY_V1 (финальное ревью) — права ролей сменились («Настройки → Роли»
// пишет role_permissions через эту дверь): «crm.all» сняли, CRM — «просмотр»
// или без раздела. Задачи тех, кто больше не может вести карточку, сразу —
// её хозяину (crm/tasks-follow.js rehomeOrphanTasks; иначе — проход раз в
// час, server/index.js). Не бросает.
function rehomeAfterRolesWrite(db, meta) {
  if (meta && meta.table === 'role_permissions') rehomeOrphanTasks(db);
}

function crmAssignRefusal(db, meta, body, user) {
  if (!meta || meta.table !== 'crm_requests') return null;
  if (meta.op !== 'insert' && meta.op !== 'update' && meta.op !== 'upsert') return null;
  const rows = Array.isArray(body && body.values) ? body.values : [body && body.values];
  const me = user && Number(user.id);
  const foreign = rows.filter((r) => r && Object.prototype.hasOwnProperty.call(r, 'assigned_to')
    && r.assigned_to !== null && r.assigned_to !== '' && Number(r.assigned_to) !== me);
  if (!foreign.length) return null;
  if (!scopeLifted(rowScope('crm_requests'), user, db)) {
    return 'Передать заявку другому сотруднику может руководитель колл-центра или администратор. Возьмите её себе или оставьте в общей стопке.';
  }
  if (foreign.some((r) => !canOwnLead(db, r.assigned_to))) return ownerRefusal();   // CRM_UNIFY_V1
  return null;
}

// STAFF_SYNC_V1 — эта установка является филиалом? Испорченная или отсутствующая
// строка branch_identity читается как «нет» — та же трактовка, что у
// readIdentity и exportCatalogue: свежая установка ещё никем не филиал, и
// сомнение обязано трактоваться в сторону «клиника правит своё сама», а не в
// сторону экрана, который вдруг перестал сохранять.
function isSecondary(db) {
  try { return readIdentity(db).role === 'secondary'; } catch { return false; }
}

// CLINIC_PROFILE_V1 — общее для клиники в «Компании» филиала не меняется
// (см. вызов в POST). null — запись можно выполнять.
const COMPANY_MAIN_ONLY = 'Название, описание, логотипы, сайт и соцсети, лицензия и фирменный цвет меняются в главном здании. Здесь — адрес, телефон и почта для документов этого здания.';   // BRANCH_PROFILE_V1 — текст
function companyBranchRefusal(db, meta, body) {
  if (!meta || meta.table !== 'doc_settings' || (meta.op !== 'update' && meta.op !== 'upsert')) return null;
  if (!isSecondary(db)) return null;
  const values = body && body.values && typeof body.values === 'object' && !Array.isArray(body.values) ? body.values : {};
  const cur = db.prepare('SELECT * FROM doc_settings WHERE id = 1').get() || {};
  const same = (a, b) => String(a == null ? '' : a) === String(b == null ? '' : b);
  const has = (c) => Object.prototype.hasOwnProperty.call(values, c);   // BRANCH_PROFILE_V1
  if (COMPANY_CLINIC_WIDE.some((c) => has(c) && !same(values[c], cur[c]))) return COMPANY_MAIN_ONLY;
  // BRANCH_PROFILE_V1 — адрес для партнёров и карту филиала ведёт главное
  // здание в «Филиалах» (одно место на здание): здесь они только видны.
  if (COMPANY_PARTNER.some((c) => has(c) && !same(values[c], cur[c]))) return BRANCH_MESSAGES.partnerInBranches;
  return null;
}

// CLINIC_PROFILE_V1 (ревью M3) — true: правка заменяет или снимает прежний
// логотип (data URL, квадратного ещё нет), а положить его копию в хранилище не
// вышло. Копия, которая уже лежит, — повтор ничего не пишет (имя по содержимому).
const LEGACY_LOGO_NOT_SAVED = 'Прежний логотип клиники не удалось сохранить копией, поэтому он остаётся на бланках, а новый не применён. Попробуйте ещё раз; если повторится — проверьте место на диске компьютера с программой.';
function legacyLogoAtRisk(db, meta, body, storageDir) {
  if (!storageDir || !meta || meta.table !== 'doc_settings' || (meta.op !== 'update' && meta.op !== 'upsert')) return false;
  const v = body && body.values;
  const rows = (Array.isArray(v) ? v : [v]).filter((r) => r && typeof r === 'object' && Object.prototype.hasOwnProperty.call(r, 'logo_data_url'));
  if (!rows.length) return false;
  const cur = db.prepare('SELECT * FROM doc_settings WHERE id = 1').get() || {};
  if (cur.logo_square_path || !/^data:/i.test(String(cur.logo_data_url || ''))) return false;
  if (rows.every((r) => String(r.logo_data_url == null ? '' : r.logo_data_url) === String(cur.logo_data_url))) return false;
  try { keepLegacyLogo(cur.logo_data_url, storageDir); return false; }
  catch (e) { console.warn('[legacy-logo] copy before overwrite failed:', e && e.message); return true; }
}

// CLINIC_PROFILE_V1 (ревью I2) — запись в doc_settings (вставка, правка,
// upsert; одна строка или пачка): первая проблема формата — { field, message }.
function companyProfileRefusal(meta, body) {
  if (!meta || meta.table !== 'doc_settings' || !['insert', 'update', 'upsert'].includes(meta.op)) return null;
  const v = body && body.values;
  for (const row of Array.isArray(v) ? v : [v]) {
    // BRANCH_PROFILE_V1 (ревью шага 4, #3) — адрес для партнёров, карта и
    // телефон главного здания уезжают в филиалы строкой его здания
    // (catalogue.js roster, overlayOwnBuilding): им те же формат и пределы, что
    // строке branches, — иначе филиал молча пропускал бы их при каждой синхронизации.
    const problems = { ...storedProfileProblems(row), ...ownBuildingProblems(row) };
    const field = Object.keys(problems)[0];
    if (field) return { field, message: problems[field] };
  }
  return null;
}

// BRANCH_PROFILE_V1 — см. вызов в POST. null — запись можно выполнять.
const flat = (v) => (v === true ? '1' : v === false ? '0' : String(v == null ? '' : v));
// Строки, которые правят: отбор только по id (eq / in — так пишут экраны;
// правку без выбора строк компилятор не пускает сам). Другой отбор — null:
// что правится, заранее не известно, и тогда страж отказывает.
// CLINIC_API_STEP7_V1 (ревью слияния №3) — targetBranches переехала в
// services/branch-targets.js: её же зовёт страж решения владельца 11.
function branchWriteRefusal(db, meta, body) {
  if (!meta || meta.table !== 'branches' || !['insert', 'update', 'upsert'].includes(meta.op)) return null;
  const secondary = isSecondary(db);
  // Вставка и upsert заводят НОВОЕ здание (id и буква через /api/db не пишутся).
  if (meta.op !== 'update') return secondary ? BRANCH_MESSAGES.newMainOnly : null;
  const values = body && body.values && typeof body.values === 'object' && !Array.isArray(body.values) ? body.values : {};
  const guarded = secondary ? BRANCH_MAIN_COLUMNS : OWN_FROM_COMPANY;
  const touched = guarded.filter((c) => Object.prototype.hasOwnProperty.call(values, c));
  if (!touched.length) return null;
  let rows = targetBranches(db, body);
  if (!secondary) {
    let own = null;
    try { own = readIdentity(db).branch_id; } catch { own = null; }
    if (own == null) return null;                                     // своего здания нет — беречь нечего
    if (rows) rows = rows.filter((r) => Number(r.id) === Number(own));
    if (rows && !rows.length) return null;                            // чужие здания — правит главное
  }
  const changes = (r) => touched.some((c) => flat(values[c]) !== flat(r[c]));
  if (rows && !rows.some(changes)) return null;
  return secondary ? BRANCH_MESSAGES.mainOnly : BRANCH_MESSAGES.ownInCompany;
}
function branchFormatRefusal(meta, body) {
  if (!meta || meta.table !== 'branches' || !['insert', 'update', 'upsert'].includes(meta.op)) return null;
  const v = body && body.values;
  for (const row of Array.isArray(v) ? v : [v]) {
    const problems = storedBranchProblems(row);
    const field = Object.keys(problems)[0];
    if (field) return { field, message: problems[field] };
  }
  return null;
}
// DOCTOR_PROFILE_V1 — см. вызов в POST. null — запись можно выполнять.
function consultTypeFormatRefusal(meta, body) {
  if (!meta || meta.table !== 'consultation_types' || !['insert', 'update', 'upsert'].includes(meta.op)) return null;
  const v = body && body.values;
  for (const row of Array.isArray(v) ? v : [v]) {
    const p = consultTypeProblem(row);
    if (p) return p;
  }
  return null;
}
function consultKindRefusal(db, meta, body) {
  if (!meta || meta.table !== 'consultation_types' || !['insert', 'update', 'upsert'].includes(meta.op)) return null;
  const v = body && body.values;
  const kinds = (Array.isArray(v) ? v : [v]).map((r) => r && r.api_kind).filter((k) => CONSULT_API_KINDS.includes(k));
  if (!kinds.length) return null;
  if (new Set(kinds).size !== kinds.length) return CONSULT_MESSAGES.kindTaken;
  const f = body && Array.isArray(body.filters) ? body.filters : [];
  const self = f.length === 1 && f[0] && f[0].col === 'id' && f[0].op === 'eq' ? Number(f[0].val) : null;
  if (meta.op !== 'insert' && self == null) return CONSULT_MESSAGES.kindTaken;   // один вид «для партнёров» не ставят пачке строк
  for (const k of kinds) {
    if (db.prepare('SELECT 1 FROM consultation_types WHERE api_kind = ? AND id <> ?').get(k, self == null ? -1 : self)) return CONSULT_MESSAGES.kindTaken;
  }
  return null;
}

// Shapes the row list according to desc.single: 'single' requires exactly
// one row (406 otherwise), 'maybe' allows zero-or-one, anything else
// returns the full array (plus count, for list views). Embeds are nested
// first so single/maybe/plain/returning all get the same supabase-style
// { ...row, branches: { name } } shape.
function respondRows(res, rows, meta, count) {
  const shaped = parseJsonColumns(reshape(rows, meta), meta);
  if (meta.single === 'single') {
    if (shaped.length !== 1) {
      return res.status(406).json({ error: { code: 'not_single', message: 'Ожидалась ровно одна запись.' } });
    }
    return res.json({ data: shaped[0] });
  }
  if (meta.single === 'maybe') {
    return res.json({ data: shaped[0] ?? null });
  }
  return res.json({ data: shaped, count });
}

// JSON columns (registry `json: [...]`, e.g. doc_branding.settings) are stored
// as TEXT; parse them back into objects on the way out so callers get the same
// shape Supabase's jsonb gave them. Non-JSON strings / already-parsed values are
// left untouched, and a malformed blob degrades to null rather than throwing.
function parseJsonColumns(rows, meta) {
  const cols = meta.json;
  if (!cols || cols.length === 0) return rows;
  for (const row of rows) {
    if (!row) continue;
    for (const c of cols) {
      if (typeof row[c] === 'string') {
        try { row[c] = JSON.parse(row[c]); } catch { row[c] = null; }
      }
    }
  }
  return rows;
}

// The compiler projects embed columns as flat "path.col" aliases, where path
// is the dotted embed chain ("services.service_types" — NESTED_EMBED_V1 in
// query-compiler.js). Turn those back into the nested supabase-style shape:
// row.services.service_types.name. Deepest paths build first so each parent
// can absorb its children and decide null-collapse over the WHOLE subtree: a
// LEFT JOIN miss returns `null` for that relation (supabase represents an
// absent to-one relation as null, not {col: null}), and a parent whose scalar
// columns AND children are all null collapses to null too.
export function reshape(rows, meta) {   // exported for tests (NESTED_EMBED_V1)
  if (!meta.embeds || meta.embeds.length === 0) return rows;
  const byDepth = [...meta.embeds].sort((a, b) => b.name.split('.').length - a.name.split('.').length);
  return rows.map((row) => {
    const built = new Map();   // path -> nested object | null, children pending absorption
    for (const { name: path, columns } of byDepth) {
      const nested = {};
      let allNull = true;
      for (const col of columns) {
        const key = `${path}.${col}`;
        const val = row[key];
        nested[col] = val === undefined ? null : val;
        if (val !== null && val !== undefined) allNull = false;
        delete row[key];
      }
      for (const [childPath, childObj] of built) {
        if (childPath.startsWith(path + '.') && !childPath.slice(path.length + 1).includes('.')) {
          nested[childPath.slice(path.length + 1)] = childObj;
          if (childObj !== null) allNull = false;
          built.delete(childPath);
        }
      }
      built.set(path, allNull ? null : nested);
    }
    for (const [path, obj] of built) row[path] = obj;   // only top-level paths remain
    return row;
  });
}

// Counts rows matching the request's filters, ignoring limit/offset/order,
// for `count:'exact'` pagination. Reuses the compiler so the count is
// governed by the exact same allow-list as the page it's counting.
function countMatching(db, body, user) {
  const compiled = compile({ table: body.table, op: 'select', columns: 'id', filters: body.filters }, user, { db });
  const row = db.prepare(`SELECT COUNT(*) AS n FROM (${compiled.sql})`).get(...compiled.params);
  return row.n;
}
