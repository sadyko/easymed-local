// Single source of truth for user roles. The frontend mirrors this list;
// route modules re-export it so services never import from routes.
// CALLCENTER_ROLE_V1 — 'callcenter' is the phone operator who runs the CRM
// board. It exists because the clinic had been repurposing 'inventory' for the
// job and widening one account with the registrar role as an extra, which hands
// a phone operator the whole registrar right set (patients, visits, invoices).
// Роли, которые человек носит КАК ОСНОВНУЮ: это его профессия в клинике, и
// именно по ней реестр таблиц (schema-registry.js) выдаёт права на данные.
export const PRIMARY_ROLES = ['admin', 'registrar', 'doctor', 'cashier', 'lab', 'nurse', 'inventory', 'callcenter'];

// INPATIENT_FLOW_V1 — НАДСТРОЕЧНЫЕ роли: только через «Дополнительные роли».
//
// «Главный врач» и «старшая медсестра» — не профессии, а полномочия ПОВЕРХ
// профессии: главный врач остаётся врачом (ведёт своих пациентов, свою очередь,
// свой кабинет) и вдобавок проводит первичный осмотр и назначает лечащего
// врача. Решение владельца дословно: «„Главный врач“ — роль, её может держать
// несколько врачей».
//
// Основной ролью они быть НЕ МОГУТ, и это не вкусовщина: в списках реестра
// (ALL_STAFF и все write.roles) слова 'head_doctor' нет ни в одной строке, так
// что человек с такой ОСНОВНОЙ ролью увидел бы пустое приложение. Сервер
// авторизует по ОБЪЕДИНЕНИЮ основной и дополнительных (effectiveRoles ниже),
// поэтому врач с надстройкой имеет и права врача, и права главного врача.
//
// routes/users.js проверяет основную роль по PRIMARY_ROLES, а дополнительные —
// по VALID_ROLES. Разница намеренная, и объявлена она здесь.
export const EXTRA_ONLY_ROLES = ['head_doctor', 'senior_nurse'];

// Всё, что человек вправе носить в любом качестве.
export const VALID_ROLES = [...PRIMARY_ROLES, ...EXTRA_ONLY_ROLES];

// MULTI_ROLE_SERVER_V1 — every role a request may be authorised by: the primary
// role plus «Дополнительные роли» (users.extra_roles, admin-only to set). The
// ACL layer asks for this rather than reading user.role, because a склад
// employee given the registrar role as an extra was shown the CRM board by the
// client and then refused by the server on save — the extras had never reached
// it. Order matters only for readability: the primary role stays first.
export function effectiveRoles(user) {
  if (!user || !user.role) return [];
  const extra = Array.isArray(user.extra_roles) ? user.extra_roles : [];
  return [...new Set([user.role, ...extra].filter((r) => typeof r === 'string' && r))];
}

// Does this user hold ANY of `allowed`, counting extras? The RPC capability
// guards ask this; they each used to test `allowed.includes(user.role)`, which
// is the same primary-role-only bug the ACL layer had.
export function hasAnyRole(user, allowed) {
  const mine = effectiveRoles(user);
  return mine.some((r) => allowed.includes(r));
}

// TELEGRAM_CHAT_V1 — уровень доступа к разделу по таблице role_permissions.
//
// До сих пор гарды RPC перечисляли роли прямо в коде («admin, registrar»), и
// этого хватало: набор разделов был фиксирован. Но «Чат с пациентами» выдаётся
// администратором в «Настройки → Роли», то есть набор ролей заранее неизвестен,
// и проверять его надо ТАМ ЖЕ, где он хранится.
//
// Возвращает 'viewer' | 'editor' | 'admin' — или null, если раздел не выдан.
// Ключ, выданный без явного уровня, считается 'admin': так же поступает
// клиентский permissions.js, и роли, настроенные до появления уровней, не
// должны молча терять права.
const LEVEL_RANK = { viewer: 1, editor: 2, admin: 3 };

