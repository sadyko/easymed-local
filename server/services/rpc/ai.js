// AI_CHAT_V1 — экран «ИИ-помощник» и метки в чатах.
//   ai_settings_get  — состояние (видит «ИИ-помощник: Просмотр»);
//   ai_settings_save — переключатель (нужно «Изменение» и модуль `ai`);
//   ai_flags         — чаты «Нужен оператор» (видит тот, кто видит чаты).
//   ai_key_save / ai_key_clear — свой ключ OpenAI клиники (AI_OWN_KEY_V1): только
//                      администратор и только при подключённом модуле `ai`.
import { grantAllowsAdminOr, grantAllows, isAdminUser } from '../grants.js';
import { ownKeyInfo, readFeatures, saveFeatures, saveOwnKey, clearOwnKey, OwnKeyError } from '../ai/own-key.js';   // AI_OWN_KEY_V1
import { callAnalysis, operatorScores } from '../ai/calls.js';   // AI_CALLS_V1
// Ревью слияния 2026-11-23 — тот же список ролей, что у «Прослушать запись» в phone.js (PHONE_ROLES), своей
// строкой: сторож ворот (gate-fallbacks.test.js) читает список ролей из того же файла, что и вызов.
const HEAR_ROLES = Object.freeze(['admin', 'registrar', 'callcenter']);
import { canViewSection } from '../roles.js';
import { readAiSettings, setAiEnabled, setAiBlocked, hasAiModule, clearNoModuleBlock } from '../ai/settings.js';
import { dropQueuedJobs, queuedTelegramChats } from '../ai/queue.js';
import { ackTelegramChats } from '../ai/worker.js';
import { flaggedChats } from '../ai/guards.js';
import { clinicFacts } from '../ai/facts.js';

export class RpcError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

const defaultHasModule = hasAiModule;

function requireAiLevel(db, user, need) {
  if (!grantAllowsAdminOr(db, user, 'commerce_ai', need)) {
    throw new RpcError('ИИ-помощник недоступен вашей роли. Права выдаёт администратор в «Настройки → Роли» (строка «ИИ-помощник»).', 403);
  }
}

// A8: сколько услуг и врачей ИИ вообще знает — экран предупреждает, когда услуг 0.
function factCounts(db) {
  try {
    const f = clinicFacts(db);
    return { services: (f.services || []).length, doctors: (f.doctors || []).length };
  } catch { return { services: 0, doctors: 0 }; }
}

export function aiSettingsGet(db, _args, user, { hasModule = defaultHasModule } = {}) {
  requireAiLevel(db, user, 'view');
  // AI_CHAT_V1: модуль снова подключён — «ИИ остановлен» снимается сам.
  clearNoModuleBlock(db, hasModule);
  return view(db, hasModule);
}

// AI_OWN_KEY_V1 — экран видит ключ (стоит ли, хвост, модель) и функции; сам ключ — никогда.
function view(db, hasModule, extra = {}) {
  return { ...readAiSettings(db), has_module: !!hasModule(db), facts: factCounts(db), own_key: ownKeyInfo(db), features: readFeatures(db), ...extra };
}

export function aiSettingsSave(db, args, user, { hasModule = defaultHasModule, ackTelegram = ackTelegramChats } = {}) {
  requireAiLevel(db, user, 'edit');
  // AI_OWN_KEY_V1 — выключатели функций; без `enabled` в запросе главный
  // переключатель не трогаем.
  if (args && args.features && typeof args.features === 'object') {
    if (!hasModule(db)) { const err = new RpcError('Модуль «ИИ-помощник» не подключён. Обратитесь к менеджеру Easy-Med.', 402); err.code = 'module_missing'; throw err; }
    saveFeatures(db, args.features, (user && user.id) || null);
    if (args.enabled === undefined) return view(db, hasModule);
  }
  // Только настоящее true/1: строки «false»/«0» не должны включать ИИ.
  const on = !!(args && (args.enabled === true || args.enabled === 1));
  if (on && !hasModule(db)) {
    const err = new RpcError('Модуль «ИИ-помощник» не подключён. Обратитесь к менеджеру Easy-Med.', 402);
    err.code = 'module_missing';
    throw err;
  }
  const s = setAiEnabled(db, on, (user && user.id) || null);
  if (on) setAiBlocked(db, '');
  else {
    // AI_CHAT_V1: ждущие сообщения Telegram бот не подтверждал — их взял ИИ.
    // Выключение снимает их, и бот говорит «сообщение принято» сам. Не ждём:
    // ответ переключателю не должен висеть на Telegram; ackTelegramChats не бросает.
    const chats = queuedTelegramChats(db);
    dropQueuedJobs(db);
    if (chats.length) Promise.resolve().then(() => ackTelegram(db, chats)).catch(() => {});
  }
  return view(db, hasModule, { enabled: s.enabled });
}

// AI_OWN_KEY_V1 — ключ OpenAI: деньги и доступ к внешнему сервису, поэтому только
// администратор, и только когда вендор уже подключил модуль (владелец: «first permission
// … from settings.easymed.uz/cp, then key»).
function requireKeyAdmin(db, user, hasModule) {
  if (!isAdminUser(user)) throw new RpcError('Ключ OpenAI вводит и меняет только администратор.', 403);
  if (!hasModule(db)) { const err = new RpcError('Модуль «ИИ-помощник» не подключён. Обратитесь к менеджеру Easy-Med.', 402); err.code = 'module_missing'; throw err; }
}

export async function aiKeySave(db, args, user, { hasModule = defaultHasModule, check } = {}) {
  requireKeyAdmin(db, user, hasModule);
  try {
    const r = await saveOwnKey(db, { key: args && args.key, model: args && args.model }, { userId: (user && user.id) || null, ...(check ? { check } : {}) });
    return view(db, hasModule, { key_check: r.check });
  } catch (e) {
    if (e instanceof OwnKeyError) { const err = new RpcError(e.message, 400); err.code = e.code; throw err; }
    throw e;
  }
}

export function aiKeyClear(db, _args, user, { hasModule = defaultHasModule } = {}) {
  if (!isAdminUser(user)) throw new RpcError('Ключ OpenAI вводит и меняет только администратор.', 403);
  clearOwnKey(db, (user && user.id) || null);
  return view(db, hasModule);
}

export function aiFlags(db, _args, user) {
  const sees = grantAllowsAdminOr(db, user, 'commerce_ai', 'view')
    || canViewSection(db, user, 'telegram-chat') || canViewSection(db, user, 'meta-chat');
  if (!sees) throw new RpcError('Чаты недоступны вашей роли.', 403);
  return flaggedChats(db);
}

// AI_CALLS_V1 — разбор одного звонка целиком (расшифровка, оценки). Ворота те же, что у
// записи разговора: «Прослушать запись» (crm.recording) — текст разговора не шире голоса.
export function aiCallGet(db, args, user) {
  if (!grantAllows(db, user, 'crm.recording', 'edit', HEAR_ROLES)) {   // как mayHear в phone.js
    throw new RpcError('Разбор звонка виден тем, кому разрешено слушать записи разговоров.', 403);
  }
  const id = Number(args && args.call_id);
  if (!Number.isInteger(id) || id <= 0) throw new RpcError('Звонок не выбран.', 400);
  return callAnalysis(db, id) || { call_id: id, status: null };
}

// AI_CALLS_V1 — средняя оценка операторов за период, для экрана «ИИ-помощник».
export function aiCallScores(db, args, user) {
  requireAiLevel(db, user, 'view');
  return { days: Number(args && args.days) || 30, operators: operatorScores(db, { days: args && args.days }) };
}
