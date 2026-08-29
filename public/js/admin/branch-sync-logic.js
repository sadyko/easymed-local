// BRANCH_SYNC_V1 — все РЕШЕНИЯ экрана «Настройки → Филиалы» о том, что писать
// на экране, отдельно от самого рисования. Тот же приём и по той же причине,
// что у system-logic.js: без фальшивого DOM проверяется именно то, ради чего
// экран существует — что филиал, который не достучался до главного, говорит об
// этом ровно и честно, а не «Ошибка».
//
// Ни сети, ни DOM, ни собственных часов. Любое поле ответа сервера может
// отсутствовать: экран обязан пережить и старый сервер, и испорченную запись о
// прошлой синхронизации — прочерк вместо факта, но никогда «undefined».

import { formatRuDateTime, DASH } from './system-logic.js';

// Названия таблиц справочника по-русски. Русские литералы: h() прогоняет
// текстовые узлы через tr(), а ru/uz/en живут в i18n-strings.js.
const TABLE_WORDS = {
  services: 'услуги',
  lab_panels: 'лабораторные панели',
  lab_panel_analytes: 'показатели',
  service_types: 'типы услуг',
  service_categories: 'категории услуг',
  departments: 'отделения',
};

/** Роль установки одной строкой + вид метки. */
export function roleBadge(status) {
  const role = status && status.role;
  if (role === 'main') return { label: 'Главный филиал', kind: 'ok' };
  if (role === 'secondary') return { label: 'Подключённый филиал', kind: 'info' };
  return { label: 'Не связан', kind: '' };
}

/** Понятное объяснение роли — под меткой, одной фразой. */
export function roleExplainer(status) {
  const role = status && status.role;
  if (role === 'main') return 'Этот компьютер раздаёт справочник остальным филиалам: услуги и цены, лабораторные панели, сведения о клинике.';
  if (role === 'secondary') return 'Этот филиал получает справочник из главного. Пациенты, визиты, анализы и деньги остаются только здесь и никуда не передаются.';
  return 'Филиалы пока не связаны. Назначьте один компьютер главным, а на остальных введите его ключ подключения.';
}

const dash = (v) => (v === null || v === undefined || v === '' ? DASH : v);

/** «12.08.2026 19:40» либо прочерк. */
export function whenLabel(iso) {
  return dash(formatRuDateTime(iso));
}

/**
 * Что изменила синхронизация, человеческими словами.
 *
 * Показывать «Готово» после каждого нажатия — значит не различать «приехали
 * новые цены» и «ничего не менялось», а это ровно тот вопрос, ради которого
 * владелец на экран и смотрит.
 */
export function changesLabel(record) {
  if (!record || typeof record !== 'object' || record.ok !== true) return DASH;
  const parts = [];
  const group = (obj, word) => {
    if (!obj || typeof obj !== 'object') return;
    const items = Object.keys(obj)
      .filter((k) => TABLE_WORDS[k] && Number(obj[k]) > 0)
      .map((k) => `${TABLE_WORDS[k]} — ${Number(obj[k])}`);
    if (items.length) parts.push(`${word}: ${items.join(', ')}`);
  };
  group(record.created, 'добавлено');
  group(record.updated, 'обновлено');
  if (record.settings) parts.push('обновлены сведения о клинике');
  if (!parts.length) return 'Изменений не было — справочник уже совпадает.';
  return parts.join('; ') + '.';
}

/**
 * Одна строка о состоянии связи: когда получилось в последний раз и что
 * случилось при последней попытке.
 *
 * @returns {{tone:'ok'|'warn'|'none', text:string}}
 *   'warn' — последняя попытка провалилась; экран красит эту строку иначе.
 */
export function syncLine(status) {
  const attempt = status && status.last_attempt;
  const okRec = status && status.last_ok;
  if (!attempt && !okRec) return { tone: 'none', text: 'Синхронизации ещё не было.' };
  if (attempt && attempt.ok === false) {
    const msg = typeof attempt.message === 'string' && attempt.message
      ? attempt.message
      : 'Не удалось синхронизироваться.';
    const when = whenLabel(attempt.at);
    const last = okRec && okRec.at ? ` Последний раз получилось: ${whenLabel(okRec.at)}.` : '';
    return { tone: 'warn', text: `${msg} (попытка ${when}).${last}` };
  }
  const rec = okRec || attempt;
  return { tone: 'ok', text: `Синхронизировано ${whenLabel(rec.at)}. ${changesLabel(rec)}` };
}

/** Можно ли вообще нажимать «Синхронизировать сейчас». */
export function canSyncNow(status, admin) {
  return !!(admin && status && status.role === 'secondary');
}

/**
 * Что подставить в поле «Адрес этого компьютера».
 *
 * Уже сохранённый адрес важнее подсказки: он и есть тот, который набран в
 * ключах, разошедшихся по филиалам. Перебить его догадкой означало бы выдать
 * новый ключ с другим адресом, ничего никому не сказав.
 */
export function addressValue(status) {
  if (status && status.role === 'main' && status.main_url) return status.main_url;
  return (status && status.suggested_url) || '';
}
