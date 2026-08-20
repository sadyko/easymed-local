// TELEGRAM_BOT_V1 — тонкий клиент Bot API.
//
// Без npm-зависимости: Bot API — это обычный HTTPS с JSON, а в Node 18+ есть
// глобальный fetch. Проект остаётся на трёх зависимостях (bcryptjs,
// better-sqlite3, express), и не приходится тащить пакет, который умеет в
// сто раз больше, чем нам нужно, и обновляется отдельно от нас.
//
// Транспорт инжектируется (`fetchImpl`) — тесты подсовывают свой и не ходят
// в сеть.

const API_BASE = 'https://api.telegram.org';

// Ошибка, у которой есть человекочитаемое сообщение для администратора.
// Telegram отвечает 401 на неверный токен и 404 на несуществующий метод —
// «HTTP 401» в интерфейсе настроек не говорит ничего, «неверный токен» говорит.
export class TelegramError extends Error {
  constructor(message, { status = 0, description = '' } = {}) {
    super(message);
    this.name = 'TelegramError';
    this.status = status;
    this.description = description;
  }
}

function humanize(status, description) {
  if (status === 401) return 'Telegram отклонил токен. Проверьте, что скопирован весь токен из @BotFather.';
  if (status === 404) return 'Telegram не знает такого бота — возможно, токен отозван в @BotFather.';
  if (status === 429) return 'Слишком много запросов к Telegram. Подождите минуту и повторите.';
  if (description) return 'Telegram: ' + description;
  return 'Telegram ответил ошибкой ' + status + '.';
}

