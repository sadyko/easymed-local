// V3120_I18N — сообщения сервера, которые экран может перевести.
//
// Клиент переводит сообщение сервера через tr(), а tr() узнаёт только ЦЕЛУЮ
// строку словаря. Фраза, собранная вокруг значения («Не хватает 3 шт. — Бинт»),
// в словаре не найдётся никогда, и узбекский экран показывал её по-русски.
//
// Лекарство то же, что на экранах (trf): русская фраза с {дырками} — это ключ
// словаря, значения едут отдельно. Ошибка несёт:
//   message  — готовая русская фраза (логи, старые клиенты, русский экран);
//   template — та же фраза с {дырками} — ключ в public/js/admin/i18n-strings.js;
//   params   — значения дырок.
// routes/rpc.js и routes/db.js передают template+params клиенту, а клиент
// (public/js/shared/server-messages.js) переводит шаблон и подставляет значения.

// Подстановка значений в шаблон — та же семантика, что у trf() на клиенте:
// неизвестная дырка остаётся видимой, а не молча исчезает.
export function fillTemplate(template, params) {
  let out = String(template);
  for (const [k, v] of Object.entries(params || {})) out = out.split('{' + k + '}').join(String(v));
  return out;
}

// Навешивает на готовую ошибку шаблон и значения: message становится
// заполненной фразой. Возвращает ту же ошибку — удобно для `throw`.
export function withTemplate(err, template, params = {}) {
  err.message = fillTemplate(template, params);
  err.template = template;
  err.params = { ...(err.params || {}), ...params };
  return err;
}

// Короткая форма для RpcError любого из модулей (у каждого свой класс с
// конструктором (msg, status)):
//   throw rpcT(RpcError, 'Не хватает {qty} {unit} — {name}.', { qty, unit, name }, 409);
export function rpcT(ErrorClass, template, params = {}, status) {
  const err = status === undefined
    ? new ErrorClass(fillTemplate(template, params))
    : new ErrorClass(fillTemplate(template, params), status);
  return withTemplate(err, template, params);
}

// Нарушение ограничения SQLite → русская фраза для человека. Код SQLite не
// прячется: он уходит клиенту в `sqlite_code`, исходный текст — в `detail`
// (для логов и поддержки), а в `message` — то, что можно показать на экране.
// Отказ ТРИГГЕРА (RAISE(ABORT, '…')) — это уже правило клиники её словами, его
// текст остаётся как есть. Возвращает null, если ошибка — не нарушение
// ограничения.
export function constraintRefusal(e) {
  const code = e && e.code;
  if (typeof code !== 'string' || !code.startsWith('SQLITE_CONSTRAINT')) return null;
  const raw = String((e && e.message) || '');
  const column = (raw.match(/constraint failed:\s*(.+)$/i) || [])[1] || '';
  const base = { sqlite_code: code, detail: raw };
  if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
    const template = 'Такая запись уже есть: значение {column} должно быть уникальным.';
    const params = { column: column.trim() || '—' };
    return { ...base, status: 409, code: 'conflict', message: fillTemplate(template, params), template, params };
  }
  if (code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
    return { ...base, status: 409, code: 'conflict', message: 'Связанная запись не найдена или ещё используется в других данных.' };
  }
  if (code === 'SQLITE_CONSTRAINT_NOTNULL') {
    const template = 'Не заполнено обязательное поле {column}.';
    const params = { column: column.trim() || '—' };
    return { ...base, status: 400, code: 'bad_request', message: fillTemplate(template, params), template, params };
  }
  if (code === 'SQLITE_CONSTRAINT_CHECK') {
    return { ...base, status: 400, code: 'bad_request', message: 'Значение не прошло проверку базы данных — проверьте введённые данные.' };
  }
  // SQLITE_CONSTRAINT_TRIGGER / SQLITE_CONSTRAINT: текст правила клиники.
  return { ...base, status: 409, code: 'conflict', message: raw };
}

// Тело ответа об ошибке: code + message, и template/params, когда они есть.
export function errorBody(code, err) {
  return {
    code,
    message: err.message,
    ...(err.template ? { template: err.template } : {}),
    ...(err.params && Object.keys(err.params).length ? { params: err.params } : {}),
  };
}
