// AI_OWN_KEY_V1 · AI_OPENAI_V1 (2026-11-18) — ход ИИ-помощника через ChatGPT (OpenAI).
//
// Один код для двух мест: клиника со своим ключом (own-key.js → worker.js) и сервер
// управления с ключом вендора (control-plane/server/services/ai-reply-openai.js).
// Инструкция, инструменты и разбор ответа — общие (reply-core.js): здесь только
// перевод запроса на язык OpenAI и ответа обратно в форму, которую понимает
// outcomeOf. Значит и здесь ход кончается РОВНО одним инструментом, а отказ, текст
// без инструмента или два инструмента — передача оператору. SDK не нужен: один POST.
import { buildRequest, outcomeOf } from './reply-core.js';

export const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
export const OPENAI_MODELS_URL = 'https://api.openai.com/v1/models/';
export const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';
// USD за 1M токенов (= микродоллары за токен) у gpt-4o-mini. Для другой модели —
// приближение; сверка денег — по счёту OpenAI.
const PRICE = { input: 0.15, cachedInput: 0.075, output: 0.6 };
export const TIMEOUT_MS = 50_000;   // ответить раньше, чем клиника перестанет ждать (60 с)

export const modelOrDefault = (m) => String(m || '').trim() || DEFAULT_OPENAI_MODEL;

/** Запрос Chat Completions из того же, что строит buildRequest для Claude. */
export function buildOpenAiRequest(payload, model) {
  const req = buildRequest(payload);
  const system = req.system.map((b) => b.text).join('\n\n');
  return {
    model: modelOrDefault(model),
    messages: [{ role: 'system', content: system }, ...req.messages],
    tools: req.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.input_schema, strict: true },
    })),
    // У OpenAI принудительный вызов инструмента есть: ход без инструмента
    // невозможен, а два за ход запрещены.
    tool_choice: 'required',
    parallel_tool_calls: false,
  };
}

/** Ответ OpenAI → сообщение в форме Claude, которое разбирает outcomeOf. */
export function asClaudeMessage(body) {
  const choice = body && Array.isArray(body.choices) ? body.choices[0] : null;
  const msg = choice && choice.message;
  if (!msg || msg.refusal || (choice && choice.finish_reason === 'content_filter')) return { stop_reason: 'refusal', content: [] };
  const content = (msg.tool_calls || []).filter((c) => c && c.type === 'function' && c.function).map((c) => {
    let input = {};
    try { input = JSON.parse(c.function.arguments || '{}'); } catch { input = null; }
    return { type: 'tool_use', name: c.function.name, input };
  });
  return { stop_reason: 'tool_use', content };
}

export function openAiCostMicroUsd(u = {}) {
  const cached = Number((u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0);
  const input = Math.max(0, Number(u.prompt_tokens || 0) - cached);
  return Math.round(input * PRICE.input + cached * PRICE.cachedInput + Number(u.completion_tokens || 0) * PRICE.output);
}

/**
 * Настоящий вызов. Ошибка — с полями status и error.type (как у SDK Anthropic):
 * в лог идут только они, тело с перепиской — никогда.
 * @returns {{ result, usage: {input_tokens, output_tokens}, cost_micro_usd }}
 */
export async function callOpenAiChat(payload, { apiKey, model, fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const key = String(apiKey || '').trim();
  if (!key) { const e = new Error('Ключ OpenAI не задан.'); e.status = 0; e.error = { type: 'no_key' }; throw e; }
  const res = await fetchImpl(OPENAI_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
    body: JSON.stringify(buildOpenAiRequest(payload, model)),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) {
    const e = new Error('Запрос к OpenAI не выполнен.');
    e.status = res.status;
    e.error = { type: (body && body.error && (body.error.code || body.error.type)) || 'http_error' };
    throw e;
  }
  const usage = (body && body.usage) || {};
  return {
    result: outcomeOf(asClaudeMessage(body)),
    usage: { input_tokens: Number(usage.prompt_tokens || 0), output_tokens: Number(usage.completion_tokens || 0) },
    cost_micro_usd: openAiCostMicroUsd(usage),
  };
}

/**
 * Проверка ключа при сохранении: OpenAI знает ключ и модель? Без переписки и почти
 * бесплатно (GET /v1/models/<model>). 'ok' | 'bad_key' | 'bad_model' | 'offline'.
 * Офлайн — не отказ: ключ сохраняется, проверит первый ответ пациенту.
 */
export async function checkOpenAiKey(apiKey, model, { fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  let res;
  try {
    res = await fetchImpl(OPENAI_MODELS_URL + encodeURIComponent(modelOrDefault(model)), {
      headers: { authorization: 'Bearer ' + String(apiKey || '').trim() },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch { return 'offline'; }
  if (res.ok) return 'ok';
  if (res.status === 401 || res.status === 403) return 'bad_key';
  if (res.status === 404) return 'bad_model';
  return 'offline';
}
