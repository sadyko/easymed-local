// CUSTDEV_V1 — supabase.rpc() возвращает { data, error } и НИКОГДА не бросает.
//
// Этот тест существует из-за настоящей поломки. В views/custdev.js стояло
//
//     state.rows = await supabase.rpc('custdev_list', b);
//
// и в state.rows ложился объект { data, error } вместо массива. rows.length
// давал undefined — экран честно писал «обзванивать некого», — а следующий
// rows.filter() падал TypeError-ом ещё до отрисовки колонок. Доска была пуста
// при 344 карточках в базе, и ни один из 46 серверных тестов этого не видел:
// они проверяли сервер, а сломан был договор между клиентом и rpc-хелпером.
//
// Тот же промах глушил ОШИБКИ СОХРАНЕНИЯ: отказ сервера ловился через
// try/catch, которого rpc() не использует, поэтому отклонённая оценка
// закрывала попап с «Оценка сохранена», не изменив ничего.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// public/js/admin/__tests__ -> repo root is four levels up.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

// Нормализуем переводы строк. На Windows core.autocrlf=true отдаёт файл с CRLF,
// и поиск по '\n' молча не находит ничего — ровно так уже сломаны два теста в
// clinic-after-login.test.mjs.
const src = fs.readFileSync(path.join(ROOT, 'public', 'js', 'admin', 'views', 'custdev.js'), 'utf8')
  .replace(/\r\n/g, '\n');

// Строки с вызовом rpc, кроме намеренно «слепого» custdev_sync: его ошибку
// глотаем осознанно (у клиники с просроченной лицензией это 402, а уже
// созданные карточки читаться должны).
function rpcCallLines() {
  return src.split('\n')
    .map((line, i) => ({ line: line.trim(), no: i + 1 }))
    .filter(({ line }) => line.includes('supabase.rpc(') && !line.startsWith('//'))
    .filter(({ line }) => !line.includes("'custdev_sync'"));
}

test('каждый вызов supabase.rpc разбирает { data, error } — иначе в переменную ляжет объект', () => {
  const bad = rpcCallLines().filter(({ line }) => !/^const\s*\{[^}]*\}\s*=\s*await\s+supabase\.rpc\(/.test(line));
  assert.deepEqual(bad.map((b) => `${b.no}: ${b.line}`), [],
    'эти вызовы присваивают результат целиком; rpc() отдаёт { data, error }, а не значение');
});

test('каждый вызов, меняющий данные, проверяет error — молчаливый отказ недопустим', () => {
  // Оператор держит пациента на линии: «сохранено» при несохранённой оценке —
  // худший из возможных исходов, потому что второй раз спросить будет не у кого.
  for (const name of ['custdev_rate', 'custdev_mark']) {
    const at = src.indexOf(`supabase.rpc('${name}'`);
    assert.ok(at > -1, `${name} должен вызываться из custdev.js`);
    // Смотрим ближайшие строки после вызова: там обязана быть проверка error.
    const after = src.slice(at, at + 500);
    assert.match(after, /if\s*\(error\)/, `${name}: отказ сервера обязан быть проверен`);
  }
});

test('успешное сохранение не рапортуется раньше проверки отказа', () => {
  // Ищем сам ВЫЗОВ toast(...), а не текст: комментарий рядом объясняет ту самую
  // поломку и тоже содержит слова «Оценка сохранена» — по подстроке тест ловил
  // бы объяснение вместо кода.
  const at = src.indexOf("supabase.rpc('custdev_rate'");
  const after = src.slice(at);
  const errCheck = after.indexOf('if (error)');
  const okToast = after.indexOf("toast('Оценка сохранена");
  assert.ok(errCheck > -1, 'проверка отказа должна существовать');
  assert.ok(okToast > -1, 'сообщение об успехе должно существовать');
  assert.ok(errCheck < okToast, 'проверка ошибки обязана предшествовать сообщению об успехе');
});
