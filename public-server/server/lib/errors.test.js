// PUBLIC_SERVER_V1 — словарь ошибок: у каждого кода статус и три языка;
// узбекский и английский — без кириллицы; стек без сообщения.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ERRORS, sendError, safeStack, langOf } from './errors.js';

test('у каждого кода — статус и текст на ru / uz / en; uz и en без кириллицы', () => {
  for (const [code, e] of Object.entries(ERRORS)) {
    assert.ok(e.status >= 400 && e.status < 600, code);
    for (const l of ['ru', 'uz', 'en']) assert.ok(String(e[l] || '').length > 3, code + ' ' + l);
    assert.ok(!/[а-яё]/i.test(e.uz) && !/[а-яё]/i.test(e.en), code + ': кириллица в uz/en');
  }
  for (const c of ['slot_taken', 'rate_limited', 'licence_lapsed', 'forbidden_scope', 'invalid_key', 'not_found', 'invalid_field']) assert.ok(ERRORS[c], c);
});

test('ответ ошибкой: код, текст на языке ?lang, поля сверх кода, заголовки', () => {
  const sent = {};
  const res = {
    set(k, v) { sent.headers = { ...(sent.headers || {}), [k]: v }; return this; },
    status(s) { sent.status = s; return this; },
    json(b) { sent.body = b; return this; },
  };
  sendError({ query: { lang: 'uz' } }, res, 'rate_limited', {}, { 'Retry-After': 7 });
  assert.equal(sent.status, 429);
  assert.equal(sent.headers['Retry-After'], '7');
  assert.equal(sent.body.error.code, 'rate_limited');
  assert.equal(sent.body.error.message, ERRORS.rate_limited.uz);
  sendError({ query: {} }, res, 'invalid_field', { field: 'start', reason: 'past' });
  assert.deepEqual(sent.body.error, { code: 'invalid_field', message: ERRORS.invalid_field.ru, field: 'start', reason: 'past' });
  sendError({ query: {} }, res, 'нет такого');
  assert.equal(sent.status, 500);
  assert.equal(sent.body.error.code, 'internal');
  assert.equal(langOf({ query: { lang: 'EN' } }), 'en');
  assert.equal(langOf({ query: { lang: 'de' } }), null);
});

test('стек без первой строки — сообщение с присланным в журнал не попадает', () => {
  let err;
  try { JSON.parse('{"name":"ИМЯ_ПАЦИЕНТА"'); } catch (e) { err = e; }
  assert.ok(String(err.message).length > 0);
  assert.ok(!safeStack(err).includes('ИМЯ_ПАЦИЕНТА'));
});
