// AI_OPENAI_V1 — ChatGPT вместо Claude: тот же ход, те же двери, своя цена.
// Сеть подменена: ни один тест не доходит до настоящего OpenAI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aiProvider, buildOpenAiRequest, asClaudeMessage, openAiCostMicroUsd, callOpenAi, openAiReadiness,
  OPENAI_URL, DEFAULT_OPENAI_MODEL,
} from './ai-reply-openai.js';

const payload = {
  channel: 'telegram', patient_name: 'Азиз',
  transcript: [{ from: 'patient', text: 'Сколько стоит УЗИ?' }],
  facts: { services: [{ name: 'УЗИ', price: 150000 }] },
};
const toolCall = (name, args) => ({ id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) } });
const completion = (calls, extra = {}) => ({
  choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: calls, ...extra } }],
  usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 400 } },
});
const fakeFetch = (status, body, seen = {}) => async (url, init) => {
  seen.url = url; seen.init = init; seen.body = JSON.parse(init.body);
  return { ok: status >= 200 && status < 300, status, json: async () => body };
};
const env = { AI_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test-not-real' };

test('провайдер: openai только по AI_PROVIDER=openai, иначе Claude', () => {
  assert.equal(aiProvider({ AI_PROVIDER: 'openai' }), 'openai');
  assert.equal(aiProvider({ AI_PROVIDER: ' OpenAI ' }), 'openai');
  assert.equal(aiProvider({}), 'anthropic');
  assert.equal(aiProvider({ AI_PROVIDER: 'claude' }), 'anthropic');
});

test('запрос: та же инструкция и сведения, инструменты strict, ровно один инструмент обязателен', () => {
  const r = buildOpenAiRequest(payload, {});
  assert.equal(r.model, DEFAULT_OPENAI_MODEL);
  assert.equal(buildOpenAiRequest(payload, { OPENAI_MODEL: 'gpt-5-mini' }).model, 'gpt-5-mini');
  assert.equal(r.messages[0].role, 'system');
  assert.match(r.messages[0].content, /помощник клиники/);
  assert.match(r.messages[0].content, /Сведения о клинике \(JSON\)/);
  assert.match(r.messages[0].content, /150000/);
  assert.equal(r.messages[1].role, 'user');
  assert.match(r.messages[1].content, /^<conversation>/);
  assert.deepEqual(r.tools.map((t) => t.function.name), ['reply', 'create_lead', 'hand_off']);
  for (const t of r.tools) {
    assert.equal(t.function.strict, true);
    assert.equal(t.function.parameters.additionalProperties, false);
  }
  assert.equal(r.tool_choice, 'required');
  assert.equal(r.parallel_tool_calls, false);
  assert.deepEqual(buildOpenAiRequest({ ...payload, channel: 'meta_comment' }, {}).tools.map((t) => t.function.name),
    ['reply_comment', 'create_lead', 'hand_off']);
});

test('ответ: один инструмент — его исход; отказ, фильтр, без инструмента, два, битые аргументы — передача', async () => {
  const run = async (body) => (await callOpenAi(payload, { env, fetchImpl: fakeFetch(200, body) })).result;
  assert.deepEqual(await run(completion([toolCall('reply', { text: 'УЗИ — 150 000 сум.' })])), { outcome: 'reply', text: 'УЗИ — 150 000 сум.' });
  assert.deepEqual(await run(completion([toolCall('create_lead', { name: 'Азиз', phone: '+998901234567', wish: 'УЗИ', text: 'Администратор свяжется.' })])),
    { outcome: 'create_lead', name: 'Азиз', phone: '+998901234567', wish: 'УЗИ', text: 'Администратор свяжется.' });
  const handOff = { outcome: 'hand_off', text: '', reason: 'other' };
  assert.deepEqual(await run(completion([], { refusal: 'no' })), handOff);
  assert.deepEqual(await run({ choices: [{ finish_reason: 'content_filter', message: { content: '' } }] }), handOff);
  assert.deepEqual(await run(completion(undefined, { content: 'просто текст' })), handOff);
  assert.deepEqual(await run(completion([toolCall('reply', { text: 'a' }), toolCall('reply', { text: 'b' })])), handOff);
  assert.deepEqual(await run(completion([{ id: 'x', type: 'function', function: { name: 'reply', arguments: '{bad' } }])), handOff);
  assert.deepEqual(await run(completion([toolCall('reply', { text: '   ' })])), handOff);
  assert.deepEqual(asClaudeMessage(null), { stop_reason: 'refusal', content: [] });
});

test('вызов: ключ в заголовке, адрес OpenAI, токены и своя стоимость', async () => {
  const seen = {};
  const out = await callOpenAi(payload, { env, fetchImpl: fakeFetch(200, completion([toolCall('reply', { text: 'Да' })]), seen) });
  assert.equal(seen.url, OPENAI_URL);
  assert.equal(seen.init.headers.authorization, 'Bearer sk-test-not-real');
  assert.equal(seen.body.tool_choice, 'required');
  assert.deepEqual(out.usage, { input_tokens: 1000, output_tokens: 50 });
  // 600 обычных × 0.15 + 400 кэшированных × 0.075 + 50 × 0.6 = 90 + 30 + 30
  assert.equal(out.cost_micro_usd, 150);
  assert.equal(openAiCostMicroUsd({}), 0);
});

test('ошибки: нет ключа или ответ не 2xx — исключение со статусом и типом, без тела', async () => {
  await assert.rejects(callOpenAi(payload, { env: { AI_PROVIDER: 'openai' }, fetchImpl: fakeFetch(200, {}) }),
    (e) => e.error.type === 'no_key');
  await assert.rejects(callOpenAi(payload, { env, fetchImpl: fakeFetch(401, { error: { type: 'invalid_request_error', message: 'Incorrect API key' } }) }),
    (e) => e.status === 401 && e.error.type === 'invalid_request_error' && !/Incorrect/.test(e.message));
  await assert.rejects(callOpenAi(payload, { env, fetchImpl: fakeFetch(429, null) }), (e) => e.status === 429 && e.error.type === 'http_error');
  assert.deepEqual(openAiReadiness({ OPENAI_API_KEY: 'x' }), []);
  assert.equal(openAiReadiness({}).length, 1);
});
