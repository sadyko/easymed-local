// CRM_UNIFY_V1 (2026-10-09) — «КОЛОНКА ЗАПИСИ» И «КОЛОНКА КОНВЕРСИИ»: ОДНО
// ПРАВИЛО ДЛЯ СЕРВЕРА И БРАУЗЕРА.
//
// «Колонка записи» — куда переходит карточка, когда пациента ЗАПИСАЛИ. Это
// открытая видимая колонка ДО «Пришёл» (колонки-конверсии): по умолчанию
// «Записан», если она есть и видна, иначе последняя такая; выбор
// администратора в «CRM-канбан» — если он всё ещё допустим (Р10: колонку
// скрыли, удалили или поставили после конверсии — выбор молча не действует).
// Раньше сервер и браузер угадывали по-разному, и у клиники записанные уезжали
// в «Успешно».
//
// «Колонка конверсии (пришёл)» (дополнение владельца 2026-10-09) — ровно одна
// колонка вида won. Выбор переносит вид на другую колонку, прежняя становится
// открытой. Допустима активная колонка не вида lost и не сидовая «Не пришёл», и
// только если перед ней остаётся колонка для записанных (колонка записи обязана
// стоять ДО конверсии). Нынешняя конверсия допустима всегда — это не смена.
// Ещё одно условие — новая колонка ПУСТАЯ, карточки прежней конверсии идут за
// ролью (ревью задачи 4) — проверяет и делает только сервер
// (services/crm/config.js saveCrmSettings): числа карточек у этих функций нет.
//
// Чистые функции: без базы, без DOM. Сервер (services/crm/config.js
// scheduledStageKey, saveCrmSettings) и экран (crm-settings-logic.js
// boardConfig, views/crm-settings.js) зовут их — проверка и выбор не могут
// разойтись. Тексты отказов живут у сервера: здесь только коды.
//
// CRM_STAGE_ROLES_V1 (3.23.0, миграция 284) — РОЛИ КОЛОНОК ВМЕСТО ДОГАДОК. Владелец: «we need
// to add a booking tick (like conversion) so the system won't break». «Колонка записи»,
// «Колонка подтверждения» и «Не пришёл» — отметка колонки (crm_stages.role), как вид won у
// конверсии; ничто больше не угадывает их по порядку, ключу или выбору в crm_settings.
// Догадка 3.22.0 (bookedStageKey, confirmedStageKeyOf ниже) осталась для двух случаев:
// миграция 284 заполнила роли ровно ею (284.test.js сверяет), и экран, получивший ответ
// сервера старше себя (колонки без поля role), рисует доску по ней.
export const SEED_BOOKED_STAGE = 'scheduled';

/** CRM_STAGE_ROLES_V1 — роли колонок: «запись», «подтверждение», «не пришёл». */
export const STAGE_ROLES = Object.freeze(['booked', 'confirmed', 'no_show']);
const roleOf = (s) => (s && STAGE_ROLES.includes(s.role) ? s.role : null);

/** CRM_STAGE_ROLES_V1 — ключ колонки с ролью `role`; null — роли нет ни у одной. */
export function roleKey(stages, role) {
  const s = (Array.isArray(stages) ? stages : []).find((x) => x && x.key && roleOf(x) === role);
  return s ? s.key : null;
}

/** CRM_STAGE_ROLES_V1 — прислал ли сервер роли вообще (поле role есть хоть у одной колонки). */
export function hasStageRoles(stages) {
  return (Array.isArray(stages) ? stages : []).some((s) => s && Object.prototype.hasOwnProperty.call(s, 'role'));
}

/**
 * CRM_STAGE_ROLES_V1 — воронка, где роль `role` у колонки `key` (on) или снята с неё (!on).
 * Роль одна на воронку: у прежней колонки она снимается. У колонки одна роль: новая заменяет
 * прежнюю. Вход не меняется.
 */
export function withRole(stages, key, role, on = true) {
  return (Array.isArray(stages) ? stages : []).filter(Boolean).map((s) => {
    if (s.key === key) return { ...s, role: on ? role : (roleOf(s) === role ? null : roleOf(s)) };
    if (on && roleOf(s) === role) return { ...s, role: null };
    return s;
  });
}

// is_active приходит булевым (сервер, listStages) и 1/0 (экран, shapeConfig);
// строка без поля — видимая (как в shapeConfig).
const isActive = (s) => (s.is_active === undefined || s.is_active === null ? true : s.is_active === true || !!Number(s.is_active));

/**
 * Колонки по порядку доски: position, при равенстве — ключ.
 * CRM_STAGE_ROLES_V1 (ревью) — ключ сравнивается ПО КОДАМ СИМВОЛОВ, как ORDER BY position, key у
 * SQLite (listStages, миграция 284), а не localeCompare: иначе при равных position правила ролей
 * в JS и роли в базе видели бы разный порядок («a_1» и «a1»). Миграция 284 к тому же
 * перенумеровывает равные position, так что в базе равенства больше нет.
 */
