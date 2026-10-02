// CALL_RECORDING_REASONS_V1 (2026-10-02) — «ПРОСЛУШАТЬ»: ПОЧЕМУ ЗАПИСИ НЕТ,
// СЛОВАМИ, И ПОВТОР, ПОКА СТАНЦИЯ ЕЁ ГОТОВИТ.
//
// Владелец: оператор нажал «Прослушать» на входящем звонке через пару минут
// после разговора и прочёл «Записи этого разговора у станции нет.». Запись
// была — onlinePBX отдал её по тому же звонку чуть позже. Прежде любой отказ
// станции (нет связи, «не чаще», ошибка, ключ, ещё не готова) читался одним
// «записи нет», и оператор делал вывод «прослушивание не работает».
//
// ОДНО МЕСТО на сроки и слова: его читают сервер (rpc/telephony.js —
// «готовится» или «нет», повтор при сбое связи), карточка заявки
// (views/crm.js) и EasyPhone (phone/public/app.js; phone/index.js отдаёт этот
// файл по тому же пути). Модуль без зависимостей — иначе EasyPhone пришлось
// бы раздавать и их.
//
// Слова — ключи словаря i18n-strings.js: карточка переводит их tr()/trf(),
// EasyPhone показывает по-русски, как и весь свой экран. Что каждое слово
// есть в словаре на трёх языках, проверяет call-recording.test.js.

/** Разговор кончился меньше этого назад, а ссылки нет — запись ещё готовится. */
export const RECORDING_NOT_READY_WINDOW_MS = 10 * 60 * 1000;

/** Сервер: один повтор при сбое связи или ошибке станции — через эту паузу. */
export const RECORDING_SERVER_RETRY_MS = 1500;
export const RECORDING_SERVER_RETRY_REASONS = Object.freeze(['offline', 'server_error', 'bad_response']);

/** Экран: «готовится» — спрашиваем снова каждые 10 секунд, не больше 6 раз (около минуты). */
export const RECORDING_RETRY_EVERY_MS = 10 * 1000;
export const RECORDING_RETRY_TRIES = 6;

// Причина → одна фраза. Одна фраза на одно ДЕЙСТВИЕ оператора: server_error и
// bad_response у него одинаковые («попробуйте ещё раз»), поэтому и слово одно.
export const RECORDING_MESSAGES = Object.freeze({
  not_ready:       'Запись ещё готовится на станции — пробуем снова…',
  not_found:       'Записи этого разговора у станции нет.',
  not_supported:   'Эта телефония записи не отдаёт.',
  no_talk:         'Разговора не было — записывать нечего.',
  no_line:         'Линия этого звонка удалена из настроек телефонии — запись недоступна.',
  offline:         'Нет связи с onlinePBX — проверьте интернет и попробуйте ещё раз.',
  rate_limited:    'onlinePBX просит не чаще — попробуйте через минуту.',
  bad_credentials: 'Ключ onlinePBX не подходит — проверьте настройки телефонии.',
  server_error:    'onlinePBX ответил ошибкой — попробуйте ещё раз.',
  bad_response:    'onlinePBX ответил ошибкой — попробуйте ещё раз.',
});

/** Надпись на кнопке, пока ждём: «Запись готовится… (2/6)». */
export const RECORDING_WAITING = 'Запись готовится… ({n}/{max})';
/** Минута прошла, а станция всё готовит. */
export const RECORDING_GAVE_UP = 'Запись ещё не готова — попробуйте через минуту.';

/**
 * Фраза для причины. Ответ без причины (старый сервер) или незнакомая
 * причина — прежнее «записи нет».
 */
export function recordingMessage(reason) {
  return Object.prototype.hasOwnProperty.call(RECORDING_MESSAGES, reason)
    ? RECORDING_MESSAGES[reason]
    : RECORDING_MESSAGES.not_found;
}

/** {n} и {max} в шаблоне — для экрана без словаря (EasyPhone). */
export function fillRecordingText(template, params) {
  let out = String(template);
  for (const [k, v] of Object.entries(params || {})) out = out.split('{' + k + '}').join(String(v));
  return out;
}

const isNotReady = (r) => !!r && !r.url && r.reason === 'not_ready';
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Спросить запись; пока станция отвечает «готовится» — спрашивать снова,
 * каждые `every` мс, не больше `tries` раз.
 *
 *   ask()            — один запрос; ответ сервера {url} | {url:'', reason}.
 *                      Ошибку (отказ прав, сбой запроса) бросает — она уходит
 *                      наверх как есть, повторять её незачем.
 *   onWait(n, max)   — перед n-м повтором: экран пишет «(n/max)» на кнопке.
 *   alive()          — экран ещё на месте? Карточку закрыли или журнал
 *                      перерисовался — дальше станцию не тревожим.
 *
 * Итог: ответ сервера; при исчерпанных повторах — {url:'', reason:'not_ready',
 * gave_up:true}; если экран ушёл — {url:'', reason:'gone'} (показывать нечего).
 */
export async function askRecordingUntilReady(ask, {
  onWait = () => {},
  alive = () => true,
  sleep = defaultSleep,
  every = RECORDING_RETRY_EVERY_MS,
  tries = RECORDING_RETRY_TRIES,
} = {}) {
  let r = await ask();
  for (let n = 1; isNotReady(r) && n <= tries; n++) {
    if (!alive()) return { url: '', reason: 'gone' };
    onWait(n, tries);
    await sleep(every);
    if (!alive()) return { url: '', reason: 'gone' };
    r = await ask();
  }
  if (isNotReady(r)) return { url: '', reason: 'not_ready', gave_up: true };
  return r || { url: '', reason: 'not_found' };
}