// Один вызов Bot API. Таймаут обязателен: на клинической машине без интернета
// запрос иначе висит, а вместе с ним висит и «Проверить связь» в настройках.
export async function callApi(token, method, params = {}, { fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
  if (!token) throw new TelegramError('Токен бота не задан.');
  let res;
  try {
    res = await fetchImpl(`${API_BASE}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    // Сюда попадает и таймаут, и отсутствие сети. Для администратора это одно
    // и то же действие: проверить интернет на сервере.
    const why = e && (e.name === 'TimeoutError' || e.name === 'AbortError')
      ? 'Telegram не ответил за 10 секунд.'
      : 'Не удалось связаться с Telegram.';
    throw new TelegramError(why + ' Проверьте интернет на сервере клиники.');
  }

  let body = null;
  try { body = await res.json(); } catch { body = null; }

  if (!res.ok || !body || body.ok !== true) {
    const description = (body && body.description) || '';
    throw new TelegramError(humanize(res.status, description), { status: res.status, description });
  }
  return body.result;
}

// Длинный опрос. Telegram держит соединение до timeout секунд и отвечает сразу,
// как появится обновление, — поэтому опрос НЕ создаёт постоянного трафика и не
// требует открытого порта на сервере клиники (соединение исходящее).
//
// HTTP-таймаут заведомо больше телеграмовского: обрывать соединение раньше,
// чем Telegram успеет ответить, — это терять обновления и жечь запросы.
export async function getUpdates(token, { offset = 0, timeout = 25, fetchImpl } = {}) {
  return callApi(token, 'getUpdates', {
    offset, timeout, allowed_updates: ['message', 'callback_query'],
  }, { fetchImpl, timeoutMs: (timeout + 15) * 1000 });
}

export async function sendMessage(token, chatId, text, extra = {}, opts = {}) {
  return callApi(token, 'sendMessage', {
    chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra,
  }, opts);
}

export async function answerCallbackQuery(token, id, text = '', opts = {}) {
  return callApi(token, 'answerCallbackQuery', { callback_query_id: id, text }, opts);
}

// Убирает «часики» на нажатой кнопке, даже если дальше всё упало. Пациент не
// должен смотреть на подвисшую кнопку из-за нашей ошибки.
export async function ackQuietly(token, id, text = '', opts = {}) {
  try { await answerCallbackQuery(token, id, text, opts); } catch { /* не важно */ }
}

// Отправка файла идёт не JSON, а multipart. Node 18+ умеет FormData/Blob сам,
// поэтому пакет для загрузки файлов не нужен.
//
// Транспорт вынесен отдельно: sendDocument и sendPhoto отличаются одним полем
// формы, и вторая копия этой обработки ошибок разошлась бы с первой при первой
// же правке.
async function postMultipart(token, method, fd, { fetchImpl = globalThis.fetch, timeoutMs = 120000 } = {}, what = 'файл') {
  let res;
  try {
    res = await fetchImpl(`${API_BASE}/bot${token}/${method}`, {
      method: 'POST', body: fd, signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new TelegramError(`Не удалось отправить ${what} в Telegram: ` + ((e && e.message) || 'сеть недоступна'));
  }
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok || !body || body.ok !== true) {
    const description = (body && body.description) || '';
    throw new TelegramError(humanize(res.status, description), { status: res.status, description });
  }
  return body.result;
}

export async function sendDocument(token, chatId, buffer, filename, { caption = '', fetchImpl = globalThis.fetch, timeoutMs = 120000 } = {}) {
  const fd = new FormData();
  fd.append('chat_id', String(chatId));
  fd.append('document', new Blob([buffer]), filename);
  if (caption) { fd.append('caption', caption); fd.append('parse_mode', 'HTML'); }
  return postMultipart(token, 'sendDocument', fd, { fetchImpl, timeoutMs }, 'файл');
}

// TELEGRAM_BROADCAST_IMG_V1 — картинка 16:9 к рассылке.
//
// `photo` — либо БАЙТЫ (первая отправка, уходит multipart'ом), либо СТРОКА
// file_id (все последующие, уходит обычным JSON). Это не микрооптимизация: без
// переиспользования file_id один и тот же баннер загружался бы в Telegram
// заново для КАЖДОГО получателя, и рассылка на триста человек с обычного
// клинического канала заняла бы часы вместо минуты. Telegram рекомендует
// именно такой порядок.
//
// Подпись к картинке — максимум 1024 символа против 4096 у обычного
// сообщения. Обрезать текст клиники мы не вправе, поэтому решение «подпись или
// отдельным сообщением» принимает broadcast.js; здесь отправляем то, что дали.
export async function sendPhoto(token, chatId, photo, { caption = '', filename = 'photo.jpg', fetchImpl = globalThis.fetch, timeoutMs = 120000 } = {}) {
  if (typeof photo === 'string') {
    return callApi(token, 'sendPhoto', {
      chat_id: chatId, photo,
      ...(caption ? { caption, parse_mode: 'HTML' } : {}),
    }, { fetchImpl, timeoutMs });
  }
  const fd = new FormData();
  fd.append('chat_id', String(chatId));
  fd.append('photo', new Blob([photo]), filename);
  if (caption) { fd.append('caption', caption); fd.append('parse_mode', 'HTML'); }
  return postMultipart(token, 'sendPhoto', fd, { fetchImpl, timeoutMs }, 'картинку');
}

// Из ответа sendPhoto берём file_id САМОГО КРУПНОГО размера: Telegram отдаёт
// лестницу превью, и file_id мелкого превью разослал бы всем остальным
// пациентам размытую картинку вместо баннера.
export function photoFileId(result) {
  const sizes = (result && result.photo) || [];
  if (!Array.isArray(sizes) || !sizes.length) return null;
  const biggest = sizes.reduce((a, b) =>
    ((b.file_size || b.width || 0) > (a.file_size || a.width || 0) ? b : a));
  return biggest.file_id || null;
}

// TELEGRAM_BOT_SETUP_V1 — «витрина» бота в Telegram: команды в меню, описание
// на экране до первого сообщения и кнопка «Меню» рядом с полем ввода.
//
// Всё это живёт НЕ у нас, а на стороне Telegram, и настраивается один раз на
// токен. Раньше администратору пришлось бы делать это руками в @BotFather —
// то есть в другом приложении, по инструкции, которой у него нет; половина
// ботов так и остаётся без описания и без меню.
//
// language_code: пустая строка — язык по умолчанию. Отдельно шлём 'uz' и 'ru',
// чтобы Telegram показывал команды на языке интерфейса пациента.
export async function setMyCommands(token, commands, languageCode = '', opts = {}) {
  return callApi(token, 'setMyCommands', {
    commands, scope: { type: 'all_private_chats' },
    ...(languageCode ? { language_code: languageCode } : {}),
  }, opts);
}

export async function setMyDescription(token, description, languageCode = '', opts = {}) {
  return callApi(token, 'setMyDescription', {
    description, ...(languageCode ? { language_code: languageCode } : {}),
  }, opts);
}

export async function setMyShortDescription(token, shortDescription, languageCode = '', opts = {}) {
  return callApi(token, 'setMyShortDescription', {
    short_description: shortDescription, ...(languageCode ? { language_code: languageCode } : {}),
  }, opts);
}

export async function setChatMenuButton(token, opts = {}) {
  return callApi(token, 'setChatMenuButton', { menu_button: { type: 'commands' } }, opts);
}

// Проверка связи: единственный вызов, который нужен разделу настроек. Заодно
// отдаёт username — из него строятся ссылка t.me и QR-код для стойки.
export async function getMe(token, opts = {}) {
  const me = await callApi(token, 'getMe', {}, opts);
  return {
    id: String(me && me.id || ''),
    username: (me && me.username) || '',
    first_name: (me && me.first_name) || '',
    can_read_all_group_messages: !!(me && me.can_read_all_group_messages),
  };
}
