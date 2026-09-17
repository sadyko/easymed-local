// CALL_FROM_CRM_V1 — «Позвонить»: один разъём на три телефонии.
//
// Что здесь проверяется и почему именно это:
//   • номер пациента доводится до вида, который принимает станция (в базе он
//     лежит так, как его набрала регистратура);
//   • внутренний номер ОПЕРАТОРА берётся из сессии, а не из запроса — иначе
//     разбор по операторам можно подделать одним полем в браузере;
//   • отказ — слово из словаря и фраза для человека, а не исключение;
//   • звонить вправе регистратура и колл-центр, а настройки телефонии
//     по-прежнему видит только администратор.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { dialableNumber, dialProvider, dialCall } from './dial.js';
import { telephonyDial } from '../rpc/telephony.js';

function seed({ binotel = false, pbx = false, mz = false } = {}) {
  const db = openDb(':memory:');
  migrate(db);
  if (binotel) {
    db.prepare(`UPDATE telephony_settings SET enabled = 1, api_key = 'k', api_secret = 's' WHERE id = 1`).run();
  } else {
    db.prepare(`UPDATE telephony_settings SET enabled = 0 WHERE id = 1`).run();
  }
  if (pbx) {
    db.prepare(`INSERT INTO telephony_providers (kind, name, enabled, config, secret)
                VALUES ('onlinepbx', 'onlinePBX', 1, '{"domain":"clinic.onpbx.ru"}', '{"auth_key":"a","key_id":"i","key":"k"}')`).run();
  }
  if (mz) {
    // kind — легенда ради старого CHECK, настоящий вид в vendor (миграция 135).
    db.prepare(`INSERT INTO telephony_providers (kind, vendor, name, enabled, config, secret)
                VALUES ('onlinepbx', 'moizvonki', 'Мои Звонки', 1, '{"domain":"clinic.moizvonki.ru","user_name":"a@b.uz"}', '{"api_key":"z"}')`).run();
  }
  return db;
}

const user = (role, id = 1) => ({ id, role, extra_roles: [] });

function addUser(db, { id, role, ext }) {
  db.prepare('INSERT INTO users (id, username, password_hash, full_name, role, pbx_extension) VALUES (?,?,?,?,?,?)')
    .run(id, 'u' + id, 'x', 'Оператор ' + id, role, ext);
}

test('номер пациента доводится до набираемого вида', () => {
  assert.equal(dialableNumber('+998 90 123-45-67'), '+998901234567');
  assert.equal(dialableNumber('(90) 123 45 67'), '901234567');
  assert.equal(dialableNumber(''), '');
  assert.equal(dialableNumber(null), '');
});