const byCode = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
function ordered(stages) {
  return (Array.isArray(stages) ? stages : []).filter((s) => s && s.key)
    .slice().sort((a, b) => (Number(a.position) || 0) - (Number(b.position) || 0) || byCode(String(a.key), String(b.key)));
}

/** Ключи колонок, которые могут быть «Колонкой записи», по порядку доски. */
export function bookedStageCandidates(stages) {
  const list = ordered(stages);
  const wonAt = list.findIndex((s) => s.kind === 'won');
  const before = wonAt >= 0 ? list.slice(0, wonAt) : list;
  return before.filter((s) => s.kind === 'open' && isActive(s)).map((s) => s.key);
}

/**
 * «Колонка записи» ПО ДОГАДКЕ 3.22.0: выбор, если допустим; иначе «Записан»; иначе последняя
 * кандидатка; null — некуда. CRM_STAGE_ROLES_V1 — только для заполнения ролей (миграция 284)
 * и ответа сервера без ролей; действующая колонка записи — роль 'booked' (roleKey).
 */
export function bookedStageKey(stages, chosen = null) {
  const c = bookedStageCandidates(stages);
  if (chosen && c.includes(chosen)) return chosen;
  if (c.includes(SEED_BOOKED_STAGE)) return SEED_BOOKED_STAGE;
  return c.length ? c[c.length - 1] : null;
}

/**
 * CRM_LINK_ALL_V1 (R4; решение владельца D3) — «КОЛОНКА ПОДТВЕРЖДЕНИЯ»: первая
 * ВИДИМАЯ открытая колонка ПОСЛЕ «Колонки записи» и ДО конверсии (у клиник —
 * сидовая «Подтверждён»). null — такой нет: отметка «Подтверждён» в календаре
 * карточку тогда не двигает. CRM_STAGE_ROLES_V1 — догадка 3.22.0, как bookedStageKey:
 * действующая — роль 'confirmed'.
 */
export function confirmedStageKeyOf(stages, bookedKey) {
  const list = ordered(stages);
  const wonAt = list.findIndex((s) => s.kind === 'won');
  const before = wonAt >= 0 ? list.slice(0, wonAt) : list;
  const at = bookedKey ? before.findIndex((s) => s.key === bookedKey) : -1;
  if (at < 0) return null;
  const next = before.slice(at + 1).find((s) => s.kind === 'open' && isActive(s));
  return next ? next.key : null;
}

/** Воронка с конверсией на `key`: вид won — ей, прежняя конверсия — открытая. Вход не меняется. */
export function withConversion(stages, key) {
  return (Array.isArray(stages) ? stages : []).filter(Boolean).map((s) => {
    if (s.key === key) return { ...s, kind: 'won' };
    if (s.kind === 'won') return { ...s, kind: 'open' };
    return s;
  });
}

/**
 * CRM_STAGE_ROLES_V1 — ПОЧЕМУ ТАКИЕ РОЛИ НЕЛЬЗЯ СОХРАНИТЬ. null — можно. Коды:
 *   role_twice      — одна роль у двух колонок;
 *   booked_order    — колонка записи не открытая, не видимая или не ДО конверсии;
 *   confirmed_order — колонка подтверждения не открытая, не видимая, не ПОСЛЕ колонки
 *                     записи (или колонки записи нет) или не ДО конверсии;
 *   no_show_kind    — колонка «Не пришёл» — конверсия или скрыта (CRM_NO_SHOW_ANY_COLUMN_V1:
 *                     открытая теперь допустима; прежде — только проигрышная).
 * Роли может не быть ни у одной колонки: без «записи» запись не двигает карточку, без
 * «подтверждения» отметка «Подтверждён» её не двигает, без «Не пришёл» автоматика неявки
 * выключена.
 *
 * CRM_STAGE_ROLES_V1 (ревью) — С `prev` (воронка до правки) СУДИТСЯ ТОЛЬКО ТО, ЧТО ЭТА ПРАВКА
 * ИЗМЕНИЛА: роль, которая уже была недопустимой у той же колонки (ручная правка базы, откат
 * версии, скрытая «Не пришёл» после миграции 284), сохранение не блокирует — иначе одна
 * плохая строка запрещала бы любые правки. Роль, которую правка сделала недопустимой
 * (перенесла, скрыла, переставила за конверсию), — отказ, как прежде.
 */
export function roleRefusal(stages, prev = null) {
  const list = ordered(stages);
  for (const r of STAGE_ROLES) if (list.filter((s) => roleOf(s) === r).length > 1) return 'role_twice';
  const before = prev ? ordered(prev) : null;
  for (const r of STAGE_ROLES) {
    const why = roleProblem(list, r);
    if (!why) continue;
    if (before && roleKey(before, r) === roleKey(list, r) && roleProblem(before, r)) continue;   // была такой и до правки
    return why;
  }
  return null;
}

