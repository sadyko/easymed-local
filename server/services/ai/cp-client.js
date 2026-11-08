// AI_CHAT_V1 — запрос ответа у сервера управления. Ключа Anthropic у клиники
// нет: сервер управления сам обращается к Claude, проверяет модуль `ai` и
// месячный лимит. Клиника предъявляет свой install_token — как при сверке
// (control/checkin.js), но в заголовке X-Install-Token, а не в теле: сервер
// управления проверяет токен ДО разбора большого тела. Адрес — тот же
// EASYMED_CONTROL_URL. Форму ответа проверяем здесь же: ответ с пустым или
// не тем полем не должен дойти до отправки пациенту.
import path from 'node:path';
import { readJsonFile } from '../control/checkin.js';
import { assertControlUrlIsTestSafe } from '../control/prod-guard.js';
import { getDataDir } from '../control/config.js';

export const AI_PATH = '/cp/v1/ai/chat-reply';
const DEFAULT_ENDPOINT = 'https://settings.easymed.uz';
const OUTCOMES = new Set(['reply', 'reply_comment', 'create_lead', 'hand_off']);
const TIMEOUT_MS = 60_000;
const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';
const isStr = (v) => typeof v === 'string';
const SHAPE_OK = {
  reply: (b) => nonEmpty(b.text),
  reply_comment: (b) => nonEmpty(b.public_text) && nonEmpty(b.private_text),
  create_lead: (b) => nonEmpty(b.text) && isStr(b.name) && isStr(b.phone) && isStr(b.wish),
  hand_off: (b) => isStr(b.text), // пусто допустимо — воркер подставит HANDOFF_TEXT
};

export async function askControlPlane(payload, { dataDir = getDataDir(), endpoint, fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const identity = readJsonFile(path.join(dataDir, 'control.json'));
  const token = identity && typeof identity.install_token === 'string' && identity.install_token ? identity.install_token : null;
  if (!token) return { error: 'not_enrolled' };
  if (!endpoint) assertControlUrlIsTestSafe(process.env, fetchImpl);
  const base = String(endpoint || process.env.EASYMED_CONTROL_URL || DEFAULT_ENDPOINT).trim().replace(/\/+$/, '');
  let res;
  try {
    res = await fetchImpl(base + AI_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Install-Token': token },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch { return { error: 'network' }; }
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (res.status === 402) {
    const code = body && body.error && body.error.code;
    return { error: code === 'no_module' ? 'no_module' : 'limit' };
  }
  if (res.status === 413) return { error: 'too_large' };
  if (!res.ok) return { error: res.status === 401 ? 'not_enrolled' : 'network' };
  if (!body || !OUTCOMES.has(body.outcome) || !SHAPE_OK[body.outcome](body)) return { error: 'bad_response' };
  return body;
}