test('без подключённой телефонии звонок отказывает СЛОВАМИ, а не падает', async () => {
  const db = seed();
  try {
    const r = await dialCall(db, { extension: '101', phone: '+998901234567' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no_provider');
    assert.match(r.message, /Телефония не подключена/);
  } finally { db.close(); }
});

test('без внутреннего номера станция звонить не может — и так и сказано', async () => {
  const db = seed({ binotel: true });
  try {
    const r = await dialCall(db, { extension: '', phone: '+998901234567' });
    assert.equal(r.reason, 'no_extension');
    assert.match(r.message, /внутренний номер/);
  } finally { db.close(); }
});

test('обрывок вместо телефона не уходит на станцию', async () => {
  const db = seed({ binotel: true });
  try {
    for (const bad of ['', '101', '12345', null]) {
      const r = await dialCall(db, { extension: '101', phone: bad });
      assert.equal(r.reason, 'no_phone', 'на станцию ушёл негодный номер: ' + bad);
    }
  } finally { db.close(); }
});

test('Binotel: звонок уходит внутренним номером оператора и внешним номером пациента', async () => {
  const db = seed({ binotel: true });
  try {
    const seen = [];
    const r = await dialCall(db, { extension: '910', phone: '+998 90 123-45-67' }, {
      binotelDialImpl: async (internal, external) => { seen.push([internal, external]); return { ok: true, call_id: '77' }; },
    });
    assert.deepEqual(r, { ok: true, provider: 'binotel', call_id: '77' });
    assert.deepEqual(seen, [['910', '+998901234567']]);
  } finally { db.close(); }
});

test('onlinePBX берётся, когда Binotel выключён; звонок уходит тем же порядком', async () => {
  const db = seed({ pbx: true });
  try {
    assert.equal(dialProvider(db).kind, 'onlinepbx');
    const seen = [];
    const r = await dialCall(db, { extension: '101', phone: '901234567' }, {
      pbxCallNowImpl: async (domain, from, to) => { seen.push([domain, from, to]); return { ok: true, data: { data: 'uuid-1' } }; },
    });
    assert.equal(r.ok, true);
    assert.equal(r.provider, 'onlinepbx');
    assert.deepEqual(seen, [['clinic.onpbx.ru', '101', '901234567']]);
  } finally { db.close(); }
});

test('включены обе — звонит главная линия клиники (Binotel), и это объяснимо вслух', () => {
  const db = seed({ binotel: true, pbx: true });
  try {
    assert.equal(dialProvider(db).kind, 'binotel');
  } finally { db.close(); }
});

test('«Мои Звонки»: внутренний номер не нужен — там звонит смартфон сотрудника', async () => {
  const db = seed({ mz: true });
  try {
    assert.equal(dialProvider(db).kind, 'moizvonki');
    const seen = [];
    const r = await dialCall(db, { extension: '', phone: '+998901234567' }, {
      mzDialImpl: async (domain, to, o) => { seen.push([domain, to, o.userName, o.apiKey]); return { ok: true, call_id: '5' }; },
    });
    assert.equal(r.ok, true, 'оператору без добавочного запретили звонить там, где добавочных не бывает');
    assert.equal(r.provider, 'moizvonki');
    assert.deepEqual(seen, [['clinic.moizvonki.ru', '+998901234567', 'a@b.uz', 'z']]);
  } finally { db.close(); }
});

test('отказ телефонии переводится в человеческую фразу, а не в код', async () => {
  const db = seed({ binotel: true });
  try {
    for (const [reason, re] of [['offline', /Нет связи/], ['bad_credentials', /ключ доступа/], ['server_error', /ошибкой/]]) {
      const r = await dialCall(db, { extension: '910', phone: '+998901234567' }, {
        binotelDialImpl: async () => ({ ok: false, reason }),
      });
      assert.equal(r.reason, reason);
      assert.match(r.message, re);
    }
  } finally { db.close(); }
});

// --- права ------------------------------------------------------------------

test('звонить могут регистратура, колл-центр и администратор — и никто больше', async () => {
  const db = seed({ binotel: true });
  try {
    addUser(db, { id: 1, role: 'registrar', ext: '101' });
    addUser(db, { id: 2, role: 'callcenter', ext: '102' });
    addUser(db, { id: 3, role: 'admin', ext: '100' });
    addUser(db, { id: 4, role: 'doctor', ext: '201' });
    addUser(db, { id: 5, role: 'lab', ext: '202' });
    const seam = { binotelDialImpl: async () => ({ ok: true, call_id: '1' }) };

    for (const [id, role] of [[1, 'registrar'], [2, 'callcenter'], [3, 'admin']]) {
      const r = await telephonyDial(db, { phone: '+998901234567' }, user(role, id), seam);
      assert.equal(r.ok, true, role + ' не смог позвонить');
    }
    for (const [id, role] of [[4, 'doctor'], [5, 'lab']]) {
      await assert.rejects(
        () => telephonyDial(db, { phone: '+998901234567' }, user(role, id), seam),
        (e) => e.status === 403, role + ' смог позвонить, хотя права ему не давали');
    }
  } finally { db.close(); }
});

test('внутренний номер берётся ИЗ СЕССИИ: чужой номер из запроса не подставляется', async () => {
  const db = seed({ binotel: true });
  try {
    addUser(db, { id: 1, role: 'callcenter', ext: '102' });
    const seen = [];
    await telephonyDial(db, { phone: '+998901234567', extension: '999', internalNumber: '999' }, user('callcenter', 1), {
      binotelDialImpl: async (internal) => { seen.push(internal); return { ok: true, call_id: '1' }; },
    });
    assert.deepEqual(seen, ['102'], 'номер подставился из запроса — разбор по операторам можно подделать');
  } finally { db.close(); }
});

test('у оператора без внутреннего номера отказ понятный, а не «ошибка сервера»', async () => {
  const db = seed({ binotel: true });
  try {
    addUser(db, { id: 1, role: 'callcenter', ext: null });
    await assert.rejects(
      () => telephonyDial(db, { phone: '+998901234567' }, user('callcenter', 1), {}),
      (e) => e.status === 400 && /внутренний номер/.test(e.message));
  } finally { db.close(); }
});
