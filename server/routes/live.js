// LIVE_REFRESH_V1 (3.22.0, владелец 2026-11-08) — ПОТОК ИЗМЕНЕНИЙ ДЛЯ РАБОЧИХ ЭКРАНОВ.
//
//   GET /api/live          — Server-Sent Events. Кадры:
//       retry: 3000                     — через сколько браузеру переподключаться;
//       event: hello  data: {"v":N}     — текущая версия, сразу после подключения;
//       id: N  event: change  data: {"v":N,"tables":[…],"rpc":[…]}  — записано;
//       : hb                            — пульс раз в HEARTBEAT_MS (держит соединение
//                                         живым в прокси и роутерах и проверяет сессию).
//     Догоняющий (?since=N или заголовок Last-Event-ID, который браузер ставит сам
//     при переподключении) сразу получает одно событие с пропущенным:
//       {"v","tables","rpc"} или {"v","reset":true,…} — «могло измениться всё».
//   GET /api/live/version?since=N — то же JSON-ом, для запасного опроса, когда
//     EventSource недоступен или поток рвётся.
//
// Вход — как у всех /api: сессия (cookie), без неё 401 (requireAuth в app.js), смена
// пароля по умолчанию — 403, кончившийся вход от имени — 409. Лицензия на чтение не
// влияет: поток только читает, и клиника с просроченной лицензией видит свои экраны
// живыми. Фоновые запросы: сессию не продлевают (middleware/auth.js), в журнал
// медленных запросов не пишутся (middleware/slow-log.js), gzip их не копит
// (middleware/compress.js — text/event-stream не сжимается). Таймаутов ответа сервер
// не ставит (server.timeout = 0 у Node), так что поток живёт, пока жива вкладка.
import { Router } from 'express';
import { liveBusFor } from '../services/live/bus.js';
import { sessionUser } from '../services/auth.js';

export const HEARTBEAT_MS = 25000;
export const RETRY_MS = 3000;
const MAX_BACKLOG = 64 * 1024;

const frame = (ev) => `id: ${ev.v}\nevent: change\ndata: ${JSON.stringify(ev)}\n\n`;

export function liveRoutes(db, { heartbeatMs = HEARTBEAT_MS } = {}) {
  const r = Router();
  const beat = Math.max(10, Number(heartbeatMs) || HEARTBEAT_MS);

  r.get('/version', (req, res) => {
    const bus = liveBusFor(db);
    res.set('Cache-Control', 'no-store');
    if (!bus) return res.status(503).json({ error: { code: 'live_unavailable', message: 'Обновление экранов недоступно.' } });
    return res.json(bus.since(req.query.since));
  });

  r.get('/', (req, res) => {
    const bus = liveBusFor(db);
    if (!bus) return res.status(503).json({ error: { code: 'live_unavailable', message: 'Обновление экранов недоступно.' } });
    req.__liveStream = true;   // slow-log.js: поток — не «медленный запрос»
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');   // прокси (nginx) не копит поток
    res.flushHeaders();
    try { req.socket.setNoDelay(true); req.socket.setTimeout(0); } catch { /* сокет уже закрыт */ }

    let done = false;
    let hb = null;
    let unsub = () => {};
    const cleanup = () => {
      if (done) return;
      done = true;
      if (hb) clearInterval(hb);
      unsub();
    };
    const send = (text) => {
      if (done) return;
      // Сокет перестал принимать (ПК выключили без закрытия соединения): события
      // копились бы в памяти сервера до таймаута TCP. Больше 64 КБ невыкачанного —
      // поток закрывается; живая вкладка переподключится сама.
      if (res.writableLength > MAX_BACKLOG) { cleanup(); try { res.destroy(); } catch { /* уже закрыт */ } return; }
      try { res.write(text); } catch { cleanup(); }
    };

    send(`retry: ${RETRY_MS}\n\n`);
    send(`event: hello\ndata: ${JSON.stringify({ v: bus.version })}\n\n`);
    const since = req.get('Last-Event-ID') || req.query.since;
    if (since != null && since !== '') {
      const c = bus.since(since);
      if (c.reset || (Array.isArray(c.tables) && (c.tables.length || c.rpc.length))) send(frame(c));
    }
    unsub = bus.subscribe((ev) => send(frame(ev)));
    // Пульс заодно сверяет сессию: вышел, истекла, отключён — поток закрывается,
    // и названия таблиц больше не идут тому, кто уже не в системе.
    hb = setInterval(() => {
      let alive = false;
      try { alive = !!sessionUser(db, req.sessionId, { background: true }); } catch { alive = false; }
      if (!alive) { cleanup(); try { res.end(); } catch { /* уже закрыт */ } return; }
      send(': hb\n\n');
    }, beat);
    if (typeof hb.unref === 'function') hb.unref();
    req.on('close', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);
  });

  return r;
}
