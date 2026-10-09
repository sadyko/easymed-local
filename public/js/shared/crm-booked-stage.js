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
//
// Чистые функции: без базы, без DOM. Сервер (services/crm/config.js
// scheduledStageKey, saveCrmSettings) и экран (crm-settings-logic.js
// boardConfig, views/crm-settings.js) зовут их — проверка и выбор не могут
// разойтись. Тексты отказов живут у сервера: здесь только коды.
export const SEED_BOOKED_STAGE = 'scheduled';
export const SEED_NO_SHOW_STAGE = 'no_show';

// is_active приходит булевым (сервер, listStages) и 1/0 (экран, shapeConfig);
// строка без поля — видимая (как в shapeConfig).
const isActive = (s) => (s.is_active === undefined || s.is_active === null ? true : s.is_active === true || !!Number(s.is_active));

/** Колонки по порядку доски: position, при равенстве — ключ. */
function ordered(stages) {
  return (Array.isArray(stages) ? stages : []).filter((s) => s && s.key)
    .slice().sort((a, b) => (Number(a.position) || 0) - (Number(b.position) || 0) || String(a.key).localeCompare(String(b.key)));
}

/** Ключи колонок, которые могут быть «Колонкой записи», по порядку доски. */
export function bookedStageCandidates(stages) {
  const list = ordered(stages);
  const wonAt = list.findIndex((s) => s.kind === 'won');
  const before = wonAt >= 0 ? list.slice(0, wonAt) : list;
  return before.filter((s) => s.kind === 'open' && isActive(s)).map((s) => s.key);
}

/** «Колонка записи»: выбор, если допустим; иначе «Записан»; иначе последняя кандидатка; null — некуда. */
export function bookedStageKey(stages, chosen = null) {
  const c = bookedStageCandidates(stages);
  if (chosen && c.includes(chosen)) return chosen;
  if (c.includes(SEED_BOOKED_STAGE)) return SEED_BOOKED_STAGE;
  return c.length ? c[c.length - 1] : null;
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
 * Почему `key` не может стать конверсией (при выбранной колонке записи
 * `booked`; null — правило по умолчанию). null — может. Коды:
 *   missing      — такой колонки нет;
 *   lost         — проигрышная колонка;
 *   no_show      — сидовая «Не пришёл»;
 *   hidden       — скрытая колонка;
 *   booked_none  — перед ней не остаётся открытой видимой колонки для записанных;
 *   booked_order — выбранная колонка записи стоит на её месте или после неё.
 */
export function conversionRefusal(stages, key, booked = null) {
  const list = ordered(stages);
  const s = list.find((x) => x.key === key);
  if (!s) return 'missing';
  if (s.kind !== 'won') {   // нынешняя конверсия — не смена: проверяется только порядок записи
    if (s.kind === 'lost') return 'lost';
    if (s.key === SEED_NO_SHOW_STAGE) return 'no_show';
    if (!isActive(s)) return 'hidden';
  }
  const cand = bookedStageCandidates(withConversion(list, key));
  if (!cand.length) return 'booked_none';
  if (booked && !cand.includes(booked)) return 'booked_order';
  return null;
}

/** Ключи колонок, которые можно выбрать конверсией (при колонке записи `booked`), по порядку доски. */
export function conversionCandidates(stages, booked = null) {
  const list = ordered(stages);
  return list.filter((s) => conversionRefusal(list, s.key, booked) === null).map((s) => s.key);
}
