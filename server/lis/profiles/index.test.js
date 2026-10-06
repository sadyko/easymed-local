import test from 'node:test';
import assert from 'node:assert/strict';
import { listProfiles, getProfile, findChannel } from './index.js';

test('все профили одной формы — иначе экран и приём читали бы разное', () => {
  const all = listProfiles();
  assert.ok(all.length >= 4);
  for (const p of all) {
    assert.equal(typeof p.key, 'string');
    assert.ok(p.key.length, 'ключ профиля обязателен: он лежит в lab_devices.profile');
    assert.equal(typeof p.model, 'string');
    assert.equal(typeof p.vendor, 'string');
    assert.ok(Array.isArray(p.transports) && p.transports.length);
    assert.ok(Array.isArray(p.channels));
    for (const c of p.channels) {
      assert.ok(c.code, p.key + ': у канала нет кода');
      assert.ok(c.name, p.key + ': у канала ' + c.code + ' нет имени');
    }
    const codes = p.channels.map((c) => c.code);
    assert.equal(new Set(codes).size, codes.length, p.key + ': повторяющийся код канала');
  }
});

test('ключи уникальны — в lab_devices.profile лежит именно ключ', () => {
  const keys = listProfiles().map((p) => p.key);
  assert.equal(new Set(keys).size, keys.length);
});

test('BC-5300 несёт все 27 каналов со скриншота владельца', () => {
  const p = getProfile('mindray-bc-5300');
  assert.equal(p.channels.length, 27);
  for (const code of ['WBC', 'NEU%', 'NEU#', 'RBC', 'HGB', 'PLT', 'PCT', 'RDW-SD', 'ALY%', 'LIC#']) {
    assert.ok(p.channels.some((c) => c.code === code), 'нет канала ' + code);
  }
});

test('BS-240 и CL-900i несут типовые наборы — заполнены по просьбе владельца 2026-09-11', () => {
  // Раньше были пусты намеренно (набор задаёт закупка реагентов). Владелец
  // попросил заполнить: каждую строку лаборант подтверждает руками, так что
  // длинный список ничего не сопоставляет сам.
  assert.ok(getProfile('mindray-bs-240').channels.length >= 20);
  assert.ok(getProfile('mindray-cl-900i').channels.length >= 20);
  for (const code of ['GLU', 'ALT', 'CREA', 'CRP']) assert.ok(getProfile('mindray-bs-240').channels.some((c) => c.code === code), 'BS-240: нет ' + code);
  for (const code of ['TSH', 'FT4', 'PRL', 'PSA']) assert.ok(getProfile('mindray-cl-900i').channels.some((c) => c.code === code), 'CL-900i: нет ' + code);
});

test('каждый профиль говорит, ОТКУДА его список каналов; «документирован» — только у тех, где документ есть', () => {
  // Mindray протокол сетевых приборов не публикует, зато формат BC-2800 и
  // BC-3000 Plus напечатан в их руководствах целиком (приложения A и D).
  // Честность машинно-читаема: экран предупреждает «набор типовой» у всех,
  // кроме этих двух, — и заявить документ там, где его нет, тест не даст.
  // LIS_REAL_ANALYZERS_V1_PROFILES — 'device': типового списка нет, коды — из
  // того, что прибор присылал (BS-200, A1000); 'siblings': по документам
  // соседних моделей (BC-780).
  const allowed = ['documented', 'screenshot', 'conventional', 'device', 'siblings'];
  const DOCUMENTED = new Set(['mindray-bc-2800', 'mindray-bc-3000-plus']);
  for (const p of listProfiles()) {
    assert.ok(allowed.includes(p.channelsSource), p.key + ': channelsSource=' + p.channelsSource);
    assert.equal(p.channelsSource === 'documented', DOCUMENTED.has(p.key),
      p.key + ': «documented» допустим только там, где руководство с форматом у нас на руках');
  }
});

test('BC-2800 и BC-3000 Plus: коды каналов — буква в букву те, что ставит переадресатор', () => {
  // Один список в двух местах: forwarder/protocols/mindray-legacy.js (OBX-3
  // при преобразовании записи «A») и этот профиль (выпадающий список в
  // панели). Разойдутся — документированный прибор перестанет сопоставляться.
  const fromManual = ['WBC', 'Lymph#', 'Mid#', 'Gran#', 'Lymph%', 'Mid%', 'Gran%', 'RBC', 'HGB', 'MCHC',
    'MCV', 'MCH', 'RDW-CV', 'HCT', 'PLT', 'MPV', 'PDW', 'PCT', 'RDW-SD'];
  for (const key of ['mindray-bc-2800', 'mindray-bc-3000-plus']) {
    assert.deepEqual(getProfile(key).channels.map((c) => c.code), fromManual, key);
  }
});

test('неизвестный ключ — это null, а не исключение: устройство могло остаться от снятого профиля', () => {
  assert.equal(getProfile('нет-такого'), null);
  assert.equal(findChannel('нет-такого', 'WBC'), null);
});

