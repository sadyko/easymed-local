// V3120_I18N — собранные сообщения сервера, которые экран умеет перевести.
//
// tr() узнаёт только ЦЕЛУЮ строку словаря, поэтому фраза, собранная сервером
// вокруг значения («Не хватает 3 шт. — Бинт»), раньше оставалась русской на
// узбекском и английском экране. Сервер теперь присылает рядом с готовым
// `message` его шаблон (`template`, ключ словаря с {дырками}) и значения
// (`params`) — см. server/services/server-message.js.
//
// Слой запросов (supabase.js rpc, db-client.js) запоминает здесь пару
// «готовая фраза → шаблон + значения», а tr() при промахе словаря спрашивает
// эту память. Так переводится сообщение, куда бы экран его ни вывел — toast(),
// h(), throw new Error(error.message) — без правки сотен мест вызова. Сам
// `error.message` остаётся русским: экраны, которые сверяют текст ошибки
// регуляркой, работают как раньше.
//
// Модуль без зависимостей: его импортируют и слой запросов, и i18n.js.

const MAX = 200;
const REMEMBERED = new Map();

export function rememberServerMessage(error) {
  if (!error || typeof error.message !== 'string' || !error.message) return;
  if (typeof error.template !== 'string' || !error.template) return;
  const params = error.params && typeof error.params === 'object' ? error.params : {};
  REMEMBERED.delete(error.message);
  REMEMBERED.set(error.message, { template: error.template, params });
  while (REMEMBERED.size > MAX) REMEMBERED.delete(REMEMBERED.keys().next().value);
}

export function lookupServerMessage(message) {
  return REMEMBERED.get(message) || null;
}

// Только для тестов.
export function _resetServerMessages() { REMEMBERED.clear(); }
