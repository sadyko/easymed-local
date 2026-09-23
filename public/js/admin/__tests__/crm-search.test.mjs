// CRM_DEDUP_SEARCH_TASKS_V1 (2026-09-23) — поиск на доске заявок.
//
// Владелец: «make search work without typing the space». В базе клиники номер
// записан четырьмя способами, имена — иногда с двойным пробелом, а доска
// грузит только последние 800 заявок. Тесты — ровно те случаи, что не
// находились: строка вводится в то же поле, что у человека, и проверяется,
// какие карточки остались на доске.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { S, RPC, mk, walk, textOf, byClass, tick } from './crm-harness.mjs';
import { leadMatchesQuery, nameKey } from '../views/crm-phone-match.js';

const { renderCrm } = await import('../views/crm.js');

const lead = (id, full_name, phone, extra = {}) =>
  ({ id, full_name, phone, status: 'in_process', source: 'call', created_at: '2026-09-20T10:00:00Z', ...extra });

const LEADS = [
  lead(1, 'Алиев Алишер', '+998 91 566 22 78'),
  lead(2, 'Каримова Азиза', '942846494'),
  lead(3, 'Юсупов Бекзод', '998904858855'),
  lead(4, 'Буронова  Феруза', '+998977770000'),
  lead(5, '+998935550011', '+998935550011', { patient_id: 9, patients: { id: 9, full_name: 'Рахимова Дилноза', mrn: 'A-9' } }),
];

async function boardWith(leads) {
  S.leads = leads; S.search = [];
  RPC.length = 0;
  const root = mk('div');
  await renderCrm(root, { onNavigate() {} });
  await tick();
  return root;
}
const searchBox = (root) => walk(root).find((n) => n.tagName === 'INPUT' && hasSearchClass(n));
const hasSearchClass = (n) => String(n.className).includes('crm-search');
async function type(root, q) {
  const inp = searchBox(root);
  assert.ok(inp, 'нет поля поиска');
  inp.value = q;
  inp.dispatchEvent({ type: 'input', target: inp, currentTarget: inp });
  await tick(560);   // SEARCH_DEBOUNCE_V1 — 500 мс паузы в наборе
  await tick(20);
}
const names = (root) => byClass(root, 'crm-card').map((c) => textOf(byClass(c, 'crm-card-name')[0]));

test('правило поиска: точные случаи из базы клиники (чистая функция, одна на доску и сервер)', () => {
  const cases = [
    ['+998 91 566 22 78', '915662278'],
    ['+998 91 566 22 78', '+998915662278'],
    ['942846494', '94 284 64 94'],
    ['998904858855', '+998904858855'],
  ];
  for (const [stored, q] of cases) assert.ok(leadMatchesQuery({ phone: stored }, q), `${stored} не найден по ${q}`);
  const fz = { full_name: 'Буронова  Феруза' };
  for (const q of ['буронова феруза', 'буроноваферуза', 'БУРОНОВА', ' феруза ']) {
    assert.ok(leadMatchesQuery(fz, q), 'не найдено по «' + q + '»');
  }
  assert.ok(!leadMatchesQuery(fz, 'каримова'));
  assert.ok(!leadMatchesQuery({ phone: '+998 91 566 22 78' }, '942846494'));
  assert.ok(leadMatchesQuery({ full_name: 'x', patients: { full_name: 'Рахимова Дилноза' } }, 'рахимовадилноза'));
  assert.equal(nameKey('  Ёлкина   Анна '), 'елкинаанна');
});

test('поле поиска — с отложенным набором (SEARCH_DEBOUNCE_V1 применяется к нему)', async () => {
  const root = await boardWith(LEADS);
  const inp = searchBox(root);
  assert.equal(inp.getAttribute('type'), 'search');
  assert.match(inp.getAttribute('placeholder'), /поиск/i);
  inp.value = '915662278';
  inp.dispatchEvent({ type: 'input', target: inp, currentTarget: inp });
  await tick(40);
  assert.equal(names(root).length, LEADS.length, 'доска отфильтровалась, не дождавшись паузы');
  await tick(560);
  assert.equal(names(root).length, 1);
});

test('номер находится по цифрам в любом написании', async () => {
  const root = await boardWith(LEADS);
  for (const [q, want] of [['915662278', 'Алиев Алишер'], ['+998915662278', 'Алиев Алишер'],
    ['94 284 64 94', 'Каримова Азиза'], ['+998904858855', 'Юсупов Бекзод']]) {
    await type(root, q);
    assert.deepEqual(names(root), [want], 'по «' + q + '»');
  }
});

test('имя — без учёта пробелов; и имя привязанного пациента', async () => {
  const root = await boardWith(LEADS);
  for (const q of ['буронова феруза', 'буроноваферуза']) {
    await type(root, q);
    assert.deepEqual(names(root), ['Буронова  Феруза'], 'по «' + q + '»');
  }
  await type(root, 'рахимова');
  assert.equal(names(root).length, 1, 'заявка пациента не нашлась по его имени');
});

test('при наборе спрашивается сервер — и старая заявка за пределами 800 появляется на доске', async () => {
  const root = await boardWith(LEADS);
  S.search = (body) => (body.q === 'саидова' ? [lead(7, 'Саидова Нигора', '+998901230000', { created_at: '2024-01-05T10:00:00Z' })] : []);
  await type(root, 'саидова');
  // (при монтировании доска могла переспросить прежнюю строку поиска — её
  // state живёт в модуле; здесь важен только запрос этой строки)
  const ask = RPC.filter((r) => r.name === 'crm_search' && r.body.q !== 'рахимова');
  assert.equal(ask.length, 1, 'сервер не спросили или спросили на каждую букву');
  assert.deepEqual(ask[0].body, { q: 'саидова' });
  assert.deepEqual(names(root), ['Саидова Нигора']);

  // очистили поиск — снова обычная доска, ответ сервера забыт
  const clearBtn = walk(root).find((n) => n.tagName === 'BUTTON' && n.getAttribute('title') === 'Очистить');
  clearBtn.click();
  await tick(20);
  assert.equal(names(root).length, LEADS.length);
});

test('сервер не ответил — поиск по загруженным всё равно работает', async () => {
  const root = await boardWith(LEADS);
  S.search = () => { throw new Error('boom'); };
  await type(root, 'каримова').catch(() => {});
  assert.deepEqual(names(root), ['Каримова Азиза']);
  S.search = [];
});

test('ревью W2-M2: полный узбекский номер не находит чужой номер с теми же последними цифрами', () => {
  assert.ok(!leadMatchesQuery({ phone: '+7 991 234 56 78' }, '+998912345678'), '+7 991… нашёлся по +998 91…');
  // два номера в одном поле: поиск находит карточку по любому из них (это поиск,
  // а не проверка дубля — дублем такая карточка ни одному номеру не считается)
  assert.ok(leadMatchesQuery({ phone: '+998 90 111 22 33, +998 91 234 56 78' }, '912345678'));
  assert.ok(leadMatchesQuery({ phone: '+7 991 234 56 78' }, '+7 991 234 56 78'));
  assert.ok(leadMatchesQuery({ phone: '+7 991 234 56 78' }, '2345678'), 'часть номера перестала находить');
  assert.ok(leadMatchesQuery({ phone: '0912345678' }, '+998 91 234 56 78'));
});