test('канал ищется без учёта регистра — прибор волен писать как хочет', () => {
  assert.equal(findChannel('mindray-bc-5300', 'wbc').code, 'WBC');
  assert.equal(findChannel('mindray-bc-5300', 'rdw-sd').code, 'RDW-SD');
  assert.equal(findChannel('mindray-bc-5300', 'нет'), null);
});

// ── LIS_REAL_ANALYZERS_V1_PROFILES — настоящие анализаторы клиники ──────────
// (docs/specs/2026-10-01-lis-real-analyzers-design.md, раздел 9). Новые поля
// профиля — ДАННЫЕ: aliases (как прибор может назвать себя), wire (провод:
// поля номера пробы, кода и значения — wire.js), oneTestPerMessage (по одному
// тесту в сообщении — серия, match.js), connect (кто звонит), wireSource
// (откуда известен провод).

test('три профиля клиники в списке, у каждого провод из известных', async () => {
  const { WIRES } = await import('../wire.js');
  for (const key of ['mindray-bs-200', 'autobio-autolumo-a1000', 'mindray-bc-780']) {
    assert.ok(getProfile(key), 'нет профиля ' + key);
  }
  assert.equal(getProfile('mindray-bs-200').wire, 'mindray-chem');
  assert.equal(getProfile('autobio-autolumo-a1000').wire, 'autobio-hl7');
  assert.equal(getProfile('mindray-bc-780').wire, 'mindray-hematology');
  for (const p of listProfiles()) {
    assert.ok(WIRES.includes(p.wire || 'default'), p.key + ': провод ' + p.wire);
  }
});

test('прежние профили провода не называют — читаются проводом default, как раньше', () => {
  // LIS_VENDOR_EXACT_V1 — BS-240 и CL-900i ушли на mindray-chem (D2, тест ниже).
  for (const key of ['mindray-bc-20', 'mindray-bc-5300', 'mindray-bc-2800', 'mindray-bc-3000-plus']) {
    const p = getProfile(key);
    assert.equal(p.wire, undefined, key);
    assert.ok(!p.oneTestPerMessage, key + ': серия — только у тех, кто шлёт по тесту');
  }
});

// LIS_VENDOR_EXACT_V1 — D2: BS-240 и CL-900i — химия и ИХЛА Mindray одного
// диалекта (руководство BS-360E/BS-240Pro/BS-240E; Host Interface Manual CL):
// номер пробирки — OBR-2 (штрихкод), OBR-3 — внутренний номер прибора, не
// читается никогда. Прибор звонит сам. По одному сообщению на пробу со всеми
// тестами — серии нет. Номер теста у BS-240 НЕ свой у каждого прибора
// (codesPerInstrument опровергнут при сверке).
test('D2: BS-240 и CL-900i — провод mindray-chem, псевдонимы, прибор звонит сам, формат документирован', async () => {
  const { guessProfile } = await import('../discover.js');
  const bs = getProfile('mindray-bs-240');
  assert.deepEqual([bs.wire, bs.connect, bs.wireSource], ['mindray-chem', 'listen', 'documented']);
  assert.deepEqual(bs.aliases, ['BS-240', 'BS-240E', 'BS-240Pro', 'BS-230']);
  assert.ok(!bs.oneTestPerMessage, 'BS-240 шлёт пробу одним сообщением');
  assert.ok(!bs.codesPerInstrument, 'опровергнуто при сверке');
  const cl = getProfile('mindray-cl-900i');
  assert.deepEqual([cl.wire, cl.connect, cl.wireSource], ['mindray-chem', 'listen', 'documented']);
  assert.ok(cl.aliases.includes('CL-900i') && cl.aliases.includes('CL-920i') && cl.aliases.includes('CL-980i'));
  assert.ok(!cl.oneTestPerMessage, 'CL шлёт пробу одним сообщением');
  assert.ok(!cl.codesPerInstrument);
  // Как прибор может назвать себя — модель узнаётся (раньше «Mindray|BS-240E» — нет).
  for (const [app, facility, key] of [['Mindray', 'BS-240E', 'mindray-bs-240'], ['Mindray', 'BS-240Pro', 'mindray-bs-240'],
    ['Mindray', 'BS-230', 'mindray-bs-240'], ['', 'CL-900', 'mindray-cl-900i'], ['', 'CL-960i', 'mindray-cl-900i']]) {
    const p = guessProfile({ app, facility });
    assert.equal(p && p.key, key, app + '|' + facility);
  }
  // BS-200 по-прежнему BS-200: псевдонимы BS-240 его не перехватывают.
  assert.equal(guessProfile({ app: 'Mindray', facility: 'BS-200E' }).key, 'mindray-bs-200');
});

