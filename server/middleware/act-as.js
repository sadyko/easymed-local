// ADMIN_ACT_AS_V1 (2026-10-28) — ПРОМЕЖУТОЧНЫЙ СЛОЙ ВХОДА ОТ ИМЕНИ.
//
// Стоит в app.js сразу после attachUser (до лицензии и маршрутов) и делает две
// вещи по req.actAs (middleware/auth.js):
//
//   1. ЖУРНАЛ ДЕЙСТВИЙ. Запрос администратора, работающего от имени сотрудника,
//      пишет строку act_as_actions по завершении ответа — с кодом ответа (отказ
//      — тоже действие, попытка):
//        • /api/db — запись (не select): «таблица.операция»;
//        • /api/rpc — каждый вызов: имя RPC;
//        • /api/users — запись (не GET): «МЕТОД /users/…»;
//        • /api/storage — загрузка и удаление файла: «МЕТОД /storage/корзина»
//          (без пути объекта).
//      Чтения не пишутся. Данных пациента нет: ни тела запроса, ни ответа —
//      только имена таблиц и RPC.
//   2. ВХОД ОТ ИМЕНИ КОНЧИЛСЯ САМ (2 часа, сотрудник отключён, …), а экран ещё
//      работает «от имени»: любой запрос API, кроме /api/auth, получает 409
//      act_as_ended, пока экран не скажет «Вернуться» (DELETE /api/auth/act-as).
//      Иначе следующая запись, задуманная от имени сотрудника (со штампами,
//      которые экран ставит сам), ушла бы от имени администратора без следа в
//      журнале.
import { recordActAsAction } from '../services/act-as.js';
import { ACT_AS_MESSAGES } from '../../public/js/shared/act-as.js';

const clean = (v) => String(v == null ? '?' : v).replace(/[^\w./ -]/g, '').slice(0, 80) || '?';
const pathOf = (req) => String(req.originalUrl || req.url || '').split('?')[0];
const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Что записать в журнал об этом запросе: { kind, name } или null (чтение, другой адрес). */
export function actAsEntry(req) {
  const path = pathOf(req);
  if ((path === '/api/db' || path === '/api/db/') && req.method === 'POST') {
    const op = req.body && req.body.op;
    if (op === 'select') return null;
    return { kind: 'db', name: clean(req.body && req.body.table) + '.' + clean(op) };
  }
  if (path.startsWith('/api/rpc/') && req.method === 'POST') {
    return { kind: 'rpc', name: clean(path.slice('/api/rpc/'.length)) };
  }
  if ((path === '/api/users' || path.startsWith('/api/users/')) && !READS.has(req.method)) {
    return { kind: 'users', name: req.method + ' ' + clean(path.slice('/api'.length)) };
  }
  // ADMIN_ACT_AS_V1 (задача 2) — второй путь записи: файлы (/api/storage —
  // загрузка и удаление). Пишется только корзина: в пути объекта бывает номер
  // пациента и имя файла, а журнал хранит одни имена таблиц, RPC и корзин.
  if (path.startsWith('/api/storage/') && !READS.has(req.method)) {
    const bucket = path.slice('/api/storage/'.length).split('/')[0];
    return { kind: 'storage', name: req.method + ' /storage/' + clean(bucket) };
  }
  return null;
}

export function actAsGuard(db) {
  return (req, res, next) => {
    const st = req.actAs;
    if (!st) return next();
    const path = pathOf(req);
    if (st.ended) {
      if (path.startsWith('/api/') && !/^\/api\/auth(\/|$)/.test(path)) {
        return res.status(409).json({ error: { code: 'act_as_ended', message: ACT_AS_MESSAGES.ended, reason: st.ended } });
      }
      return next();
    }
    if (st.id != null && req.user && req.user.acting_admin) {
      const entry = actAsEntry(req);
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
