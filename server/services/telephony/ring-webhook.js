// CALL_RING_V1 (2026-10-17) — ПРЯМОЙ ПРИЁМ СОБЫТИЙ СТАНЦИИ НА КЛИНИКЕ.
//
// Для клиники, у которой есть публичный адрес (telephony_settings.public_base_url
// — тот же, что у вебхуков Binotel): кабинет onlinePBX шлёт события
// «начало / ответ / конец звонка» прямо сюда, POST /api/telephony/pbx/{token}, и
// панель «Телефон» видит звонок в момент звонка без публичного сервера.
// Большинство местных установок за NAT — им путь через публичный сервер
// (public-server/routes/pbx.js); разборщик у обоих один (pbx-event.js).
//
// ВОРОТА — КАК У ВЕБХУКОВ BINOTEL (webhooks.js): маршрут стоит ДО сессии (станция
// cookie не шлёт), поэтому проверяет своё сам: секрет адреса (сравнение без
// утечки по времени), включённый модуль колл-центра. Любой отказ — тот же
// неразличимый 404, что у всех неизвестных адресов API: чужой запрос не должен
// узнать, что здесь живёт приёмник. Станция ждёт быстрый 200: тело — не больше
// 16 КБ (одно событие — одна строка, не набор данных).
import crypto from 'node:crypto';
import express, { Router } from 'express';
import { readSettingsRow } from './settings.js';
import { normalizePbxEvent } from './pbx-event.js';
import { noteEvent } from './live.js';

const NOT_FOUND = { error: { code: 'not_found', message: 'Неизвестный адрес API.' } };
const LIMIT = '16kb';

function sameToken(given, stored) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(String(stored || ''));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function ringWebhook(db, { now = Date.now } = {}) {
  const r = Router();
  // JSON и form-urlencoded: сторонние коннекторы показывают у onlinePBX оба вида.
  r.use(express.json({ limit: LIMIT, type: ['application/json', 'application/*+json', 'text/plain'] }));
  r.use(express.urlencoded({ extended: true, limit: LIMIT }));

  r.post('/:token', (req, res) => {
    const row = readSettingsRow(db);
    if (!row || !row.ring_token || !sameToken(req.params.token, row.ring_token)) return res.status(404).json(NOT_FOUND);
    // Тот же вопрос, что задаёт опрос звонков каждый такт: req.control — ответ
    // attachControl на этот запрос (порядок монтажа в app.js).
    if (!req.control || !req.control.has('callcenter')) return res.status(404).json(NOT_FOUND);
    // FIX_318_V1 (C6) — разбор тоже в try: сбой разбора (раньше — огромная дата) не должен стоить станции 404 на верный адрес.
    try { noteEvent(db, normalizePbxEvent(req.body, { now: now() }), now()); } catch (e) { console.warn('[ring] событие станции не разобралось:', e && e.message); }
    return res.json({ ok: true });
  });

  // Слишком большое или нечитаемое тело — отказ по размеру или 404, но не 500 с
  // внутренностями: станции это ничего не скажет, а чужому — тем более.
  r.use((err, req, res, next) => {   // eslint-disable-line no-unused-vars
    if (err && (err.status === 413 || err.type === 'entity.too.large')) return res.status(413).json({ error: { code: 'too_large', message: 'Слишком большое тело запроса.' } });
    return res.status(404).json(NOT_FOUND);
  });
  r.use((req, res) => res.status(404).json(NOT_FOUND));
  return r;
}
