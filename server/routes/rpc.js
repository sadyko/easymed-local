import { Router } from 'express';
import { getRpc } from '../services/rpc/index.js';

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
    const handler = getRpc(req.params.name);
    if (!handler) {
      return res.status(501).json({ error: { code: 'rpc_not_implemented', message: 'RPC not implemented: ' + req.params.name } });
    }
    try {
      const data = await handler(db, req.body || {}, req.user);
      return res.json({ data });
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) {
        console.error('[rpc]', req.params.name, e.message);
        return res.status(500).json({ error: { code: 'internal', message: 'RPC failed.' } });
      }
      return res.status(status).json({ error: { code: status === 403 ? 'forbidden' : 'bad_request', message: e.message } });
    }
  });
  return r;
}
