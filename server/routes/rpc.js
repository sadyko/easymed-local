import { Router } from 'express';
import { getRpc } from '../services/rpc/index.js';
import { isReadOnlyRpc, isAlwaysAllowedRpc, isReadRpc, lockedResponse } from '../services/control/gate.js';   // LICENCE_CORE_V1 · isReadRpc: LIVE_REFRESH_V1
import { liveBusFor } from '../services/live/bus.js';   // LIVE_REFRESH_V1 — «записано» для живых экранов
import { recordEvent } from '../services/ops-log.js';   // OPS_EVENTS_V1
import { constraintRefusal, errorBody, fillTemplate } from '../services/server-message.js';   // V3120_I18N
import { dispatchRpc } from '../services/report-pool.js';   // V3120_PERF — тяжёлые отчёты в пуле потоков
import { actAsRecheck } from '../services/act-as.js';   // ADMIN_ACT_AS_V1 (ревью, LOW 7)

export function rpcRoutes(db) {
  const r = Router();
  // TELEGRAM_BOT_V1 — обработчик теперь МОЖЕТ быть асинхронным.
  //
  // Раньше здесь стоял голый вызов, и промис уходил в res.json() как `{}` —
  // молча, без ошибки. Пока все RPC были синхронными (SQLite через
  // better-sqlite3 синхронен), это не проявлялось; telegram_test_connection
  // ходит в сеть и стал первым исключением. `await` на несинхронном значении
  // — no-op, поэтому для остальных RPC ничего не меняется, но следующий
  // асинхронный обработчик не наступит на ту же тихую пустоту.
  r.post('/:name', async (req, res) => {
    // LICENCE_CORE_V1 — default deny, checked BEFORE the `!handler` 501 below,
    // not after it. An unclassified name must fail shut whether or not it
    // happens to be implemented: checking existence first would mean 501 vs 402
    // itself reveals which RPC names are real, and a name that is registered
    // LATER but never added to READ_ONLY_RPCS would work by accident until the
    // day it is actually tried against a locked clinic. Pinned by the
    // "unknown RPC" case in licence-gate.test.js — some_future_rpc has no
    // handler at all and must still come back 402, not 501, while locked.
    if (req.control?.locked
        && !isAlwaysAllowedRpc(req.params.name)
        && !isReadOnlyRpc(req.params.name)) {
      return lockedResponse(res, req.control);
    }
    const handler = getRpc(req.params.name);
    if (!handler) {
      // V3120_I18N — по-русски и с шаблоном: код rpc_not_implemented — то, по
      // чему экраны узнают этот ответ, текст — только для человека.
      const template = 'Сервер не знает операцию {name} — обновите программу.';
      const params = { name: req.params.name };
      return res.status(501).json({ error: { code: 'rpc_not_implemented', message: fillTemplate(template, params), template, params } });
    }
    // ADMIN_ACT_AS_V1 (ревью безопасности, LOW 7) — дверь с большим телом
    // (visit_document_archive, app.js authBeforeBigBody) прочла сессию ДО тела:
    // перед самой записью — ещё раз (services/act-as.js actAsRecheck).
    if (req.__userAttached) {
      const drift = actAsRecheck(db, req);
      if (drift) return res.status(drift.status).json({ error: drift.error });
    }
    // LIVE_REFRESH_V1 (3.22.0, владелец 2026-11-08) — ПОСЛЕ УСПЕШНОГО RPC, КОТОРЫЙ ПИСАЛ,
    // шина получает его имя и таблицы, которые поймала база. Рамка — только на
    // синхронную часть вызова (а это почти все RPC: better-sqlite3 синхронен): после
    // первого await в неё вклинились бы чужие запросы. Запись после await у асинхронных
    // RPC база ловит и так, вне рамки. «Писал» — по total_changes() соединения, а не
    // по списку: половина RPC вне READ_ONLY_RPCS — чистое чтение (queue_board,
    // procedures_list, …), и иначе каждый опрос экрана будил бы все экраны клиники.
    // Отказ (исключение) — пойманное выбрасывается: откатившаяся запись не будит никого.
    const live = liveBusFor(db);
    const liveScope = live ? live.open() : null;
    const changesBefore = live ? live.totalChanges(db) : 0;
    let liveHeld = null;
    let pending;
    try {
      // V3120_PERF — отчёт (POOLED_RPCS) считается в потоке отчётов, если пул
      // включён при запуске; иначе — здесь же, как прежде. dispatchRpc — async:
      // синхронный обработчик выполняется целиком уже здесь, до первого await.
      pending = dispatchRpc(db, req.params.name, handler, req.body || {}, req.user);
    } finally {
      liveHeld = liveScope ? liveScope.end() : null;   // LIVE_REFRESH_V1 — синхронная часть позади
    }
    try {
      const data = await pending;
      if (live) {   // LIVE_REFRESH_V1 — успех: событие, если RPC что-то записал
        try {
          const wrote = !isReadRpc(req.params.name) && live.totalChanges(db) !== changesBefore;
          if (wrote || (liveHeld && liveHeld.size)) live.bump({ tables: [...(liveHeld || [])], rpc: wrote ? [req.params.name] : [] });
        } catch { /* событие — не повод испортить ответ */ }
      }
      return res.json({ data });
    } catch (e) {
      // V3120_I18N — нарушение ограничения SQLite внутри обработчика — это
      // отказ по данным (409/400) русскими словами, а не безликое «ошибка
      // сервера». Код SQLite не прячется: sqlite_code и detail едут рядом.
      const refusal = !e.status && constraintRefusal(e);
      if (refusal) {
        return res.status(refusal.status).json({ error: {
          ...errorBody(refusal.code, refusal), sqlite_code: refusal.sqlite_code, detail: refusal.detail,
        } });
      }
      const status = e.status || 500;
      if (status >= 500) {
        console.error('[rpc]', req.params.name, e.message);
        // OPS_EVENTS_V1 — this branch answers the request directly (never
        // calls next(e)), so app.js's global error handler NEVER sees an RPC
        // failure; without this line every 500 from the app's main
        // business-logic surface would be invisible to the error counter.
        // req.params.name is a fixed-vocabulary code identifier (the RPC
        // registry key), not user data — same reasoning as the RPC name
        // already being safe to console.log above.
        recordEvent(db, 'server_error', '/api/rpc/' + req.params.name);
        return res.status(500).json({ error: { code: 'internal', message: 'Ошибка сервера. Повторите позже.' } });
      }
      // Код обработчика (например, ref_row_missing из service_save) важнее
      // статусного: по нему диалог переводит ошибку с динамикой через словарь
      // (шаблон + params, подстановка после перевода). До этого маршрут
      // перезаписывал code статусом, и любой назначенный код умирал здесь.
      // V3120_I18N — template (фраза с {дырками}, ключ словаря) едет вместе с
      // params, чтобы клиент перевёл собранную фразу, а не показал её по-русски.
      return res.status(status).json({ error: {
        code: e.code || (status === 403 ? 'forbidden' : 'bad_request'),
        message: e.message,
        ...(e.template ? { template: e.template } : {}),
        ...(e.params ? { params: e.params } : {}),
        // DOCTOR_PROFILE_V1 (ревью шага 5, №11) — поле отказа: экран ставит его под полем.
        ...(typeof e.field === 'string' && e.field ? { field: e.field } : {}),
      } });
    }
  });
  return r;
}