export function sectionLevel(db, user, key) {
  const roles = effectiveRoles(user);
  if (!roles.length) return null;

  let best = null;
  for (const role of roles) {
    let row;
    try { row = db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get(role); }
    catch { row = null; }
    if (!row || !row.permissions) continue;

    let perms;
    try { perms = JSON.parse(row.permissions); } catch { continue; }
    const sections = Array.isArray(perms && perms.sections) ? perms.sections : [];
    if (!sections.includes(key)) continue;

    const lvl = (perms.levels && perms.levels[key]) || 'admin';
    if (!best || (LEVEL_RANK[lvl] || 0) > (LEVEL_RANK[best] || 0)) best = lvl;
  }
  return best;
}

// Может ли пользователь хотя бы смотреть раздел?
export function canViewSection(db, user, key) {
  return sectionLevel(db, user, key) != null;
}

// Может ли изменять (для чата — отвечать пациенту)?
export function canEditSection(db, user, key) {
  const lvl = sectionLevel(db, user, key);
  return lvl === 'editor' || lvl === 'admin';
}

// ---------------------------------------------------------------------------
// PATIENT_TAB_ACCESS_V1 — ВКЛАДКИ КАРТЫ ПАЦИЕНТА как отдельные права.
//
// Жалоба владельца дословно: «the informations about the patients are available
// for anyone who has access to the patients section». Так и было: один ключ
// `patients` открывал ВСЮ карту — услуги, анализы, документы, счета, визиты и
// анкету. Регистратуре нужны визиты и услуги, лаборанту — анализы, и никому из
// них не нужны деньги пациента.
//
// Хранится ТАМ ЖЕ, где остальные права роли, и в том же JSON:
//   role_permissions.permissions = { sections:[…], levels:{…}, patient_tabs:{…} }
// Значение вкладки — 'none' | 'view' | 'edit' | 'delete', то есть ровно
// «просмотр / изменение / удаление» из просьбы владельца.
//
// ОТСУТСТВИЕ КЛЮЧА = ПОЛНЫЙ ДОСТУП. Это не небрежность, а условие обновления:
// ни в одном сеяном role_permissions (миграции 013/059/091) нет patient_tabs,
// поэтому в день установки каждая роль видит РОВНО то, что видела вчера, и
// владелец ЗАКРЫВАЕТ вкладки осознанно, а не обнаруживает клинику без доступа.
// Тот же выбор сделан на клиенте (permissions.js canViewPatientTab).
//
// НЕСКОЛЬКО РОЛЕЙ — САМАЯ ЩЕДРАЯ. Как и sectionLevel выше: «Дополнительные
// роли» ДОБАВЛЯЮТ права, а не отнимают. Роль без строки в role_permissions
// вкладок не ограничивает (её отказ — на уровне раздела `patients`, выше).
// ---------------------------------------------------------------------------

// Вкладки карты — ТОТ ЖЕ список и ТЕ ЖЕ id, что в views/patient-card.js TABS.
// Держится синхронно тестом (server/db/migrations/103.test.js).
export const PATIENT_CARD_TABS = Object.freeze(['services', 'labs', 'docs', 'billing', 'visits', 'details']);