test('BS-200 и A1000: типового списка нет, коды — от прибора; по одному тесту в сообщении', () => {
  for (const key of ['mindray-bs-200', 'autobio-autolumo-a1000']) {
    const p = getProfile(key);
    assert.deepEqual(p.channels, [], key + ': набор тестов задают реагенты клиники, номер теста — не имя');
    assert.equal(p.channelsSource, 'device', key);
    assert.equal(p.oneTestPerMessage, true, key);
    assert.equal(p.connect, 'listen', key);
    assert.deepEqual(p.transports, ['mllp'], key);
    assert.equal(p.defaultPort, 2575, key);
  }
  const bs = getProfile('mindray-bs-200');
  assert.deepEqual([bs.vendor, bs.model, bs.kind, bs.wireSource], ['Mindray', 'BS-200', 'chemistry', 'documented']);
  assert.deepEqual(bs.aliases, ['BS-200', 'BS-200E']);
  const lumo = getProfile('autobio-autolumo-a1000');
  assert.deepEqual([lumo.vendor, lumo.model, lumo.kind, lumo.wireSource], ['Autobio', 'AutoLumo A1000', 'immunoassay', 'driver']);
  assert.deepEqual(lumo.aliases, ['AutoLumo A1000', 'Autolumo A1000', 'A1000']);
});

test('BC-780: 27 каналов по документам соседних моделей, код канала — имя (компонент 2 OBX-3)', () => {
  const p = getProfile('mindray-bc-780');
  assert.deepEqual([p.vendor, p.model, p.kind, p.wireSource, p.channelsSource, p.connect],
    ['Mindray', 'BC-780', 'hematology', 'siblings', 'siblings', 'unknown']);
  assert.deepEqual(p.aliases, ['BC-780', 'BC-780R']);
  assert.ok(!p.oneTestPerMessage);
  assert.equal(p.channels.length, 27);
  // Тот же набор CBC + 5-diff, что у BC-5300 (снят с экрана Mindray).
  assert.deepEqual(p.channels.map((c) => c.code).sort(), getProfile('mindray-bc-5300').channels.map((c) => c.code).sort());
  assert.equal(findChannel('mindray-bc-780', 'WBC').code, 'WBC');
  assert.equal(findChannel('mindray-bc-780', 'WBC').loinc, '6690-2', 'LOINC — подпись, не код: «6690-2^WBC^LN» ловится по имени');
  assert.equal(findChannel('mindray-bc-780', 'HGB').loinc, '718-7');
  assert.equal(findChannel('mindray-bc-780', 'ALY%').loinc, '', 'у ALY и LIC LOINC нет, как у BC-5300');
});

test('aliasesOf: у профиля без списка псевдоним — сама модель', async () => {
  const { aliasesOf } = await import('./index.js');
  // LIS_VENDOR_EXACT_V1 — пример «без списка» — BC-20: у BC-5300 список теперь есть (тест ниже).
  assert.deepEqual(aliasesOf(getProfile('mindray-bc-20')), ['BC-20']);
  assert.deepEqual(aliasesOf(getProfile('mindray-bs-200')), ['BS-200', 'BS-200E']);
  assert.deepEqual(aliasesOf(null), []);
});

// LIS_VENDOR_EXACT_V1 (ревью; mindray-bc-5300.md M5) — BC-5300 и BC-5380 —
// одно приложение LIS, и MSH-3 называет любую из двух: «BC-5300 or BC-5380»
// (руководство BC-5300/5380, приложение C, табл. 1; издание P08 пишет без
// дефиса — «BC5300», «BC5380»). Раньше «BC-5380|Mindray» не узнавался: строка
// без модели и ответ не гематологии, а вида химии.
test('BC-5300: псевдонимы BC-5300, BC5300, BC-5380, BC5380 — прибор узнаётся по любому', async () => {
  const { guessProfile } = await import('../discover.js');
  assert.deepEqual(getProfile('mindray-bc-5300').aliases, ['BC-5300', 'BC5300', 'BC-5380', 'BC5380']);
  for (const app of ['BC-5300', 'BC5300', 'BC-5380', 'BC5380', 'bc-5380']) {
    assert.equal((guessProfile({ app, facility: 'Mindray' }) || {}).key, 'mindray-bc-5300', app);
  }
  assert.equal((guessProfile({ app: 'Mindray', facility: 'BC-5380' }) || {}).key, 'mindray-bc-5300', 'пример C.2.1 меняет поля местами');
  assert.equal(guessProfile({ app: 'BC-5390', facility: 'Mindray' }), null, 'BC-5390 (DMU) — другая модель, по имени не угадывается');
});

// LIS_REAL_ANALYZERS_V1 — ревью R2, п. 1: у BS-200 номер теста задаёт клиника
// на каждом приборе (ItemID.ini) — «2» у двух BS-200 бывает разным тестом.
// Подмены «та же модель» у такого профиля нет. У A1000 код позиции — код
// производителя (206 = витамин B12; одна панель через COM и по сети).
test('R2 п. 1: codesPerInstrument — только у BS-200', () => {
  assert.deepEqual(listProfiles().filter((p) => p.codesPerInstrument).map((p) => p.key), ['mindray-bs-200']);
});
