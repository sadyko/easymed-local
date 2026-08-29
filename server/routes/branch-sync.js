import { Router } from 'express';
import { exportCatalogue } from '../services/branch-sync/catalogue.js';
import { readPairing, verifySignature, skewMs, MAX_SKEW_MS, CATALOGUE_PATH } from '../services/branch-sync/pairing.js';

// BRANCH_SYNC_V1 — сторона ГЛАВНОГО филиала: единственная точка, из которой
// другой филиал забирает справочник.
//
// Смонтирован рядом с телефонными вебхуками и по той же причине: запрос
// приходит от другой УСТАНОВКИ, а не из браузера сотрудника, и cookie сессии у
// него нет — requireAuth ответил бы 401 на каждый честный запрос. Поэтому
// маршрут гейтит себя сам: подпись на общем секрете пары, сверенная за
// постоянное время, плюс окно по времени.
//
// ЗАБИРАЕТ ПРИЁМНИК, а не рассылает источник. Так у главного филиала нет ни
// одного открытого наружу входа, который бы он инициировал, второй филиал сам
// решает, когда синхронизироваться (в клинике это «не в приёмные часы»), и —
// главное — направление данных совпадает с направлением доверия: получатель
// приносит изменения к себе и сам же снимает перед этим резервную копию.
//
// Ответы:
//   404 — эта установка не главный филиал. Именно 404, а не 403: наличие или
//         отсутствие роли не должно быть видно тому, кто просто щупает порт
//         (то же правило, что у telephony/webhooks.js).
//   401 — подпись не сошлась. Без подробностей.
//   401 + reason 'clock_skew' — подпись ВЕРНА, но часы разъехались. Причина
//         сообщается уже проверенной стороне, и это единственная ошибка,
//         которую невозможно диагностировать снаружи: экран филиала должен
//         сказать «сверьте часы», а не «ключ не подходит».
export function branchSyncRoutes(db, dataDir, { now = () => Date.now() } = {}) {
  const r = Router();

  r.get('/catalogue', (req, res) => {
    const pairing = readPairing(dataDir);
    if (!pairing || pairing.role !== 'main') {
      return res.status(404).json({ error: { code: 'not_found', message: 'Unknown API endpoint.' } });
    }

    const group = String(req.get('x-em-branch-group') || '');
    const ts = String(req.get('x-em-branch-ts') || '');
    const sig = String(req.get('x-em-branch-sig') || '');

    // Идентификатор группы проверяется ВНУТРИ подписи (он входит в подписываемую
    // строку), а не отдельным сравнением: чужая группа не сможет предъявить
    // подпись на нашем секрете, поэтому отдельная проверка ничего не добавляет,
    // зато отдельный ответ «такой группы нет» подтверждал бы гадающему, какая
    // группа существует.
    const ok = verifySignature({
      secret: pairing.secret,
      groupId: group,
      ts,
      requestPath: CATALOGUE_PATH,
      sig,
    });
    if (!ok) return res.status(401).json({ error: { code: 'unauthorized', message: 'Not authorised.' } });

    if (skewMs(ts, now()) > MAX_SKEW_MS) {
      return res.status(401).json({ error: { code: 'clock_skew', message: 'Request timestamp is out of range.' } });
    }

    // no-store, а не no-cache: между филиалами может стоять прокси, и
    // справочник с ценами не должен лежать в чужом кэше ни секунды.
    res.set('Cache-Control', 'no-store');
    return res.json({
      ok: true,
      group_id: pairing.group_id,
      catalogue: exportCatalogue(db),
    });
  });

  return r;
}
