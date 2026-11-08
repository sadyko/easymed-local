import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, outcomeOf, costMicroUsd, MODEL } from './ai-reply.js';

// AI_CHAT_V1 — только построение запроса, разбор исхода и цена. Настоящий
// Claude здесь не вызывается никогда: routes/ai.js принимает callClaude
// снаружи, и его тесты подменяют вызов целиком.

const payload = { channel: 'telegram', transcript: [{ from: 'patient', text: 'Сколько стоит УЗИ?' }], patient_name: 'A', post_text: '', facts: { services: [{ name: 'УЗИ', price: 150000 }] } };

test('запрос: модель, три инструмента, strict, без принудительного выбора', () => {
  const r = buildRequest(payload);
  assert.equal(r.model, MODEL);
  assert.equal(MODEL, 'claude-opus-5-5');
  assert.deepEqual(r.tools.map((t) => t.name).sort(), ['create_lead', 'hand_off', 'reply']);
  assert.ok(r.tools.every((t) => t.strict === true && t.input_schema.additionalProperties === false));
  assert.deepEqual(r.tool_choice, { type: 'auto' });
  assert.ok(JSON.stringify(r.messages).includes('Сколько стоит УЗИ?'));
  const c = buildRequest({ ...payload, channel: 'meta_comment' });
  assert.ok(c.tools.some((t) => t.name === 'reply_comment') && !c.tools.some((t) => t.name === 'reply'));
});

test('запрос: каждое свойство инструмента обязательно (strict), без thinking, сведения кэшируются', () => {
  const r = buildRequest(payload);
  for (const t of r.tools) {
    assert.deepEqual([...t.input_schema.required].sort(), Object.keys(t.input_schema.properties).sort(), t.name);
  }
  assert.equal('thinking' in r, false, 'у этой модели мышление всегда включено — параметр не шлём');
  assert.deepEqual(r.output_config, { effort: 'medium' });
  const factsBlock = r.system.find((b) => b.text.includes('УЗИ'));
  assert.deepEqual(factsBlock.cache_control, { type: 'ephemeral' });
});

test('исход: ровно один инструмент; отказ и прочее — передача', () => {
  const msg = (content, stop_reason = 'tool_use') => ({ content, stop_reason });
  assert.deepEqual(outcomeOf(msg([{ type: 'tool_use', name: 'reply', input: { text: 'Здравствуйте' } }])), { outcome: 'reply', text: 'Здравствуйте' });
  assert.deepEqual(outcomeOf(msg([{ type: 'tool_use', name: 'hand_off', input: { text: 'Подключу', reason: 'medical' } }])), { outcome: 'hand_off', text: 'Подключу', reason: 'medical' });
  assert.equal(outcomeOf(msg([], 'refusal')).outcome, 'hand_off');
  assert.equal(outcomeOf(msg([{ type: 'text', text: 'hi' }], 'end_turn')).outcome, 'hand_off');
  assert.equal(outcomeOf(msg([{ type: 'tool_use', name: 'reply', input: { text: 'a' } }, { type: 'tool_use', name: 'reply', input: { text: 'b' } }])).outcome, 'hand_off');
});

test('исход: комментарий, заявка; пустой ответ — передача, а не пустое сообщение пациенту', () => {
  const msg = (content) => ({ content, stop_reason: 'tool_use' });
  assert.deepEqual(outcomeOf(msg([{ type: 'tool_use', name: 'reply_comment', input: { public_text: 'Ответили в личных', private_text: 'УЗИ — 150 000' } }])),
    { outcome: 'reply_comment', public_text: 'Ответили в личных', private_text: 'УЗИ — 150 000' });
  assert.deepEqual(outcomeOf(msg([{ type: 'tool_use', name: 'create_lead', input: { name: 'Ali', phone: '', wish: 'УЗИ', text: 'Администратор свяжется' } }])),
    { outcome: 'create_lead', name: 'Ali', phone: '', wish: 'УЗИ', text: 'Администратор свяжется' });
  assert.equal(outcomeOf(msg([{ type: 'tool_use', name: 'reply', input: { text: '   ' } }])).outcome, 'hand_off');
  assert.equal(outcomeOf(msg([{ type: 'tool_use', name: 'reply_comment', input: { public_text: 'x', private_text: '' } }])).outcome, 'hand_off');
  assert.equal(outcomeOf(msg([{ type: 'tool_use', name: 'create_lead', input: { name: 'A', phone: '', wish: '', text: '' } }])).outcome, 'hand_off');
  assert.equal(outcomeOf(msg([{ type: 'tool_use', name: 'delete_everything', input: {} }])).outcome, 'hand_off');
  assert.equal(outcomeOf(null).outcome, 'hand_off');
});

test('стоимость по usage', () => {
  assert.equal(costMicroUsd({ input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0 }), 1000 * 4 + 100 * 20 + Math.round(2000 * 0.2));
  assert.equal(costMicroUsd({ cache_creation_input_tokens: 1000 }), 5000);
  assert.equal(costMicroUsd(), 0);
});
