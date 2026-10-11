// PUBLIC_SERVER_V1 — ОШИБКИ ПУБЛИЧНОГО СЕРВЕРА: код — договор с партнёром и
// клиникой (документация API, «Ошибки и лимиты»), текст — пояснение на языке
// ?lang (по умолчанию русский). Тело ошибки: { error: { code, message, field?, reason? } }.
//
// ЖУРНАЛ БЕЗ ТЕЛ ЗАПРОСОВ (решение владельца 16): в текст ошибки и в журнал
// процесса никогда не попадает присланное — ни тело, ни его кусок. У ошибки
// разбора JSON сообщение содержит кусок тела (Node 24: «Unexpected token … "Иван…"»),
// поэтому журнал пишет только тип ошибки, а стек — без первой строки (safeStack).
export const ERRORS = Object.freeze({
  bad_request:        { status: 400, ru: 'Запрос составлен неверно.', uz: 'So‘rov noto‘g‘ri tuzilgan.', en: 'The request is malformed.' },
  bad_json:           { status: 400, ru: 'Тело запроса — не JSON.', uz: 'So‘rov tanasi JSON emas.', en: 'The request body is not valid JSON.' },
  invalid_field:      { status: 400, ru: 'Поле заполнено неверно — см. field и reason.', uz: 'Maydon noto‘g‘ri to‘ldirilgan — field va reason ga qarang.', en: 'A field is invalid — see field and reason.' },
  https_required:     { status: 400, ru: 'Только HTTPS.', uz: 'Faqat HTTPS.', en: 'HTTPS only.' },
  bad_slug:           { status: 400, ru: 'Имя клиники в адресе записано неверно.', uz: 'Manzildagi klinika nomi noto‘g‘ri yozilgan.', en: 'The clinic name in the address is invalid.' },
  invalid_key:        { status: 401, ru: 'Ключа нет или он неверный.', uz: 'Kalit yo‘q yoki noto‘g‘ri.', en: 'The key is missing or invalid.' },
  key_disabled:       { status: 401, ru: 'Ключ выключен клиникой.', uz: 'Kalit klinika tomonidan o‘chirilgan.', en: 'The key has been disabled by the clinic.' },
  key_expired:        { status: 401, ru: 'Срок действия ключа истёк.', uz: 'Kalitning amal qilish muddati tugagan.', en: 'The key has expired.' },
  invalid_signature:  { status: 401, ru: 'Подпись запроса клиники не сходится.', uz: 'Klinika so‘rovining imzosi mos kelmadi.', en: 'The clinic request signature does not match.' },
  licence_invalid:    { status: 401, ru: 'Лицензия клиники не прошла проверку.', uz: 'Klinika litsenziyasi tekshiruvdan o‘tmadi.', en: 'The clinic licence failed verification.' },
  licence_outdated:   { status: 401, ru: 'Прислана устаревшая лицензия клиники.', uz: 'Klinikaning eskirgan litsenziyasi yuborildi.', en: 'An outdated clinic licence was presented.' },
  clock_skew:         { status: 401, ru: 'Часы компьютера клиники расходятся с сервером.', uz: 'Klinika kompyuterining soati server bilan mos emas.', en: 'The clinic computer clock is out of sync with the server.' },
  forbidden_scope:    { status: 403, ru: 'У ключа нет доступа к этому разделу.', uz: 'Kalitga bu bo‘limga ruxsat berilmagan.', en: 'The key has no access to this section.' },
  ip_not_allowed:     { status: 403, ru: 'Запрос с этого IP-адреса не разрешён для ключа.', uz: 'Bu IP-manzildan so‘rov kalit uchun ruxsat etilmagan.', en: 'Requests from this IP address are not allowed for the key.' },
  origin_not_allowed: { status: 403, ru: 'Запрос с этого сайта не разрешён для ключа.', uz: 'Bu saytdan so‘rov kalit uchun ruxsat etilmagan.', en: 'Requests from this site are not allowed for the key.' },
  not_found:          { status: 404, ru: 'Не найдено или скрыто клиникой.', uz: 'Topilmadi yoki klinika tomonidan yashirilgan.', en: 'Not found or hidden by the clinic.' },
  clinic_not_found:   { status: 404, ru: 'Клиники с таким адресом нет.', uz: 'Bunday manzilli klinika yo‘q.', en: 'No clinic at this address.' },
  slot_taken:         { status: 409, ru: 'Это время уже занято — запросите /slots заново.', uz: 'Bu vaqt band — /slots ni qayta so‘rang.', en: 'This time is already taken — request /slots again.' },
  slug_taken:         { status: 409, ru: 'Это имя в адресе занято другой клиникой.', uz: 'Manzildagi bu nom boshqa klinika tomonidan band.', en: 'This address name is taken by another clinic.' },
  not_cancellable:    { status: 409, ru: 'Эту запись отменить уже нельзя.', uz: 'Bu yozuvni endi bekor qilib bo‘lmaydi.', en: 'This appointment can no longer be cancelled.' },
  not_offered:        { status: 409, ru: 'Клиника не предлагала другое время по этой записи.', uz: 'Klinika bu yozuv bo‘yicha boshqa vaqt taklif qilmagan.', en: 'The clinic has not offered another time for this appointment.' },
  offer_expired:      { status: 409, ru: 'Срок ответа на предложенное время истёк.', uz: 'Taklif qilingan vaqtga javob berish muddati tugagan.', en: 'The time to answer the offered slot has passed.' },
  too_large:          { status: 413, ru: 'Запрос слишком большой.', uz: 'So‘rov juda katta.', en: 'The request is too large.' },
  rate_limited:       { status: 429, ru: 'Превышен лимит запросов — подождите столько секунд, сколько в Retry-After.', uz: 'So‘rovlar chegarasi oshdi — Retry-After dagi soniyalar qadar kuting.', en: 'Rate limit exceeded — wait as many seconds as Retry-After says.' },
  internal:           { status: 500, ru: 'Ошибка сервера.', uz: 'Server xatosi.', en: 'Server error.' },
  licence_lapsed:     { status: 503, ru: 'Клиника временно недоступна. Позвоните в клинику.', uz: 'Klinika vaqtincha mavjud emas. Klinikaga qo‘ng‘iroq qiling.', en: 'The clinic is temporarily unavailable. Please call the clinic.' },
  clinic_offline:     { status: 503, ru: 'Клиника временно недоступна. Позвоните в клинику.', uz: 'Klinika vaqtincha mavjud emas. Klinikaga qo‘ng‘iroq qiling.', en: 'The clinic is temporarily unavailable. Please call the clinic.' },
});

