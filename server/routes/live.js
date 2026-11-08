// LIVE_REFRESH_V1 (3.22.0, владелец 2026-11-08) — ПОТОК ИЗМЕНЕНИЙ ДЛЯ РАБОЧИХ ЭКРАНОВ.
//
//   GET /api/live          — Server-Sent Events. Кадры:
//       retry: 2000…10000               — через сколько браузеру переподключаться
//                                         (у каждого подключения своё, ревью L1);
//       [догоняющее change — см. ниже]
//       event: hello  data: {"v":N}     — текущая версия;
//       id: N  event: change  data: {"v":N,"tables":[…]}  — записано (только таблицы,
//                                         которые смотрят экраны; имён RPC нет — ревью L2);
//       : hb                            — пульс раз в HEARTBEAT_MS (держит соединение
//                                         живым в прокси и роутерах и проверяет сессию);
//       event: ping  data: {"v":N}      — тот же пульс для вкладки: комментарий
//                                         EventSource не показывает, а по тишине
//                                         ping вкладка узнаёт зависший поток.
//     Догоняющий (?since=N или заголовок Last-Event-ID, который браузер ставит сам
//     при переподключении) ДО hello получает одно событие с пропущенным:
//       {"v","tables"} или {"v","tables":[],"reset":true} — «могло измениться всё».
//     Версия hello (и ping), не совпавшая с версией вкладки, — для вкладки сброс (ревью M2).
//   GET /api/live/version?since=N — то же JSON-ом, для запасного опроса, когда
//     EventSource недоступен или поток рвётся.
//   Выключено (EASYMED_LIVE=0, ревью M6): оба отвечают 503 {off:true, error.code:
//     'live_unavailable'}, и вкладка перестаёт стучаться.
//
// Вход — как у всех /api: сессия (cookie), без неё 401 (requireAuth в app.js), смена
// пароля по умолчанию — 403, кончившийся вход от имени — 409. Лицензия на чтение не
// влияет: поток только читает, и клиника с просроченной лицензией видит свои экраны
// живыми. Фоновые запросы: сессию не продлевают (middleware/auth.js), в журнал
// медленных запросов не пишутся (middleware/slow-log.js), gzip их не копит
// (middleware/compress.js — text/event-stream не сжимается). Таймаутов ответа сервер
// не ставит (server.timeout = 0 у Node), так что поток живёт, пока жива вкладка.
import { Router } from 'express';
import { liveBusFor, LIVE_TABLES } from '../services/live/bus.js';
import { sessionUser } from '../services/auth.js';

export const HEARTBEAT_MS = 25000;
// Ревью L1 — «retry:» у каждого подключения свой, 2–10 с: после перезапуска сервера
// (обновление, сбой) двадцать ПК клиники не переподключаются в одну и ту же секунду.
export const RETRY_MIN_MS = 2000;
export const RETRY_MAX_MS = 10000;
// Ревью L5 — не больше 8 потоков на одну сессию (вкладки одного браузера); девятый
// закрывает самый старый. Сокет, слушатель и пульс на каждый — не бесплатно.
export const MAX_STREAMS_PER_SESSION = 8;
const MAX_BACKLOG = 64 * 1024;
const WATCHED = new Set(LIVE_TABLES);
// Ревью M6 — выключено (EASYMED_LIVE=0, шины нет): и поток, и версия говорят «off».
const OFF_BODY = { off: true, error: { code: 'live_unavailable', message: 'Обновление экранов недоступно.' } };

/**
 * Ревью L2 — НАРУЖУ ТОЛЬКО ВЕРСИЯ И НАБЛЮДАЕМЫЕ ТАБЛИЦЫ. Имена RPC остаются на сервере
 * (шина), а таблицы — только те, что смотрят экраны (LIVE_TABLES): любой вошедший видел
 * бы, какие операции идут в клинике (возвраты, объединения карт, вход от имени). Событие
 * без наблюдаемых таблиц всё равно уходит — пустым: вкладка не теряет счёт версий (иначе
 * ping с новой версией выглядел бы пропуском, ревью M2).
 */