/**
 * CRM_STAGE_ROLES_V1 (ревью) — ЧТО НЕ ТАК С РОЛЬЮ `role` в воронке `stages` (код roleRefusal или
 * null — всё в порядке или роли нет). Одно правило для сохранения и для чтения роли сервером
 * (config.js: недопустимая роль читается как неотмеченная).
 */
export function roleProblem(stages, role) {
  const list = ordered(stages);
  const wonAt = list.findIndex((s) => s.kind === 'won');
  const at = (r) => list.findIndex((s) => roleOf(s) === r);
  const openBeforeWon = (i) => list[i].kind === 'open' && isActive(list[i]) && (wonAt < 0 || i < wonAt);
  const b = at('booked');
  if (role === 'booked') return b >= 0 && !openBeforeWon(b) ? 'booked_order' : null;
  if (role === 'confirmed') {
    const c = at('confirmed');
    if (c < 0) return null;
    return !openBeforeWon(c) || b < 0 || !openBeforeWon(b) || c < b ? 'confirmed_order' : null;
  }
  if (role === 'no_show') {
    const n = at('no_show');
    // CRM_NO_SHOW_ANY_COLUMN_V1 (3.23.0) — любая видимая колонка, кроме конверсии (прежде — только
    // проигрышная). Владелец: «we also need to add the "unarrived" status tick».
    return n >= 0 && (list[n].kind === 'won' || !isActive(list[n])) ? 'no_show_kind' : null;
  }
  return null;
}

/**
 * CRM_STAGE_ROLES_V1 — КОЛОНКА С РОЛЬЮ УХОДИТ: её удаляют, а роль не передана другой, или
 * её скрывают с ролью. Первое такое — { role, key, label, why: 'deleted' | 'hidden' }; null —
 * нет. Отказ сервера: «сначала передайте роль другой колонке».
 * CRM_STAGE_ROLES_V1 (ревью) — deletions: false — правка несёт роли (экран с галочками): удалённая
 * колонка, чью роль никому не передали, — роль снята вместе с ней (как «снять галочку и
 * скрыть» одной правкой). Удаление без ролей в правке (экран старше сервера) — отказ.
 */
export function roleLeaving(prev, next, { deletions = true } = {}) {
  const now = Array.isArray(next) ? next.filter(Boolean) : [];
  for (const p of (Array.isArray(prev) ? prev : []).filter(Boolean)) {
    const r = roleOf(p);
    if (!r) continue;
    const n = now.find((x) => x.key === p.key);
    if (!n) {
      if (deletions && !roleKey(now, r)) return { role: r, key: p.key, label: p.label || p.key, why: 'deleted' };
    } else if (roleOf(n) === r && isActive(p) && !isActive(n)) {
      return { role: r, key: p.key, label: n.label || p.key, why: 'hidden' };
    }
  }
  return null;
}

/**
 * Почему `key` не может стать конверсией. null — может. Коды:
 *   missing      — такой колонки нет;
 *   lost         — проигрышная колонка;
 *   no_show      — колонка с ролью «Не пришёл» (CRM_STAGE_ROLES_V1; прежде — сидовый ключ);
 *   hidden       — скрытая колонка;
 *   и коды roleRefusal воронки ПОСЛЕ переноса (CRM_STAGE_ROLES_V1, conversionMove):
 *   booked_order  — колонка записи оказалась бы на месте конверсии или после неё;
 *   confirmed_role — то же с колонкой подтверждения (решение координатора 2026-11-10: роль
 *                    не снимается молча — сначала её передают другой колонке).
 * Роли с конверсией не переезжают и не снимаются сами.
 */
export function conversionRefusal(stages, key) {
  return conversionMove(stages, key).why;
}

/**
 * CRM_STAGE_ROLES_V1 — ПЕРЕНОС КОНВЕРСИИ НА `key`: { why, stages, roleAt }. why — код отказа
 * (conversionRefusal) или null; stages — воронка после переноса; roleAt — колонка, чья роль
 * мешает (для фразы «Колонка «…» — колонка подтверждения: сначала передайте роль другой
 * колонке»).
 */
export function conversionMove(stages, key) {
  const list = ordered(stages);
  const s = list.find((x) => x.key === key);
  if (!s) return { why: 'missing', stages: list };
  if (s.kind !== 'won') {   // нынешняя конверсия — не смена: проверяется только порядок ролей
    if (s.kind === 'lost') return { why: 'lost', stages: list };
    if (roleOf(s) === 'no_show') return { why: 'no_show', stages: list };
    if (!isActive(s)) return { why: 'hidden', stages: list };
  }
  const next = withConversion(list, key);
  const why = roleRefusal(next, list);
  if (why === 'confirmed_order') return { why: 'confirmed_role', stages: next, roleAt: roleKey(list, 'confirmed') };
  return { why, stages: next, roleAt: why === 'booked_order' ? roleKey(list, 'booked') : null };
}

/** Ключи колонок, которые можно выбрать конверсией, по порядку доски. */
export function conversionCandidates(stages) {
  const list = ordered(stages);
  return list.filter((s) => conversionRefusal(list, s.key) === null).map((s) => s.key);
}