// ЧТО НА ВКЛАДКЕ ВООБЩЕ МОЖНО СДЕЛАТЬ. Право, которого не существует, выдавать
// нельзя: галочка «Удаление» у «Счёта» обещала бы то, чего нет ни в карте, ни в
// реестре таблиц (invoices/invoice_items/payments: delete roles: [] — счета
// только аннулируются кассой), и читалась бы как разрешение, которое «почему-то
// не работает».
export const PATIENT_TAB_CAPS = Object.freeze({
  // сменить врача в строке, заменить услугу; удалить — только НЕОПЛАЧЕННУЮ строку
  services: Object.freeze({ edit: true,  del: true }),
  // результаты вносит и правит раздел «Лаборатория» (lab_results: insert/update — admin+lab)
  labs:     Object.freeze({ edit: false, del: false }),
  // загрузить файл / удалить документ (visit_documents: insert+delete)
  docs:     Object.freeze({ edit: true,  del: true }),
  // деньги пишут ТОЛЬКО RPC кассы; удаления счёта не существует нигде
  billing:  Object.freeze({ edit: false, del: false }),
  // записать визит; УДАЛЕНИЯ визита в карте нет (оно живёт у администратора)
  visits:   Object.freeze({ edit: true,  del: false }),
  // правка анкеты и отметок; удаление пациента — «Настройки → Пациенты», не карта
  details:  Object.freeze({ edit: true,  del: false }),
});

// PATIENT_TAB_PERMS_V1 звал вкладку «Деталь» ключом `overview`, а карта зовёт её
// `details` (views/patient-card.js). Псевдоним читается и после переименования
// (миграция 103), потому что кабинет врача спрашивает старое имя.
const PATIENT_TAB_ALIASES = Object.freeze({ overview: 'details' });

const TAB_RANK = { none: 0, view: 1, edit: 2, delete: 3 };
const RANK_TAB = ['none', 'view', 'edit', 'delete'];

export function normalizePatientTab(tab) {
  const t = String(tab == null ? '' : tab).trim();
  return PATIENT_TAB_ALIASES[t] || t;
}

// Потолок вкладки: ранг, выше которого право просто не существует.
function tabCeiling(tab) {
  const caps = PATIENT_TAB_CAPS[tab];
  if (!caps) return 3;            // не вкладка карты (ключи кабинета врача) — не ограничиваем
  if (caps.del) return 3;
  return caps.edit ? 2 : 1;
}

/**
 * Уровень доступа роли к вкладке карты пациента.
 * @returns 'none' | 'view' | 'edit' | 'delete'
 */
export function patientTabLevel(db, user, tab) {
  const key = normalizePatientTab(tab);
  const roles = effectiveRoles(user);
  if (!roles.length) return 'none';

  const ceiling = tabCeiling(key);
  let best = 0;
  for (const role of roles) {
    let row;
    try { row = db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get(role); }
    catch { row = null; }

    let perms = null;
    if (row && row.permissions) { try { perms = JSON.parse(row.permissions); } catch { perms = null; } }
    const tabs = (perms && perms.patient_tabs && typeof perms.patient_tabs === 'object') ? perms.patient_tabs : {};

    // Явное значение под новым именем, иначе под старым, иначе — не ограничено.
    let raw = Object.prototype.hasOwnProperty.call(tabs, key) ? tabs[key] : undefined;
    if (raw === undefined) {
      for (const [legacy, canon] of Object.entries(PATIENT_TAB_ALIASES)) {
        if (canon === key && Object.prototype.hasOwnProperty.call(tabs, legacy)) { raw = tabs[legacy]; break; }
      }
    }
    // SERVICES_TAB_V1 — «Услуги» отделились от «Визитов»: настройка, сохранённая
    // до разделения, наследует ограничение визитов (то же правило на клиенте).
    if (raw === undefined && key === 'services' && tabs.visits === 'none') raw = 'none';

    const rank = raw === undefined ? 3 : (TAB_RANK[raw] ?? 3);
    if (rank > best) best = rank;
    if (best >= ceiling) break;
  }
  return RANK_TAB[Math.min(best, ceiling)];
}

export function canViewPatientTab(db, user, tab)   { return patientTabLevel(db, user, tab) !== 'none'; }
export function canEditPatientTab(db, user, tab)   { const l = patientTabLevel(db, user, tab); return l === 'edit' || l === 'delete'; }
export function canDeletePatientTab(db, user, tab) { return patientTabLevel(db, user, tab) === 'delete'; }
