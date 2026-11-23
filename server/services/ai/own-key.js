// AI_OWN_KEY_V1 (2026-11-18) — свой ключ OpenAI клиники и выключатели функций ИИ.
//
// Владелец: «first permission to use this block from settings.easymed.uz/cp, then key
// putting mirror should be opened with functions … Meta answering, analyzing call record».
// Порядок важен и здесь не меняется: модуль `ai` выдаёт вендор (лицензия, settings.js
// hasAiModule). Ключ НЕ открывает модуль — он лишь решает, КТО платит за ответы:
//   ключ есть — клиника сама спрашивает ChatGPT (askOpenAiDirect), напрямую;
//   ключа нет — как было: ответ даёт сервер управления своим ключом.
//
// Ключ хранится зашифрованным ключом клиники (api/secret-box.js, файл .api-secrets-key
// рядом с базой, тот же, что у токенов Meta): копия базы ключа не раскрывает. Экран
// видит только последние 4 знака.
import { loadKek, seal, unseal, tailOf } from '../api/secret-box.js';
import { callOpenAiChat, checkOpenAiKey, modelOrDefault, DEFAULT_OPENAI_MODEL } from './openai.js';
import { checkShape } from './cp-client.js';

// Функции, которые клиника включает по одной. Нет записи — включена (до 291 ИИ
// отвечал во всех каналах). Ключ — канал задачи ai_chat_jobs.channel.
export const AI_FEATURES = Object.freeze(['telegram', 'meta_dm', 'meta_comment', 'calls']);
// Нет записи — по умолчанию: чаты ВКЛЮЧЕНЫ (до 291 ИИ отвечал во всех каналах), а
// AI_CALLS_V1 «Анализ записей звонков» ВЫКЛЮЧЕН: функция новая и платная, её включают
// сознательно. 'calls' — не канал чата: featureOn для задач чатов её не касается.
const FEATURE_DEFAULTS = Object.freeze({ telegram: true, meta_dm: true, meta_comment: true, calls: false });

const KEY_RE = /^sk-[A-Za-z0-9_\-]{16,300}$/;
const MODEL_RE = /^[A-Za-z0-9.\-:_]{3,60}$/;

export class OwnKeyError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

function row(db) {
  return db.prepare('SELECT openai_key_sealed, openai_key_tail, openai_model, features FROM ai_settings WHERE id = 1').get() || {};
}

export function readFeatures(db) {
  let raw = {};
  try { raw = JSON.parse(row(db).features || '{}') || {}; } catch { raw = {}; }
  const out = {};
  for (const k of AI_FEATURES) out[k] = typeof raw[k] === 'boolean' ? raw[k] : FEATURE_DEFAULTS[k];
  return out;
}

/** Включена ли функция для канала задачи. Неизвестный канал — включён (решают другие правила). */
export function featureOn(db, channel) {
  if (!AI_FEATURES.includes(channel)) return true;
  return readFeatures(db)[channel];
}

/** Только известные ключи и только true/false. */
export function saveFeatures(db, patch, userId = null) {
  const cur = readFeatures(db);
  const wasCalls = cur.calls;
  for (const k of AI_FEATURES) if (patch && typeof patch[k] === 'boolean') cur[k] = patch[k];
  db.prepare("UPDATE ai_settings SET features = ?, updated_by = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = 1")
    .run(JSON.stringify(cur), userId);
  // AI_CALLS_V1 — включили разбор звонков: отсчёт с этой минуты (старые звонки не
  // отправляются). Выключили и включили снова — отсчёт заново, пропуск не догоняется.
  if (cur.calls && !wasCalls) db.prepare("UPDATE ai_settings SET calls_since = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = 1").run();
  return cur;
}

/** Что видит экран: ключ стоит ли и какой (хвост), модель. Сам ключ — никогда. */
export function ownKeyInfo(db) {
  const r = row(db);
  return { set: !!r.openai_key_sealed, tail: r.openai_key_tail || '', model: modelOrDefault(r.openai_model), default_model: DEFAULT_OPENAI_MODEL };
}

