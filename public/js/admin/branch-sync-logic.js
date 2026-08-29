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
 * Каким путём приехал справочник. BRANCH_SYNC_RELAY_V1.
 *
 * Это не украшение строки состояния, а её смысл. Клиника платит за VPN между
 * зданиями; если он полгода как не работает и справочник всё это время ездит
 * через сервер поставщика (в зашифрованном виде, но всё же наружу), владелец
 * обязан видеть это на экране, а не узнать случайно. Поэтому путь называется
 * вслух в ОБОИХ случаях, а не только в «плохом».
 */
export function routeLabel(record) {
  return record && record.route === 'relay'
    ? 'через сервер Easy-Med (зашифровано)'
    : 'напрямую';
}

/**
 * Одна строка о состоянии связи: когда получилось в последний раз, каким путём
 * и что случилось при последней попытке.
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
    const last = okRec && okRec.at
      ? ` Последний раз получилось: ${whenLabel(okRec.at)} (${routeLabel(okRec)}).`
      : '';
    return { tone: 'warn', text: `${msg} (попытка ${when}).${last}` };
  }
  const rec = okRec || attempt;
  // Возраст копии договаривается только для резервного пути, и это не
  // придирка: прямым путём приезжает сегодняшний справочник, а через сервер —
  // копия на момент последней выгрузки главного филиала. Разницу между «цены
  // свежие» и «цены такие, какими были в понедельник» видно только отсюда.
  const age = rec.route === 'relay' && rec.relayed_at
    ? ` Копия главного филиала от ${whenLabel(rec.relayed_at)}.`
    : '';
  return { tone: 'ok', text: `Синхронизировано ${whenLabel(rec.at)} — ${routeLabel(rec)}.${age} ${changesLabel(rec)}` };
}

/**
 * Состояние КЛЮЧА СИНХРОНИЗАЦИИ — того самого, что создаётся при активации
 * клиники и которым шифруется всё, что уходит на сервер поставщика.
 *
 * Три честных состояния, и ни одного бодрого:
 *   'none'     — ключа нет вовсе (установка активирована до Маршрута Б и ещё не
 *                открывала этот экран);
 *   'unpaired' — ключ есть, но пара создана раньше и его не несёт: резервный
 *                канал заработает только после перевыпуска ключа подключения;
 *   'ready'    — ключ есть и работает.
 *
 * @returns {{state:'none'|'unpaired'|'ready', text:string}}
 */
export function syncKeyLine(status) {
  const present = !!(status && status.sync_key_present);
  const ready = !!(status && status.relay_ready);
  if (ready) {
    const when = status.sync_key_created_at ? ` Создан ${whenLabel(status.sync_key_created_at)}.` : '';
    return { state: 'ready', text: `Ключ синхронизации есть.${when}` };
  }
  if (present) {
    return {
      state: 'unpaired',
      text: 'Ключ синхронизации есть, но связь с филиалом настроена по старому ключу подключения. '
        + 'Чтобы включить резервный канал, выдайте ключ подключения заново и введите его в филиале.',
    };
  }
  return { state: 'none', text: 'Ключ синхронизации ещё не создан.' };
}

/**
 * Предупреждение, которое стоит на экране ВСЕГДА, а не всплывает после потери.
 *
 * Easy-Med не хранит ключ клиники и физически не может расшифровать то, что
 * лежит у него же на сервере. Это преимущество — и оно же цена: помочь
 * клинике, потерявшей ключ, поставщик не сможет. Владелец должен знать это до
 * того, как положится на резервный канал, а не после.
 */
export const KEY_LOSS_WARNING = 'Easy-Med не хранит ваш ключ синхронизации и не может прочитать переданные данные — '
  + 'а значит, не сможет и восстановить их, если ключ будет потерян. Единственная копия ключа — в самих филиалах.';

/**
 * Что написано под переключателем «резервный канал», для каждой роли отдельно.
 * Роли делают разные вещи: главный филиал ОТДАЁТ копию наружу, подключённый
 * только берёт уже лежащую, и путать эти два согласия нельзя.
 */
export function relayExplainer(status) {
  const role = status && status.role;
  if (role === 'main') {
    return 'Зашифрованная копия справочника будет лежать на сервере Easy-Med, чтобы её мог забрать филиал, '
      + 'который не видит этот компьютер по сети. Прочитать её Easy-Med не может: ключ есть только у ваших филиалов.';
  }
  return 'Если главный филиал недоступен, справочник будет взят из зашифрованной копии на сервере Easy-Med. '
    + 'Прямая связь всегда пробуется первой.';
}

/** Что показать про последнюю выгрузку копии — только у главного филиала. */
export function publishLine(status) {
  if (!status || status.role !== 'main') return null;
  if (!status.relay_enabled) return 'Копия на сервер не отправляется.';
  const last = status.relay_last_publish;
  if (!last || !last.at) return 'Копия на сервер ещё ни разу не отправлялась.';
  return `Копия на сервере обновлена ${whenLabel(last.at)}.`;
}

/**
 * Можно ли перевыпустить ключ. Подключённый филиал — нельзя: его ключ выдаёт
 * главный, и перевыпуск у себя просто отвалил бы филиал от группы, ничего не
 * починив.
 */
export function canRegenerateKey(status, admin) {
  return !!(admin && status && status.role !== 'secondary');
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