export const LANGS = Object.freeze(['ru', 'uz', 'en']);

/** Язык ответа из ?lang; пусто или чужое — null. */
export function langOf(req) {
  const l = String((req && req.query && req.query.lang) || '').trim().toLowerCase();
  return LANGS.includes(l) ? l : null;
}

/**
 * Ответ ошибкой. extra — поля сверх кода (field, reason, phone, server_time…):
 * только значения, выбранные сервером, — никогда не присланное партнёром.
 */
export function sendError(req, res, code, extra = {}, headers = {}) {
  const e = ERRORS[code] || ERRORS.internal;
  const lang = langOf(req) || 'ru';
  for (const [k, v] of Object.entries(headers)) res.set(k, String(v));
  return res.status(e.status).json({ error: { code: ERRORS[code] ? code : 'internal', message: e[lang], ...extra } });
}

/** Стек без первой строки: сообщение ошибки может нести кусок присланного. */
export function safeStack(err) {
  return String((err && err.stack) || '').split('\n').slice(1, 8).join('\n');
}

/**
 * Последний обработчик express: разбор JSON и размер тела — ошибка партнёра с
 * кодом; прочее — 500. В журнал — только тип, код и стек без сообщения.
 */
export function errorHandler(log = console) {
  return (err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err && err.type === 'entity.parse.failed') return sendError(req, res, 'bad_json');
    if (err && err.type === 'entity.too.large') return sendError(req, res, 'too_large');
    const status = Number(err && (err.status || err.statusCode));
    if (status >= 400 && status < 500) {
      log.warn('[public-server] client error', status, (err && (err.type || err.code)) || '');
      return sendError(req, res, 'bad_request');
    }
    log.error('[public-server] server error', (err && err.name) || 'Error', (err && err.code) || '', '\n' + safeStack(err));
    return sendError(req, res, 'internal');
  };
}