export function publicChange(ev) {
  const out = { v: ev.v, tables: (Array.isArray(ev.tables) ? ev.tables : []).filter((t) => WATCHED.has(t)) };
  if (ev.reset) out.reset = true;
  return out;
}
const frame = (ev) => {
  const p = publicChange(ev);
  return `id: ${p.v}\nevent: change\ndata: ${JSON.stringify(p)}\n\n`;
};

export function liveRoutes(db, { heartbeatMs = HEARTBEAT_MS, random = Math.random, maxPerSession = MAX_STREAMS_PER_SESSION } = {}) {
  const r = Router();
  const beat = Math.max(10, Number(heartbeatMs) || HEARTBEAT_MS);
  const perSession = new Map();   // ревью L5: номер сессии → открытые потоки (старые первыми)

  r.get('/version', (req, res) => {
    const bus = liveBusFor(db);
    res.set('Cache-Control', 'no-store');
    if (!bus) return res.status(503).json(OFF_BODY);
    const c = bus.since(req.query.since);
    return res.json(Array.isArray(c.tables) ? publicChange(c) : { v: c.v });
  });

  r.get('/', (req, res) => {
    const bus = liveBusFor(db);
    if (!bus) return res.status(503).json(OFF_BODY);
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
    const key = String(req.sessionId || '');
    const mine = { close: null };
    const cleanup = () => {
      if (done) return;
      done = true;
      if (hb) clearInterval(hb);
      unsub();
      const list = perSession.get(key);
      if (list) {
        const i = list.indexOf(mine);
        if (i >= 0) list.splice(i, 1);
        if (!list.length) perSession.delete(key);
      }
    };
    mine.close = () => { cleanup(); try { res.end(); } catch { /* уже закрыт */ } };
    // Ревью L5 — девятый поток сессии закрывает самый старый.
    {
      const list = perSession.get(key) || [];
      list.push(mine);
      perSession.set(key, list);
      while (list.length > maxPerSession) { const oldest = list[0]; oldest.close(); if (list[0] === oldest) list.shift(); }
    }
    const send = (text) => {
      if (done) return;
      // Сокет перестал принимать (ПК выключили без закрытия соединения): события
      // копились бы в памяти сервера до таймаута TCP. Больше 64 КБ невыкачанного —
      // поток закрывается; живая вкладка переподключится сама.
      if (res.writableLength > MAX_BACKLOG) { cleanup(); try { res.destroy(); } catch { /* уже закрыт */ } return; }
      try { res.write(text); } catch { cleanup(); }
    };

    let rnd = 0.5;
    try { rnd = Math.min(0.999999, Math.max(0, Number(random()) || 0)); } catch { /* по умолчанию середина */ }
    send(`retry: ${RETRY_MIN_MS + Math.floor(rnd * (RETRY_MAX_MS - RETRY_MIN_MS))}\n\n`);   // ревью L1
    // Ревью M2 — догоняющее событие ДО hello. Вкладка сверяет версию hello со своей:
    // догнали — версии совпали; не догнали (первый поток без ?since, часы сервера ушли
    // назад) — hello с другой версией вкладка считает «могло измениться всё».
    const since = req.get('Last-Event-ID') || req.query.since;
    if (since != null && since !== '') {
      const c = bus.since(since);
      if (c.reset || (Array.isArray(c.tables) && (c.tables.length || c.rpc.length))) send(frame(c));
    }
    send(`event: hello\ndata: ${JSON.stringify({ v: bus.version })}\n\n`);
    unsub = bus.subscribe((ev) => send(frame(ev)));
    // Пульс заодно сверяет сессию: вышел, истекла, отключён — поток закрывается,
    // и названия таблиц больше не идут тому, кто уже не в системе.
    hb = setInterval(() => {
      let alive = false;
      try { alive = !!sessionUser(db, req.sessionId, { background: true }); } catch { alive = false; }
      if (!alive) { cleanup(); try { res.end(); } catch { /* уже закрыт */ } return; }
      // Комментарий держит соединение в прокси; событие ping видит и сама вкладка:
      // по его тишине (сон ПК, Wi-Fi без разрыва, копящий прокси) она переподключается.
      send(`: hb\n\nevent: ping\ndata: ${JSON.stringify({ v: bus.version })}\n\n`);
    }, beat);
    if (typeof hb.unref === 'function') hb.unref();
    req.on('close', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);
  });

  return r;
}
