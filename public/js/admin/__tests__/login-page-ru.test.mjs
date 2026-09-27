// V3120_FIX (2026-09-27) — СТРАНИЦА ВХОДА ПО-РУССКИ.
//
// Инспекция v3.12.0: всё приложение русское, а первое, что видит сотрудник, —
// «Sign in», «Set a new password before continuing», «Passwords do not match.»,
// и страница объявляла себя lang="en" — браузер предлагал «перевести с
// английского» русский интерфейс (тот же класс, что NO_BROWSER_TRANSLATE_V1
// у admin.html). Причины отказа сервера (server/routes/auth.js) приходят
// английскими — известные переводятся на странице.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(HERE, '..', '..', '..');
const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');

test('index.html — русская страница, которую браузер не переводит', () => {
  assert.match(html, /<html lang="ru" translate="no">/);
  for (const en of ['Sign in', 'Username', 'Password', 'Set a new password', 'Repeat new password', 'Save and continue', 'Clinic management system']) {
    assert.equal(html.includes('>' + en), false, 'на странице входа осталось английское «' + en + '»');
  }
  for (const ru of ['Войти', 'Логин', 'Пароль', 'Сохранить и продолжить']) {
    assert.ok(html.includes(ru), 'нет «' + ru + '»');
  }
});

test('login.js — свои сообщения русские, известные отказы сервера переводятся', async () => {
  const src = fs.readFileSync(path.join(PUB, 'js', 'login.js'), 'utf8');
  for (const en of ['Passwords do not match.', 'Please sign in first.']) {
    assert.equal(src.includes("textContent = '" + en), false, 'осталось «' + en + '»');
  }
  // Модуль вешает обработчики на форму при импорте — даём ему минимальный DOM.
  const el = () => ({ hidden: false, textContent: '', addEventListener() {}, querySelector: () => ({ focus() {}, disabled: false }) });
  globalThis.document = { getElementById: () => el() };
  globalThis.location = { href: '/', pathname: '/' };
  globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'Login required.' } }) });
  const { loginMessageRu } = await import(pathToFileURL(path.join(PUB, 'js', 'login.js')).href);
  assert.equal(loginMessageRu('Wrong username or password.'), 'Неверный логин или пароль.');
  assert.equal(loginMessageRu('Too many attempts. Try again in a few minutes.'), 'Слишком много попыток. Попробуйте через несколько минут.');
  assert.equal(loginMessageRu('Something new'), 'Something new', 'незнакомая причина должна показываться как есть');
  // V3120_I18N — сервер теперь сам отвечает по-русски, и ровно теми фразами,
  // что стоят в SERVER_MSG_RU (английские ключи остаются для старого сервера).
  // Русская фраза проходит loginMessageRu без изменений.
  const auth = fs.readFileSync(path.resolve(PUB, '..', 'server', 'routes', 'auth.js'), 'utf8');
  for (const en of ['Wrong username or password.', 'Too many attempts. Try again in a few minutes.', 'Current password is wrong.']) {
    const ru = loginMessageRu(en);
    assert.ok(auth.includes("'" + ru + "'"), 'сервер не шлёт «' + ru + '» — фраза сервера и SERVER_MSG_RU в login.js разошлись');
    assert.equal(auth.includes("'" + en + "'"), false, 'сервер всё ещё шлёт английское «' + en + '»');
    assert.equal(loginMessageRu(ru), ru);
  }
});
