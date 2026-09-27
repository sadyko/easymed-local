// V3120_FINAL — ЧИСЛО СТРОК, СДВИГ И СТРОКА ПОИСКА ИЗ АРГУМЕНТОВ RPC.
//
// procedures_list, lis_recent, telegram_chats_list, telegram_chat_messages
// передавали limit прямо в SQL: {a:1}, "abc", [ ] превращались в NaN, SQLite
// отвечал «datatype mismatch», и человек видел «Ошибка сервера» (500).
// documents_feed искал по строке любой длины — 100 000 символов роняли LIKE.
// Экраны шлют числа и короткие строки; всё остальное — ошибка вызова, и
// ответ на неё — понятный 400, а не 500.

export const PAGE_ARG_REFUSED = 'Число строк или сдвиг указаны неверно: нужно целое число.';
export const SEARCH_TOO_LONG = 'Строка поиска слишком длинная — не больше 200 символов.';
export const SEARCH_NOT_TEXT = 'Строка поиска указана неверно: нужен текст.';

export class PageArgError extends Error {
  constructor(message) { super(message); this.status = 400; this.code = 'bad_request'; }
}

/**
 * Целое из аргумента: нет значения — def; число или строка из цифр —
 * прижатое к [min, max]; всё прочее (объект, массив, текст, NaN) — 400.
 */
export function pageInt(v, { def, min = 0, max }) {
  if (v === undefined || v === null || v === '') return def;
  let n = NaN;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && /^\s*-?\d{1,12}\s*$/.test(v)) n = Number(v);
  if (!Number.isFinite(n)) throw new PageArgError(PAGE_ARG_REFUSED);
  // Число вне пределов — не ошибка, а просьба «побольше/поменьше»: прижимаем.
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** Строка поиска: нет — ''; не текст или длиннее max — 400. */
export function searchArg(v, { max = 200 } = {}) {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string' && typeof v !== 'number') throw new PageArgError(SEARCH_NOT_TEXT);
  const s = String(v).trim();
  if (s.length > max) throw new PageArgError(SEARCH_TOO_LONG);
  return s;
}
