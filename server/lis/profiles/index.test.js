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
  const allowed = ['documented', 'screenshot', 'conventional'];
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
