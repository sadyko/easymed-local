// AI_CHAT_V1 — экран «ИИ-помощник» и метки в чатах.
//   ai_settings_get  — состояние (видит «ИИ-помощник: Просмотр»);
//   ai_settings_save — переключатель (нужно «Изменение» и модуль `ai`);
//   ai_flags         — чаты «Нужен оператор» (видит тот, кто видит чаты).
import { grantAllowsAdminOr } from '../grants.js';
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
  return { ...readAiSettings(db), has_module: !!hasModule(db), facts: factCounts(db) };
}

export function aiSettingsSave(db, args, user, { hasModule = defaultHasModule, ackTelegram = ackTelegramChats } = {}) {
  requireAiLevel(db, user, 'edit');
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
  return { ...readAiSettings(db), has_module: !!hasModule(db), enabled: s.enabled, facts: factCounts(db) };
}

export function aiFlags(db, _args, user) {
  const sees = grantAllowsAdminOr(db, user, 'commerce_ai', 'view')
    || canViewSection(db, user, 'telegram-chat') || canViewSection(db, user, 'meta-chat');
  if (!sees) throw new RpcError('Чаты недоступны вашей роли.', 403);
  return flaggedChats(db);
}
