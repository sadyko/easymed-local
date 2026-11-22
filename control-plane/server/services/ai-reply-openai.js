// AI_OPENAI_V1 (2026-11-18) — сервер управления отвечает через ChatGPT (OpenAI), а не
// Claude, если в его окружении AI_PROVIDER=openai. Ключ — OPENAI_API_KEY, модель —
// OPENAI_MODEL (по умолчанию gpt-4o-mini). Без AI_PROVIDER всё как было — Claude.
//
// Сам вызов и перевод запроса/ответа — в клинике (server/services/ai/openai.js):
// тем же кодом клиника отвечает со своим ключом (AI_OWN_KEY_V1). Здесь — только
// выбор по окружению сервера управления.
import {
  callOpenAiChat, buildOpenAiRequest as buildWithModel, asClaudeMessage, openAiCostMicroUsd,
  OPENAI_URL, DEFAULT_OPENAI_MODEL,
} from '../../../server/services/ai/openai.js';

export { asClaudeMessage, openAiCostMicroUsd, OPENAI_URL, DEFAULT_OPENAI_MODEL };

export function aiProvider(env = process.env) {
  return String(env.AI_PROVIDER || '').trim().toLowerCase() === 'openai' ? 'openai' : 'anthropic';
}

export const buildOpenAiRequest = (payload, env = process.env) => buildWithModel(payload, env.OPENAI_MODEL);

/** Тот же ответ, что у callClaude, плюс готовая стоимость (routes/ai.js берёт cost_micro_usd). */
export function callOpenAi(payload, { env = process.env, fetchImpl = fetch } = {}) {
  return callOpenAiChat(payload, { apiKey: env.OPENAI_API_KEY, model: env.OPENAI_MODEL, fetchImpl });
}

/** Чего не хватает для ChatGPT: только ключ (SDK не нужен). */
export function openAiReadiness(env = process.env) {
  return String(env.OPENAI_API_KEY || '').trim() ? [] : ['OPENAI_API_KEY is not set in the environment (AI_PROVIDER=openai).'];
}
