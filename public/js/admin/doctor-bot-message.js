// DOCTOR_BOT_TEMPLATE_V1 (владелец, 2026-11-20: «can you show in here, and make it
// editable») — текст уведомления врачу-источнику задаёт клиника. Один модуль на
// оба конца: сервер собирает им настоящие уведомления (doctor-bot/notify.js),
// вкладка «Реферирование → Telegram-бот» — образец под полем ввода. Образец не
// может разойтись с тем, что получит врач, потому что это тот же код.
//
// Шаблон — обычный текст. Вместо {пациент} встаёт ФИО жирным, вместо {дата} —
// день визита, вместо {услуги} — список услуг, каждая с новой строки через «•»
// (без цен — цены сюда не передаются вовсе). Всё остальное — как написано: текст
// шаблона экранируется для Telegram-HTML, поэтому «<» или «&» в нём не ломают
// сообщение и не превращаются в разметку.

/* i18n-exempt-start: текст сообщения врачу в Telegram (RU + UZ в одном тексте) и метки шаблона — данные, а не надписи экрана; на языке интерфейса не переводятся */
export const PLACEHOLDERS = Object.freeze({ patient: '{пациент}', date: '{дата}', services: '{услуги}' });

export const DEFAULT_TEMPLATE = [
  'Пациент {пациент} пришёл {дата}.',
  'Услуги:',
  '{услуги}',
  '',
  'Спасибо за доверие к нашей клинике!',
  '',
  'Bemor {пациент} {дата} kuni keldi.',
  'Klinikamizga bildirgan ishonchingiz uchun rahmat!',
].join('\n');

export const NO_SERVICES_TEXT = 'ещё не добавлены';
export const SEEN_BUTTON = 'Получил · Oldim';
/* i18n-exempt-end */
export const TEMPLATE_MAX = 2000;

const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/** Пустой или незаданный шаблон — стандартный. */
export function effectiveTemplate(t) {
  const s = String(t == null ? '' : t).replace(/\r\n?/g, '\n');
  return s.trim() ? s : DEFAULT_TEMPLATE;
}

/** Причина, по которой шаблон нельзя сохранить; '' — можно. Пустой — «вернуть стандартный». */
export function templateProblem(t) {
  const s = String(t == null ? '' : t);
  if (!s.trim()) return '';
  if (s.length > TEMPLATE_MAX) return 'Текст сообщения слишком длинный — не больше 2000 знаков.';
  if (!s.includes(PLACEHOLDERS.patient)) return 'В тексте должно быть {пациент} — иначе врач не узнает, о ком сообщение.';
  return '';
}

/**
 * Готовый текст для Telegram (parse_mode HTML).
 * @param {string} template  шаблон клиники ('' — стандартный)
 * @param {{patient:string, day:string, services:string[]}} v
 */
export function renderDoctorMessage(template, { patient, day, services = [] }) {
  const list = services.length ? services.map((s) => '• ' + esc(s)).join('\n') : esc(NO_SERVICES_TEXT);
  const values = { [PLACEHOLDERS.patient]: '<b>' + esc(patient) + '</b>', [PLACEHOLDERS.date]: esc(day), [PLACEHOLDERS.services]: list };
  // Делим по меткам, экранируем только текст между ними — подставленное уже готово.
  return effectiveTemplate(template)
    .split(/(\{пациент\}|\{дата\}|\{услуги\})/)
    .map((part) => (Object.prototype.hasOwnProperty.call(values, part) ? values[part] : esc(part)))
    .join('');
}
