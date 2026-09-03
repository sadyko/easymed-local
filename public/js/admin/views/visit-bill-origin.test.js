import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { STRINGS } from '../i18n-strings.js';
import { isOwnBuilding, originTag } from '../record-origin.js';

// BRANCH_BILL_GUARD_V1 (2026-09-03) — то, что не даёт кассе выставить счёт
// повторно и стереть работу соседнего филиала.
//
// ЧТО БЫЛО. Карта пациента показывает всю историю, включая визиты, сделанные в
// другом здании, и по клику открывала «Bill & Pay» ДЛЯ ЛЮБОГО из них. Панель
// читала visit_services визита без границы; `invoice_item_id` не входит в
// перечень колонок, которые едут между филиалами (branch-sync/journal.js
// SHIPPED), поэтому каждая приехавшая строка выглядела здесь невыставленной, а
// счетов и платежей соседа в этой базе нет вовсе. Кассир видел «неоплаченные»
// услуги и пустой список счетов — и «Generate invoice» брал с пациента деньги
// второй раз. «Remove» на такой строке делал DELETE FROM visit_services,
// триггер журнала (084) писал надгробие, и строка исчезала В ТОМ ФИЛИАЛЕ.
//
// ЧИТАЕТ ТЕКСТ, А НЕ ИМПОРТИРУЕТ ЭКРАН: views/visit-bill.js тянет ui.js и
// supabase.js и требует DOM (проверено — `import` падает на `document is not
// defined`). Тот же приём и та же причина, что у branch-sync-i18n.test.js и
// updates-i18n.test.js.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VIEW_PATH = path.join(HERE, 'visit-bill.js');
const src = fs.readFileSync(VIEW_PATH, 'utf8');

const CYRILLIC = /[Ѐ-ӿ]/;
const LANGS = ['ru', 'uz', 'en'];

/** Убрать комментарии, не тронув строковые литералы (копия приёма из branch-sync-i18n.test.js). */
function stripComments(source) {
  let out = '';
  let i = 0;
  const BACKSLASH = String.fromCharCode(92);
  while (i < source.length) {
    const c = source[i];
    if (c === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      out += c;
      i += 1;
      while (i < source.length) {
        if (source[i] === BACKSLASH) { out += source[i] + (source[i + 1] || ''); i += 2; continue; }
        out += source[i];
        if (source[i] === quote) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

const code = stripComments(src);

// ---------------------------------------------------------------------------
// Предикат — тот же, что у рабочих списков (visits.js:91, procedures.js:50,
// где он записан как SQL `.is('sync_origin', null)`).
// ---------------------------------------------------------------------------

test('чужой визит — не свой; свой остаётся своим', () => {
  assert.equal(isOwnBuilding({ id: 7, sync_origin: 'C' }), false);
  assert.equal(originTag({ id: 7, sync_origin: 'C' }), 'C', 'букву показываем в отказе');
  assert.equal(isOwnBuilding({ id: 7, sync_origin: null }), true, 'свой визит — прежнее поведение');
  assert.equal(isOwnBuilding({ id: 7 }), true, 'визит без колонки считается своим: касса не должна закрыться на старой базе');
});

// ---------------------------------------------------------------------------
// Сам экран
// ---------------------------------------------------------------------------

test('касса спрашивает происхождение ПЕРВОЙ строкой и выходит', () => {
  const entry = code.indexOf('export function openVisitBillModal');
  assert.ok(entry > 0, 'точка входа на месте');

  const guard = code.indexOf('if (!isOwnBuilding(visit))', entry);
  assert.ok(guard > entry, 'в openVisitBillModal есть проверка происхождения визита');
  assert.match(code.slice(guard, guard + 140), /openForeignVisitNotice\(originTag\(visit\)\);\s*return;/,
    'чужой визит показывает отказ и выходит — иначе панель строится дальше');

  // Ни одна касса-строка не должна выполниться раньше проверки.
  for (const marker of ['let unInvoicedIds', 'function lineRow', 'async function loadLines',
                        'async function removeLine', "supabase.from('visit_services')",
                        "supabase.rpc('create_invoice_for_visit'", "supabase.rpc('record_payment'"]) {
    const at = code.indexOf(marker, entry);
    assert.ok(at > guard, `«${marker}» обязан идти ПОСЛЕ проверки происхождения`);
  }
});

test('в отказе нет ни одной кнопки, которая тратит или удаляет', () => {
  const start = code.indexOf('function openForeignVisitNotice(');
  const end = code.indexOf('export function openVisitBillModal');
  assert.ok(start > 0 && end > start, 'окно отказа определено до точки входа');
  const notice = code.slice(start, end);

  for (const forbidden of ['Remove', 'Generate invoice', 'Take payment', 'Dispense',
                           "' Add'", 'supabase.', 'create_invoice_for_visit', 'record_payment']) {
    assert.equal(notice.includes(forbidden), false,
      `окно отказа не должно содержать «${forbidden}» — оно только объясняет, где выставляют счёт`);
  }
  assert.ok(notice.includes('Этот визит сделан в филиале {letter} — счёт выставляют там'),
    'отказ называет филиал теми же словами, что и метки в списках');
  assert.ok(notice.includes('Филиал {letter}'), 'метка филиала — та же формулировка, что в карте пациента');
});

test('для своего визита экран прежний: касса на месте', () => {
  const entry = code.indexOf('export function openVisitBillModal');
  const body = code.slice(entry);
  for (const kept of ["'Remove'", "' Generate invoice'", "'Take payment'",
                      "supabase.rpc('create_invoice_for_visit'", "supabase.rpc('record_payment'",
                      "supabase.rpc('dispense_item'", "supabase.rpc('void_dispense'"]) {
    assert.ok(body.includes(kept), `«${kept}» осталась в кассе своего визита`);
  }
});

test('каждая русская строка отказа есть в словаре на трёх языках', () => {
  const re = /(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g;
  const seen = [];
  let m;
  while ((m = re.exec(code)) !== null) {
    const raw = m[2];
    if (!CYRILLIC.test(raw)) continue;
    if (m[1] === '`' && raw.includes('${')) continue;   // сборка из уже переведённых кусков
    seen.push(raw);
  }
  assert.ok(seen.length >= 3, 'в файле есть русский текст экрана — иначе тест ничего не проверил');
  for (const raw of seen) {
    const entry = STRINGS[raw];
    assert.ok(entry, `нет ключа словаря: «${raw}»`);
    for (const lang of LANGS) {
      assert.equal(typeof entry[lang], 'string', `«${raw}»: нет перевода ${lang}`);
      assert.notEqual(entry[lang].trim(), '', `«${raw}»: пустой перевод ${lang}`);
    }
  }
});
