import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { STRINGS } from '../i18n-strings.js';
import { fill } from '../updates-logic.js';
import {
  roleBadge, roleExplainer, syncLine, syncKeyLine, relayExplainer, publishLine, seedLine, whenLabel,
  letterExplainer, branchRows, branchListNote, changesLabel, routeLabel,
  pairedMessage, KEY_LOSS_WARNING, KEY_REISSUE_WARNING, KEY_REISSUE_QUESTION,
  LETTER_PERMANENCE_WARNING, ADD_BRANCH_QUESTION, ISSUE_KEY_QUESTION,
  UNLINK_WARNING_MAIN, UNLINK_WARNING_SECONDARY, UNLINK_QUESTION,
  UNLINKED_BRANCH_NOTE, IDENTITY_UNKNOWN_NOTE, RELAY_ACCESS_ISSUED,
} from '../branch-sync-logic.js';

// BRANCH_SYNC_I18N_V1 (2026-08-30) — то, что не даёт экрану «Настройки →
// Филиалы» снова заговорить по-русски в узбекской клинике.
//
// ЧТО СЛУЧИЛОСЬ. На английском экране владелец видел две русские строки:
// «Зашифрованная копия справочника…» под переключателем резервного канала и
// «Ключ синхронизации есть. Создан 12.08.2026.» под ключом. Первой просто не
// было в i18n-strings.js. Вторую не спасла бы и запись в словаре: она
// СКЛЕИВАЛАСЬ с датой (`'Ключ синхронизации есть.' + ' Создан ' + when + '.'`),
// а tr() (i18n.js) ищет в словаре строку ЦЕЛИКОМ — такой ключ не мог бы
// совпасть ни при каком языке.
//
// ПОЧЕМУ ОДНОГО СЛОВАРЯ МАЛО. tr() ВОЗВРАЩАЕТ НЕИЗВЕСТНУЮ СТРОКУ КАК ЕСТЬ, и
// это правильно: непереведённый экран не должен падать. Но из-за этого
// пропущенный литерал выглядит для того, кто его писал, точно так же, как
// работающий экран. Единственная надёжная проверка — вот эта: прочитать
// исходник экрана и утверждать свойство напрямую.
//
// ЧИТАЕТ ТЕКСТ, А НЕ ИМПОРТИРУЕТ ЭКРАН: views/branch-sync.js тянет
// ui.js/supabase.js и требует DOM. Этому файлу не нужно ни то, ни другое.
// Тот же приём и та же причина, что у views/updates-i18n.test.js (08ab775).
//
// ПРАВИЛО ЗДЕСЬ СТРОЖЕ, чем у updates.js, и это не придирка. Там каждый
// литерал обёрнут явным tr(), поэтому проверялось «обёрнут ли». Здесь текст
// доходит до экрана двумя путями — явным tr() и автоматическим переводом
// текстовых узлов внутри h() (ui.js), — так что «обёрнут» ничего не значит.
// Проверяется то, что важно на самом деле: КАЖДЫЙ русский литерал экрана,
// каким бы путём он ни шёл, обязан быть ключом словаря во всех трёх языках.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VIEW_PATH = path.join(HERE, 'branch-sync.js');

const CYRILLIC = /[Ѐ-ӿ]/;
const LANGS = ['ru', 'uz', 'en'];

/**
 * Убрать комментарии, не тронув строковые литералы.
 *
 * Наивное /\/\/.*$/ съело бы половину «Не удалось…» на первом же слэше внутри
 * строки, а правило, написанное наоборот, приняло бы русские комментарии этого
 * репозитория за непереведённый текст экрана. В этом коде в комментариях живут
 * рассуждения — исключать их надо точно.
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  const BACKSLASH = String.fromCharCode(92);
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      out += c;
      i += 1;
      while (i < src.length) {
        if (src[i] === BACKSLASH) { out += src[i] + (src[i + 1] || ''); i += 2; continue; }
        out += src[i];
        if (src[i] === quote) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * Каждый строковый литерал экрана, в котором есть кириллица.
 *
 * ШАБЛОННЫЕ ЛИТЕРАЛЫ СО ВСТАВКАМИ пропускаются намеренно и только они: строка
 * вида `${tr(a)}. ${tr(b)} — ${letter}` — это не текст, а СБОРКА уже
 * переведённых кусков, и каждый кусок внутри неё ловится этим же обходом
 * отдельно. Требовать словарной записи от самой сборки значило бы требовать
 * ключ, которого не существует.
 */
