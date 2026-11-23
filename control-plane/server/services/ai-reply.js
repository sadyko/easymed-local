// AI_CHAT_V1 — запрос к Claude за ответом пациенту и разбор ответа.
//
// Ключ Anthropic — только здесь, на сервере управления. Ход заканчивается
// РОВНО ОДНИМ инструментом: reply (или reply_comment у комментария),
// create_lead, hand_off. Всё прочее — отказ модели, текст без инструмента,
// два инструмента, пустой ответ — считается передачей оператору: пациент не
// получит ничего, что не прошло через эти три двери.
//
// Переписка пациента — ДАННЫЕ, а не указания: она приходит одним сообщением
// пользователя внутри метки <conversation>, и инструкция прямо говорит не
// выполнять просьбы из неё.
//
// SDK подгружается ЛЕНИВО, внутри callClaude, а не import'ом наверху файла.
// Причина: control-plane в этом репозитории живёт на node_modules корня (см.
// control-plane/README.md — `npm install` внутри control-plane здесь не
// делают), а в корне @anthropic-ai/sdk нет и не должно быть: клинике он не
// нужен. Статический import уронил бы при загрузке app.js все тесты сервера
// управления — и в CI, где ставится только корень. SDK объявлен в
// control-plane/package.json и ставится на сервере вендора вместе с прочим.
const PRICE = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 };   // USD за 1M токенов = микродоллары за токен

// Клиника (server/services/ai/cp-client.js) бросает ждать через 60 с. Мы
// должны ответить раньше — пусть даже 503 — иначе клиника сочтёт это сетью и
// повторит, а Claude тем временем досчитает и спишет деньги ещё раз. Одна
// попытка на 50 с и БЕЗ повторов SDK: повтор после таймаута вышел бы за 60 с.
// Повторы при 429/529 делает очередь клиники (worker.js): наш 503 upstream она
// видит как 'network' и повторяет с паузой — безопасно и без двойной оплаты.
// AI_OWN_KEY_V1 — инструкция, инструменты, buildRequest и outcomeOf живут в клинике
// (server/services/ai/reply-core.js): одни правила для сервера управления и для
// клиники со своим ключом OpenAI. Отсюда — прежние имена для импортёров.
import { MODEL, buildRequest, outcomeOf } from '../../../server/services/ai/reply-core.js';
export { MODEL, buildRequest, outcomeOf };

export const CLIENT_OPTIONS = Object.freeze({ timeout: 50_000, maxRetries: 0 });

// ПРИБЛИЖЕНИЕ: всё считается по ценам Claude Opus 5.5. Если ответ дала
// запасная модель (fallbacks: 'default' после отказа основной), её цена может
// быть другой — тогда эта цифра расходится со счётом Anthropic. Для месячного
// лимита клиники этого достаточно; сверка денег — по счёту Anthropic.
export function costMicroUsd(u = {}) {
  return Math.round((u.input_tokens || 0) * PRICE.input + (u.output_tokens || 0) * PRICE.output
    + (u.cache_read_input_tokens || 0) * PRICE.cacheRead + (u.cache_creation_input_tokens || 0) * PRICE.cacheWrite);
}

/**
 * Чего не хватает, чтобы ИИ-помощник работал на этом сервере: SDK (ставится
 * отдельно, см. control-plane/README.md) и ключ ANTHROPIC_API_KEY. Вызывается
 * при запуске (index.js) и только ПРЕДУПРЕЖДАЕТ: сверка и лицензии важнее ИИ,
 * и падать из-за него сервер управления не должен.
 * @returns {Promise<string[]>} пусто — всё на месте
 */
export async function aiReadiness({ env = process.env, importSdk = () => import('@anthropic-ai/sdk') } = {}) {
  const problems = [];
  try { await importSdk(); } catch { problems.push('@anthropic-ai/sdk is not installed (see control-plane/README.md, "AI assistant").'); }
  if (!String(env.ANTHROPIC_API_KEY || '').trim()) problems.push('ANTHROPIC_API_KEY is not set in the environment.');
  return problems;
}

let client = null;
/** Настоящий вызов. Тесты подменяют `callClaude` целиком (routes/ai.js deps). */
export async function callClaude(payload) {
  if (!client) {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    client = new Anthropic({ ...CLIENT_OPTIONS });   // ANTHROPIC_API_KEY из окружения сервера управления
  }
  const req = buildRequest(payload);
  // Отказ по политике сервер сам переигрывает на запасной модели внутри того
  // же вызова; если и итог — stop_reason 'refusal', outcomeOf даст hand_off.
  const message = await client.beta.messages.create({
    ...req,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
  });
  return { result: outcomeOf(message), usage: message.usage || {} };
}