export const hasOwnKey = (db) => !!row(db).openai_key_sealed;

/** Только для сервера: расшифрованный ключ и модель, или null. Чужой файл ключа — null. */
export function readOwnKey(db, { kekPath } = {}) {
  const r = row(db);
  if (!r.openai_key_sealed) return null;
  try {
    const kek = loadKek({ kekPath });
    return { apiKey: unseal(r.openai_key_sealed, kek), model: modelOrDefault(r.openai_model) };
  } catch { return null; }
}

/**
 * Сохранить ключ. Проверяет у OpenAI (ключ и модель) — неверный ключ не сохраняется,
 * офлайн сохраняется (проверит первый ответ). Снимает «ключ не принят».
 * @returns {{ check: 'ok'|'offline', info }}
 */
export async function saveOwnKey(db, { key, model }, { userId = null, kekPath, check = checkOpenAiKey } = {}) {
  const k = String(key || '').trim();
  if (!KEY_RE.test(k)) throw new OwnKeyError('Это не похоже на ключ OpenAI: он начинается с «sk-».', 'bad_format');
  const m = String(model || '').trim();
  if (m && !MODEL_RE.test(m)) throw new OwnKeyError('Название модели — латиница, цифры, точка и дефис.', 'bad_model');
  const verdict = await check(k, m);
  if (verdict === 'bad_key') throw new OwnKeyError('OpenAI не принял этот ключ.', 'bad_key');
  if (verdict === 'bad_model') throw new OwnKeyError('У этого ключа нет такой модели.', 'bad_model');
  const kek = loadKek({ kekPath, create: true });
  db.prepare(`UPDATE ai_settings SET openai_key_sealed = ?, openai_key_tail = ?, openai_model = ?,
                blocked = CASE WHEN blocked = 'bad_key' THEN '' ELSE blocked END,
                blocked_at = CASE WHEN blocked = 'bad_key' THEN NULL ELSE blocked_at END,
                updated_by = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = 1`)
    .run(seal(k, kek), tailOf(k), m, userId);
  return { check: verdict === 'ok' ? 'ok' : 'offline', info: ownKeyInfo(db) };
}

export function clearOwnKey(db, userId = null) {
  db.prepare(`UPDATE ai_settings SET openai_key_sealed = '', openai_key_tail = '', openai_model = '',
                blocked = CASE WHEN blocked = 'bad_key' THEN '' ELSE blocked END,
                blocked_at = CASE WHEN blocked = 'bad_key' THEN NULL ELSE blocked_at END,
                updated_by = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = 1`).run(userId);
  return ownKeyInfo(db);
}

/**
 * Ответ ChatGPT напрямую, своим ключом. Тот же договор, что у askControlPlane:
 * исход ({ outcome, … }) или { error }. Ошибки:
 *   bad_key     — ключ не принят или на счёте OpenAI нет денег: ИИ останавливается,
 *                 экран говорит, что делать (повтор не поможет);
 *   network     — сеть, 429 «слишком часто», 5xx: очередь повторит с паузой;
 *   bad_response — OpenAI отверг запрос или ответил не по форме: передача оператору.
 */
export async function askOpenAiDirect(payload, own, { call = callOpenAiChat } = {}) {
  let answer;
  try {
    answer = await call(payload, { apiKey: own.apiKey, model: own.model });
  } catch (e) {
    const status = e && e.status;
    const type = e && e.error && e.error.type;
    console.warn('[ai] OpenAI failure', status || 'no-status', type || 'no-type');   // без тела: в нём бывает переписка
    if (status === 401 || status === 403 || type === 'insufficient_quota' || type === 'no_key') return { error: 'bad_key' };
    if (status === 400 || status === 404) return { error: 'bad_response' };
    return { error: 'network' };
  }
  const body = answer && answer.result;
  return checkShape(body) ? body : { error: 'bad_response' };
}