function collectLiterals(src) {
  const code = stripComments(src);
  const re = /(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g;
  const out = [];
  let m;
  while ((m = re.exec(code)) !== null) {
    const raw = m[2];
    if (!CYRILLIC.test(raw)) continue;
    if (m[1] === '`' && raw.includes('${')) continue;
    out.push({ raw, near: code.slice(Math.max(0, m.index - 70), m.index + 50).replace(/\s+/g, ' ') });
  }
  return out;
}

const viewSrc = fs.readFileSync(VIEW_PATH, 'utf8');

/**
 * Каждая фраза, которую branch-sync-logic.js реально ОТДАЁТ экрану — собранная
 * вызовами, а не грепом по исходнику.
 *
 * Грепом её не собрать: тексты сидят в таблицах состояний, в тернарниках и в
 * ветках по роли, а регулярка, которая молча не нашла ничего, превратила бы
 * весь этот файл в тест, который проходит, потому что ничего не проверил.
 *
 * translate-шпион ловит ВНУТРЕННИЕ куски (путь синхронизации, слова перечня
 * изменений): они склеиваются внутри фразы вокруг чисел, поэтому целой строкой
 * в словаре не найдутся никогда — переводится каждое слово по отдельности.
 */
function everyPhrase() {
  const out = new Set();
  const take = (x) => { if (x && x.template) out.add(x.template); };
  const spy = (s) => { out.add(s); return s; };

  for (const role of ['main', 'secondary', 'none']) {
    out.add(roleBadge({ role }).label);
    out.add(roleExplainer({ role }));
  }
  out.add(roleBadge(null).label);
  out.add(pairedMessage(null).base);

  // Состояние связи: четыре ветки — «не было», «сорвалось без прошлого успеха»,
  // «сорвалось, но раньше работало», «получилось» (прямо и через сервер).
  take(syncLine({}, spy));
  take(syncLine({ last_attempt: { at: '2026-08-29T09:05:00Z', ok: false } }, spy));
  take(syncLine({
    last_attempt: { at: '2026-08-29T09:05:00Z', ok: false, message: 'Нет связи.' },
    last_ok: { at: '2026-08-28T19:40:00Z', ok: true },
  }, spy));
  take(syncLine({ last_ok: { at: '2026-08-28T19:40:00Z', ok: true } }, spy));
  take(syncLine({ last_ok: { at: '2026-08-28T19:40:00Z', ok: true, route: 'relay', relayed_at: '2026-08-27T10:00:00Z' } }, spy));
  // BRANCH_MAIN_PUSH_V1 — успех ГЛАВНОЙ клиники: фраза приходит с сервера, но
  // обёртка вокруг неё («… (синхронизация 03.09.2026 13:41).») — экранная, и
  // без записи в словаре уехала бы в узбекскую клинику по-русски.
  take(syncLine({ role: 'main', last_ok: { at: '2026-09-03T08:41:40Z', ok: true, reason: 'published', message: 'Копия справочника отправлена на сервер (17 КБ).' } }, spy));

  // Перечень изменений: все шесть таблиц справочника + обе группы + «ничего».
  changesLabel({
    ok: true,
    created: { services: 1, lab_panels: 1, lab_panel_analytes: 1 },
    updated: { service_types: 1, service_categories: 1, departments: 1 },
    settings: true,
  }, spy);
  changesLabel({ ok: true }, spy);
  routeLabel({ route: 'relay' }, spy);
  routeLabel({}, spy);

  take(syncKeyLine({ sync_key_present: true, relay_ready: true, sync_key_created_at: '2026-08-12T10:00:00Z' }));
  take(syncKeyLine({ sync_key_present: true, relay_ready: true }));
  take(syncKeyLine({ sync_key_present: true, relay_ready: false }));
  take(syncKeyLine({}));

  out.add(relayExplainer({ role: 'main' }));
  out.add(relayExplainer({ role: 'secondary' }));
  take(publishLine({ role: 'main', relay_enabled: false }));
  take(publishLine({ role: 'main', relay_enabled: true }));
  take(publishLine({ role: 'main', relay_enabled: true, relay_last_publish: { at: '2026-08-29T09:00:00Z' } }));

  // Первичная загрузка: все три фразы — та, что видит филиал (с оценкой числа
  // страниц и без неё), и та, что видит главная.
  take(seedLine({ seed: { receiving: { from: 'B', page: 3, pages: 12 } } }));
  take(seedLine({ seed: { receiving: { from: 'B', page: 1, pages: 0 } } }));
  take(seedLine({ seed: { sending: [{ letter: 'B', page: 3 }] } }));

  take(letterExplainer({ letter: 'C' }));
  out.add(branchListNote({ role: 'secondary' }));

  // Список филиалов: все пять состояний строки, с кнопками и без.
  for (const branches of [
    [{ id: 1, name: 'Главный', letter: 'A', key: null, is_self: true }],
    [{ id: 2, name: 'Чиланзар', letter: 'B', key: 'EMB2-x', has_relay_token: false }],
    [{ id: 3, name: 'Юнусабад', letter: 'C', key: 'EMB2-y', has_relay_token: true }],
    [{ id: 4, name: 'Старый', letter: null, key: null }],
    [{ id: 5, name: 'Без ключа', letter: 'D', key: null }],
  ]) {
    for (const row of branchRows({ role: 'main', can_issue: true, can_relay: true, branches })) {
      for (const v of [row.selfTag, row.keyStatus, row.warnTag,
        row.action && row.action.label, row.action && row.action.done]) {
        if (v) out.add(v);
      }
    }
  }

  // Предупреждения и вопросы окон подтверждения — теперь единственный адрес
  // всего необратимого на этом экране.
  for (const s of [KEY_LOSS_WARNING, KEY_REISSUE_WARNING, KEY_REISSUE_QUESTION,
    LETTER_PERMANENCE_WARNING, ADD_BRANCH_QUESTION, ISSUE_KEY_QUESTION,
    UNLINK_WARNING_MAIN, UNLINK_WARNING_SECONDARY, UNLINK_QUESTION,
    UNLINKED_BRANCH_NOTE, IDENTITY_UNKNOWN_NOTE, RELAY_ACCESS_ISSUED]) out.add(s);

  return [...out];
}

/** Одна проверка на набор строк: есть в словаре и есть во всех трёх языках. */
function missingFrom(strings) {
  const missing = [];
  for (const raw of strings) {
    const entry = STRINGS[raw];
    if (!entry) { missing.push(`${JSON.stringify(raw)} — нет в STRINGS вовсе`); continue; }
    for (const lang of LANGS) {
      if (typeof entry[lang] !== 'string' || entry[lang].trim() === '') {
        missing.push(`${JSON.stringify(raw)} — нет ${lang}`);
      }
    }
  }
  return missing;
}

test('branch-sync.js: каждый русский литерал экрана есть в словаре, во всех трёх языках', () => {
  const lits = collectLiterals(viewSrc);
  // Если это когда-нибудь схлопнется до горстки — значит сломался сборщик, а не
  // экран похудел. Тест, который молча ничего не нашёл, — не тест.
  assert.ok(lits.length >= 25, `ожидался весь экран, найдено литералов: ${lits.length}`);

  const byRaw = new Map(lits.map((l) => [l.raw, l]));
  const missing = missingFrom([...byRaw.keys()]);
  assert.deepEqual(
    missing, [],
    'tr() отдаёт неизвестную строку КАК ЕСТЬ, поэтому эти уедут в клинику по-русски:\n  '
      + missing.map((s) => `${s}\n    рядом: …${(byRaw.get(s.split(' — ')[0].slice(1, -1)) || {}).near || ''}…`).join('\n  '),
  );
});

test('branch-sync-logic.js: каждая фраза, которую он отдаёт экрану, — ключ словаря во всех трёх языках', () => {
  // Экран рисует их через say() → tr(template) → fill(). Шаблон, которого нет в
  // словаре, — тот же молчаливый русский проход, только на модуль дальше от
  // экрана.
  const all = everyPhrase();
  assert.ok(all.length >= 45, `ожидался весь набор фраз экрана, найдено ${all.length}`);
  const missing = missingFrom(all);
  assert.deepEqual(missing, [], 'непереводимые фразы:\n  ' + missing.join('\n  '));
});

test('перевод сохраняет те же дырки, что и русский оригинал', () => {
  // Потерянный {date} — это как «Ключ синхронизации есть. Создан .» в одном
  // языке из трёх, чего никто, кроме читающих на нём, никогда не заметит.
  const problems = [];
  for (const raw of everyPhrase()) {
    const holes = [...raw.matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort();
    if (!holes.length) continue;
    const entry = STRINGS[raw];
    if (!entry) continue;   // об этом кричит тест выше
    for (const lang of LANGS) {
      const got = [...String(entry[lang] || '').matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort();
      if (got.join(',') !== holes.join(',')) {
        problems.push(`${JSON.stringify(raw)} [${lang}] имеет {${got.join('},{')}}, а нужны {${holes.join('},{')}}`);
      }
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('ни один перевод не является копией русского (транслитерация — не перевод)', () => {
  // Значение uz/en, дословно совпадающее с ru, — верный признак записи-заглушки,
  // которую завели и не заполнили.
  const same = [];
  const check = (raw) => {
    const e = STRINGS[raw];
    if (!e) return;
    for (const lang of ['uz', 'en']) if (e[lang] === e.ru) same.push(`${JSON.stringify(raw)} — ${lang} совпадает с ru`);
  };
  for (const raw of everyPhrase()) check(raw);
  for (const { raw } of collectLiterals(viewSrc)) check(raw);
  assert.deepEqual(same, [], same.join('\n'));
});

test('перевести дважды — то же самое, что перевести один раз (h() уже переводит свои текстовые узлы)', () => {
  // ui.js h() прогоняет через tr() каждый простой текстовый ребёнок и aria-label,
  // поэтому явно обёрнутый tr('…'), отданный в h(), переводится ДВАЖДЫ. Это
  // безобидно ровно до тех пор, пока ни один перевод сам не является ключом,
  // означающим что-то другое, — а в STRINGS есть английские ключи, так что
  // ловушка настоящая, а не теоретическая.
  const used = new Set(everyPhrase());
  for (const { raw } of collectLiterals(viewSrc)) used.add(raw);

  const problems = [];
  for (const raw of used) {
    const entry = STRINGS[raw];
    if (!entry) continue;
    for (const lang of LANGS) {
      const once = entry[lang];
      const again = STRINGS[once];
      if (again && again[lang] !== once) {
        problems.push(`${JSON.stringify(raw)} [${lang}] → ${JSON.stringify(once)} → ${JSON.stringify(again[lang])}`);
      }
    }
  }
  assert.deepEqual(problems, [], 'двойной перевод меняет эти строки:\n  ' + problems.join('\n  '));
});

// --- ровно те две строки, которые владелец увидел по-русски -----------------

test('«Ключ синхронизации есть. Создан …» больше не склеивается, а переводится', () => {
  // Было: 'Ключ синхронизации есть.' + ' Создан ' + when + '.' — ключа такой
  // формы в словаре нет и быть не может ни при каком языке.
  const ready = syncKeyLine({ sync_key_present: true, relay_ready: true, sync_key_created_at: '2026-08-12T10:00:00Z' });
  assert.equal(ready.state, 'ready');
  assert.equal(ready.template, 'Создан {date}.', 'дырка обязана дожить до словаря');
  assert.ok(STRINGS[ready.template], 'шаблон обязан быть ключом словаря');
  // И подстановка идёт ПОСЛЕ перевода, иначе всё это бессмысленно.
  //
  // Ожидаемую дату считаем тем же whenLabel(), которым её считает сам
  // syncKeyLine — НЕ строкой '15:00'. Первая версия этого теста вписала
  // '12.08.2026 15:00.' буквально: у автора UTC+5, и Z-время 10:00 у него
  // рисуется как 15:00. На сборочной машине GitHub часовой пояс UTC, там та
  // же секунда — 10:00, и релиз v0.4.6 не смог собраться вообще: тест падал
  // детерминированно при зелёной локальной прогонке. Предмет теста — что
  // шаблон доживает до словаря и дырка заполняется после перевода; какие
  // именно цифры в дате, предметом не является.
  const when = whenLabel('2026-08-12T10:00:00Z');
  assert.equal(fill(STRINGS[ready.template].en, ready.params), `Created ${when}.`);
  assert.equal(fill(STRINGS[ready.template].uz, ready.params), `${when} da yaratilgan.`);
  // Прежняя склейка не должна вернуться ни одной своей половиной.
  assert.equal(/Ключ синхронизации есть/.test(ready.template), false,
    'заголовок блока уже говорит «Ключ синхронизации» — второй раз не нужен');
});

test('фраза про зашифрованную копию справочника есть в словаре', () => {
  // Вторая строка со скриншота: её просто не было в i18n-strings.js.
  for (const role of ['main', 'secondary']) {
    const text = relayExplainer({ role });
    const entry = STRINGS[text];
    assert.ok(entry, `нет в словаре: ${JSON.stringify(text)}`);
    for (const lang of LANGS) assert.ok(entry[lang] && entry[lang].trim(), `${role}: нет ${lang}`);
  }
  assert.notEqual(relayExplainer({ role: 'main' }), relayExplainer({ role: 'secondary' }),
    'роли соглашаются на разное: главный отдаёт копию наружу, подключённый только берёт');
});

test('fill(): значения возвращаются ПОСЛЕ перевода, а неизвестная дырка остаётся видимой', () => {
  assert.equal(fill('Создан {date}.', { date: '12.08.2026' }), 'Создан 12.08.2026.');
  assert.equal(fill('Created {date}.', { date: '12.08.2026' }), 'Created 12.08.2026.');
  // Опечатка в дырке обязана выглядеть сломанной, а не молча съедать значение.
  assert.equal(fill('Создан {dtae}.', { date: '1' }), 'Создан {dtae}.');
});
