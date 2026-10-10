// CLINIC_API_STEP7_V1 — ЧЕРНОВИК КЛЮЧА для окна «Новое подключение» (Р6 плана).
//
// Макет (одобрен владельцем): ключ виден в окне ДО «Создать подключение», с
// «Скопировать» и «Сгенерировать новый». Выпускает его сервер (CSPRNG), и
// браузер не присылает ключ обратно: при создании он называет черновик, а
// значение берётся отсюда. Иначе собранный руками запрос задал бы клинике ключ
// «em_live_aaaa…».
//
// Память процесса, не база: черновик ещё никому не выдан. 30 минут, одному
// администратору, один раз. Перезапуск сервера черновики теряет — окно скажет
// «устарело», администратор откроет его заново.
import crypto from 'node:crypto';
import { newApiKey, newWebhookSecret } from './secret-box.js';

export const DRAFT_TTL_MS = 30 * 60 * 1000;
const MAX_DRAFTS = 100;
const drafts = new Map();

function prune(now) { for (const [id, d] of drafts) if (now - d.at > DRAFT_TTL_MS) drafts.delete(id); }
function mine(id, userId, now) {
  prune(now);
  const d = drafts.get(String(id || ''));
  return d && d.userId === userId ? d : null;
}
const view = (id, d) => ({ draft_id: id, key: d.key, secret: d.secret });

export function makeDraft(userId, { now = Date.now() } = {}) {
  prune(now);
  const id = crypto.randomBytes(16).toString('hex');
  drafts.set(id, { userId, key: newApiKey(), secret: newWebhookSecret(), at: now });
  while (drafts.size > MAX_DRAFTS) drafts.delete(drafts.keys().next().value);
  return view(id, drafts.get(id));
}
/** «Сгенерировать новый» / «Новый секрет» в окне: та же запись, новое значение. */
export function renewDraft(id, userId, what, { now = Date.now() } = {}) {
  const d = mine(id, userId, now);
  if (!d || (what !== 'key' && what !== 'secret')) return null;
  if (what === 'key') d.key = newApiKey(); else d.secret = newWebhookSecret();
  d.at = now;
  return view(String(id), d);
}
export function readDraft(id, userId, { now = Date.now() } = {}) {
  const d = mine(id, userId, now);
  return d ? { key: d.key, secret: d.secret } : null;
}
export function dropDraft(id) { drafts.delete(String(id || '')); }
export function __clearDraftsForTests() { drafts.clear(); }
