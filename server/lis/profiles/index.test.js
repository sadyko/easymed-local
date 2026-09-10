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

test('у BS-240 и CL-900i каналы пусты намеренно — набор задаёт клиника', () => {
  assert.equal(getProfile('mindray-bs-240').channels.length, 0);
  assert.equal(getProfile('mindray-cl-900i').channels.length, 0);
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
