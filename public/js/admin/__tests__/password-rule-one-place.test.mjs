// PASSWORD_RULE_ONE_PLACE_V1 (2026-09-23) — у пароля одно правило: не пустой.
//
// Владелец: «give permission to 1 or 2 character passwords». Сервер это
// разрешил ещё в PASSWORD_CLINIC_RULE_V1 (server/services/auth.js
// validPassword: от 1 символа до 72 байт), а экраны остались со своими
// копиями старых правил — и каждая молча не пускала короткий пароль ещё в
// браузере: minlength="8" на первом входе, «мин. 8 символов» в меню аватара,
// «минимум 6» в старом редакторе сотрудника, «минимум 8» в импорте из Excel.
// Правка одной копии оставляла живыми остальные — это и есть класс ошибки.
//
// Поэтому проверка идёт по ВСЕМ клиентским файлам под public/ (кроме тестов):
//   * minlength больше 1 на поле пароля;
//   * сравнение длины с порогом больше 1 рядом со словом «пароль»/password;
//   * текст вида «минимум N символов», «min 8», «8+ characters» про пароль —
//     включая словарь переводов: подсказка со старым числом врёт так же.
// Единственный порог длины на клиенте — MIN_PASSWORD_LENGTH в
// admin/password-change.js, и он равен 1.
//
// Вендорская панель (control-plane) живёт по своему, строгому правилу — она
// смотрит в интернет — и лежит вне public/, эта проверка её не касается.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, '..', '..', '..');

const PW = /pass(?:word)?|pwd|парол/i;

function clientFiles(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === '__tests__' || ent.name === 'node_modules') continue;
      clientFiles(p, out);
      continue;
    }
    if (!/\.(m?js|html)$/.test(ent.name) || /\.test\.m?js$/.test(ent.name)) continue;
    out.push(p);
  }
  return out;
}

/** Нарушения правила в одном тексте файла: [{ line, kind, text }]. */
export function passwordRuleOffences(src) {
  const lines = src.split(/\r?\n/);
  const found = [];
  lines.forEach((raw, i) => {
    const t = raw.trim();
    // Комментарии рассказывают историю правила (включая старые числа) — это не правило.
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('<!--')) return;
    const code = raw.replace(/\s\/\/\s.*$/, '');
    const near = lines.slice(Math.max(0, i - 2), i + 1).join('\n');
    let m;
    if ((m = /minlength\s*[=:]\s*["']?(\d+)/i.exec(code)) && Number(m[1]) > 1 && PW.test(code)) {
      found.push({ line: i + 1, kind: 'minlength', text: t });
    }
    const cmp = /\.length\s*(<=?)\s*(\d+)/g;
    while ((m = cmp.exec(code))) {
      const n = Number(m[2]);
      if (((m[1] === '<' && n > 1) || (m[1] === '<=' && n >= 1)) && PW.test(near)) {
        found.push({ line: i + 1, kind: 'length', text: t });
      }
    }
    const words = /(?:минимум|мин\.|не менее|at least|minimum|min\.?|kamida)\s*(\d+)|(\d+)\+\s*(?:char|символ)/gi;
    while ((m = words.exec(code))) {
      if (Number(m[1] || m[2]) > 1 && PW.test(code)) found.push({ line: i + 1, kind: 'text', text: t });
    }
  });
  return found;
}

test('проверка ловит каждую из старых копий правила (иначе она ничего не стережёт)', () => {
  for (const sample of [
    '<input id="new-password" type="password" minlength="8" required>',
    "if (p1.length < 8)  { errEl.textContent = 'x'; passInp.focus(); return; }",
    "if (!payload.password || String(payload.password).length < 8) {",
    "const passInp = h('input', { type: 'password', placeholder: 'Новый пароль (мин. 8 символов)' });",
    '<label for="new-password">New password (8+ characters)</label>',
    '<label for="a-password">Password (min 8)</label>',
    "  \"Пароль должен содержать минимум 6 символов.\": {\"en\":\"Password must be at least 6 characters.\"},",
  ]) {
    assert.ok(passwordRuleOffences(sample).length > 0, 'не поймано: ' + sample);
  }
  for (const fine of [
    "if (String(next ?? '').length < MIN_PASSWORD_LENGTH) return 'x';",
    "if (!String(payload.password ?? '').length) {",
    '<input id="new-password" type="password" required>',
    "if (q.length < 3) return;   // поиск",
    '// было «минимум 6 символов» для пароля — история, не правило',
  ]) {
    assert.deepEqual(passwordRuleOffences(fine), [], 'ложная тревога: ' + fine);
  }
});

test('ни один клиентский файл под public/ не требует пароль длиннее одного символа', () => {
  const offences = [];
  for (const file of clientFiles(PUBLIC)) {
    for (const o of passwordRuleOffences(fs.readFileSync(file, 'utf8'))) {
      offences.push(`${path.relative(PUBLIC, file)}:${o.line} [${o.kind}] ${o.text.slice(0, 120)}`);
    }
  }
  assert.deepEqual(offences, [],
    'правило пароля — «не пустой» (server/services/auth.js validPassword); копия со старым числом не пускает короткий пароль ещё в браузере');
});

test('единственный порог на клиенте — MIN_PASSWORD_LENGTH = 1', async () => {
  const src = fs.readFileSync(path.join(HERE, '..', 'password-change.js'), 'utf8');
  assert.match(src, /export const MIN_PASSWORD_LENGTH = 1;/);
  assert.match(src, /PASSWORD_RULE_ONE_PLACE_V1/);
});
