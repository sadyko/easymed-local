// ADMIN_ACT_AS_V1 (2026-10-28) — ПРОМЕЖУТОЧНЫЙ СЛОЙ ВХОДА ОТ ИМЕНИ.
//
// Три вещи по req.actAs (middleware/auth.js):
//
//   1. ВХОД ОТ ИМЕНИ КОНЧИЛСЯ САМ (2 часа, сотрудник отключён, …), а экран ещё
//      работает «от имени»: любой запрос API, кроме /api/auth, получает 409
//      act_as_ended, пока экран не скажет «Вернуться» (DELETE /api/auth/act-as).
//      Иначе следующая запись, задуманная от имени сотрудника (со штампами,
//      которые экран ставит сам), ушла бы от имени администратора без следа в
//      журнале. — actAsEndedGuard, app.use('/api', …) сразу после attachUser.
//   2. ВКЛАДКИ (ревью безопасности, MEDIUM 3). Сессия одна на весь браузер, а
//      экран собран в каждой вкладке под своего человека. Вкладка шлёт номер
//      входа от имени, под который собрана (X-Em-Act-As; 0 — без него). Запись
//      (не GET) в /api/db, /api/rpc, /api/users, /api/storage с другим номером —
//      409 act_as_changed: вкладка, вернувшаяся в другой, не подпишет документ
//      врача от имени администратора, а админская вкладка не запишет от имени
//      врача. Без заголовка: пока сессия работает от имени — тоже отказ; без
//      входа от имени — как прежде (старые вкладки и другие страницы).
//      Чтения GET (картинки <img src>, скачивание файлов) не проверяются.
//   3. ЖУРНАЛ ДЕЙСТВИЙ. Запрос администратора, работающего от имени сотрудника,
//      пишет строку act_as_actions по завершении ответа — с кодом ответа (отказ
//      — тоже действие, попытка):
//        • /api/db — запись (не select): «таблица.операция»;
//        • /api/rpc — каждый вызов: имя RPC;
//        • /api/users — запись (не GET): «МЕТОД /users/…»;
//        • /api/storage — загрузка и удаление файла: «МЕТОД /storage/корзина»
//          (без пути объекта).
//      Чтения не пишутся. Данных пациента нет: ни тела запроса, ни ответа —
//      только имена таблиц и RPC.
//
// Ревью безопасности (HIGH 1) — 2 и 3 стоят ВНУТРИ монтирования каждого из
// четырёх маршрутов (actAsRouterGuard, app.js), а 1 — на всём /api: express
// сопоставляет пути без учёта регистра, и сравнение строк здесь пропускало
// /API/DB и /Api/Rpc мимо журнала и мимо 409. Что дошло до маршрута, то прошло
// и через проверку — каким бы ни был путь.
import { recordActAsAction, requestActAsId } from '../services/act-as.js';
import { ACT_AS_MESSAGES, ACT_AS_TAB_HEADER } from '../../public/js/shared/act-as.js';

const clean = (v) => String(v == null ? '?' : v).replace(/[^\w./ -]/g, '').slice(0, 80) || '?';
const READS = new Set(['GET', 'HEAD', 'OPTIONS']);
const firstSegment = (p) => {
  const seg = String(p || '').replace(/^\/+/, '').split('/')[0];
  try { return decodeURIComponent(seg); } catch { return seg; }
};

/**
 * Что записать в журнал: { kind, name } или null (чтение). kind — маршрут
 * (db | rpc | users | storage), rel — путь внутри него (req.path у маршрута).
 */
export function actAsEntryFor(kind, req, rel = req.path) {
  const method = String(req.method || '').toUpperCase();
  if (kind === 'db') {
    if (method !== 'POST') return null;
    const op = req.body && req.body.op;
    if (op === 'select') return null;
    return { kind: 'db', name: clean(req.body && req.body.table) + '.' + clean(op) };
  }
  if (kind === 'rpc') return method === 'POST' ? { kind: 'rpc', name: clean(firstSegment(rel)) } : null;
  if (READS.has(method)) return null;
  if (kind === 'users') {
    const tail = String(rel || '').replace(/\/+$/, '');
    return { kind: 'users', name: method + ' /users' + (tail ? clean(tail) : '') };
  }
  // ADMIN_ACT_AS_V1 (задача 2) — второй путь записи: файлы. Пишется только
  // корзина: в пути объекта бывает номер пациента и имя файла.
  if (kind === 'storage') return { kind: 'storage', name: method + ' /storage/' + clean(firstSegment(rel)) };
  return null;
}

/** То же по полному адресу запроса (регистр пути не важен) — для проверок и разбора. */
export function actAsEntry(req) {
  const full = String(req.originalUrl || req.url || '').split('?')[0];
  const m = /^\/api\/(db|rpc|users|storage)(?=\/|$)/i.exec(full);
  if (!m) return null;
  return actAsEntryFor(m[1].toLowerCase(), req, full.slice(m[0].length) || '/');
}

/**
 * Вкладка собрана под другой вход от имени, чем сейчас у сессии: true —
 * отказ. Номер вкладки — заголовок X-Em-Act-As (0 — без входа от имени).
 */
export function actAsTabMismatch(req) {
  const expected = requestActAsId(req);
  const raw = typeof req.get === 'function' ? req.get(ACT_AS_TAB_HEADER) : req.headers[ACT_AS_TAB_HEADER.toLowerCase()];
  if (raw === undefined || raw === null || String(raw).trim() === '') return expected !== 0;
  const n = Number(String(raw).trim());
  return !(Number.isInteger(n) && n === expected);
}

/** Тело ответа 409 act_as_changed. */
export const actAsChangedBody = () => ({ error: { code: 'act_as_changed', message: ACT_AS_MESSAGES.changed } });

/** 1 — вход от имени кончился сам: 409 на всём /api, кроме /api/auth (регистр не важен). */
export function actAsEndedGuard() {
  return (req, res, next) => {
    const st = req.actAs;
    if (st && st.ended && !/^\/auth(\/|$)/i.test(req.path)) {
      return res.status(409).json({ error: { code: 'act_as_ended', message: ACT_AS_MESSAGES.ended, reason: st.ended } });
    }
    next();
  };
}

/** 2 и 3 — у монтирования маршрута kind (db | rpc | users | storage). */
export function actAsRouterGuard(db, kind) {
  return (req, res, next) => {
    if (READS.has(String(req.method || '').toUpperCase())) return next();
    if (req.user && actAsTabMismatch(req)) return res.status(409).json(actAsChangedBody());
    const st = req.actAs;
    if (st && st.id != null && req.user && req.user.acting_admin) {
      const entry = actAsEntryFor(kind, req);
      if (entry) {
        let done = false;
        const write = () => {
          if (done) return;
          done = true;
          try { recordActAsAction(db, st.id, entry.kind, entry.name, res.statusCode); }
          catch (e) { console.error('[act-as] действие не записано в журнал:', e && e.message); }
        };
        res.on('finish', write);
        res.on('close', write);   // клиент ушёл, не дождавшись ответа, — действие всё равно было
      }
    }
    next();
  };
}
