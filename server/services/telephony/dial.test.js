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
import { dialableNumber, dialProvider, dialCall, candidateExtensions } from './dial.js';
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
    assert.match(r.message, /Линия для звонков не выбрана/);
  } finally { db.close(); }
});

test('номера нет ни у оператора, ни у линии — отказ называет ОБА места', async () => {
  const db = seed({ binotel: true });
  try {
    const r = await dialCall(db, { extension: '', phone: '+998901234567' });
    assert.equal(r.reason, 'no_extension');
    assert.match(r.message, /карточке сотрудника/);
    assert.match(r.message, /линии в настройках/);
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
    // AUTO_EXTENSION_V1 — ответ несёт ещё и `from`: оператор должен знать, какая
    // трубка сейчас зазвонит, особенно когда номер выбрала программа.
    assert.deepEqual(r, { ok: true, provider: 'binotel', call_id: '77', from: '910' });
    // На станцию уходят ЦИФРЫ: плюс — способ записать номер, а не набрать его.
    assert.deepEqual(seen, [['910', '998901234567']]);
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
    assert.deepEqual(seen, [['clinic.moizvonki.ru', '998901234567', 'a@b.uz', 'z']]);
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
      (e) => e.status === 400 && /с которого звонить/.test(e.message));
  } finally { db.close(); }
});


// --- ВЫБОР ЛИНИИ (DIAL_LINE_V1) ---------------------------------------------
//
// Ровно та ошибка, на которую владелец и указал: «why i cant call from pbx in
// the system?». Обе линии включены, но Binotel не работает месяц, а onlinePBX
// принимает сотни звонков в сутки — и звонок уходил в мёртвую.

function seedTwoLines(db, { binotelLast, pbxLast }) {
  db.prepare("UPDATE telephony_settings SET enabled = 1, api_key = 'k', api_secret = 's', last_call_at = ? WHERE id = 1").run(binotelLast);
  db.prepare(`INSERT INTO telephony_providers (kind, vendor, name, enabled, config, secret, last_call_at)
              VALUES ('onlinepbx', 'onlinepbx', 'onlinePBX', 1, '{"domain":"clinic.onpbx.ru"}', '{"auth_key":"a","key_id":"i","key":"k"}', ?)`).run(pbxLast);
}

test('включены обе линии — звонок идёт по ЖИВОЙ, а не по «главной»', () => {
  const db = openDb(':memory:'); migrate(db);
  try {
    seedTwoLines(db, { binotelLast: '2026-09-07T07:50:40Z', pbxLast: '2026-09-17T11:54:58Z' });
    assert.equal(dialProvider(db).kind, 'onlinepbx',
      'звонок снова уходит на линию, которой клиника не пользуется');
  } finally { db.close(); }
});

test('и наоборот: где живой Binotel, звонит он', () => {
  const db = openDb(':memory:'); migrate(db);
  try {
    seedTwoLines(db, { binotelLast: '2026-09-17T12:00:00Z', pbxLast: '2026-09-01T09:00:00Z' });
    assert.equal(dialProvider(db).kind, 'binotel');
  } finally { db.close(); }
});

test('выбор клиники сильнее любой догадки', () => {
  const db = openDb(':memory:'); migrate(db);
  try {
    seedTwoLines(db, { binotelLast: '2026-09-07T07:50:40Z', pbxLast: '2026-09-17T11:54:58Z' });
    db.prepare("UPDATE telephony_settings SET dial_provider = 'binotel' WHERE id = 1").run();
    assert.equal(dialProvider(db).kind, 'binotel', 'выбранную линию подменили свежей');
  } finally { db.close(); }
});

test('выбранная линия выключена — молча подменять другой НЕЛЬЗЯ', async () => {
  const db = openDb(':memory:'); migrate(db);
  try {
    seedTwoLines(db, { binotelLast: '2026-09-07T07:50:40Z', pbxLast: '2026-09-17T11:54:58Z' });
    db.prepare("UPDATE telephony_settings SET dial_provider = 'pbx:999' WHERE id = 1").run();
    assert.equal(dialProvider(db), null);
    const r = await dialCall(db, { extension: '101', phone: '+998901234567' });
    assert.equal(r.reason, 'no_provider', 'звонок ушёл не с той линии, которую выбрала клиника');
  } finally { db.close(); }
});

test('ОДИН НОМЕР НА КЛИНИКУ: у оператора добавочного нет — звоним номером линии', async () => {
  const db = openDb(':memory:'); migrate(db);
  try {
    db.prepare(`INSERT INTO telephony_providers (kind, vendor, name, enabled, config, secret)
                VALUES ('onlinepbx', 'onlinepbx', 'onlinePBX', 1,
                        '{"domain":"clinic.onpbx.ru","default_extension":"100"}',
                        '{"auth_key":"a","key_id":"i","key":"k"}')`).run();
    const seen = [];
    const r = await dialCall(db, { extension: '', phone: '+998901234567' }, {
      pbxCallNowImpl: async (domain, from, to) => { seen.push(from); return { ok: true, data: { data: 'u1' } }; },
    });
    assert.equal(r.ok, true, 'клинике с одним номером запретили звонить');
    assert.deepEqual(seen, ['100'], 'звонок ушёл не с номера линии');
  } finally { db.close(); }
});

test('свой добавочный ГЛАВНЕЕ номера линии — иначе в журнале не видно, кто звонил', async () => {
  const db = openDb(':memory:'); migrate(db);
  try {
    db.prepare(`INSERT INTO telephony_providers (kind, vendor, name, enabled, config, secret)
                VALUES ('onlinepbx', 'onlinepbx', 'onlinePBX', 1,
                        '{"domain":"clinic.onpbx.ru","default_extension":"100"}',
                        '{"auth_key":"a","key_id":"i","key":"k"}')`).run();
    const seen = [];
    await dialCall(db, { extension: '102', phone: '+998901234567' }, {
      pbxCallNowImpl: async (domain, from) => { seen.push(from); return { ok: true, data: { data: 'u1' } }; },
    });
    assert.deepEqual(seen, ['102']);
  } finally { db.close(); }
});

// --- ОТКАЗ СТАНЦИИ ДОЛЖЕН ДОХОДИТЬ ДО ЧЕЛОВЕКА ------------------------------
//
// Владелец видел на экране «RPC failed» и справедливо спрашивал, что не так.
// Станция в тот момент отвечала вполне внятно: «There is no registered user and
// no push token» — на внутреннем номере не было подключённого телефона.

test('«нет зарегистрированного телефона» объясняется по-русски и с подсказкой', async () => {
  const db = seed({ binotel: true });
  try {
    const r = await dialCall(db, { extension: '108', phone: '+998901234567' }, {
      binotelDialImpl: async () => ({ ok: false, reason: 'server_error', comment: 'There is no registered user and no push token' }),
    });
    assert.equal(r.ok, false);
    assert.match(r.message, /нет подключённого телефона/);
    assert.match(r.message, /другой внутренний номер/, 'сказано, что делать дальше');
    assert.equal(/RPC failed|push token/i.test(r.message), false, 'человеку показали английский текст вендора');
  } finally { db.close(); }
});

test('незнакомый ответ станции: СНАЧАЛА по-русски, чужой текст в скобках', async () => {
  const db = seed({ binotel: true });
  try {
    const r = await dialCall(db, { extension: '108', phone: '+998901234567' }, {
      binotelDialImpl: async () => ({ ok: false, reason: 'server_error', comment: 'Quota exceeded for today' }),
    });
    // Оператор читает русскую фразу, а английский остаётся для разбора.
    assert.match(r.message, /^Телефония ответила ошибкой/);
    assert.match(r.message, /\(станция: Quota exceeded for today\)/);
  } finally { db.close(); }
});

test('«Wrong api key» — это НЕ «ошибка телефонии», а «ключ не подошёл»', async () => {
  const db = seed({ binotel: true });
  try {
    // Живой ответ Binotel на снимке владельца: ключ линии давно недействителен.
    const r = await dialCall(db, { extension: '108', phone: '+998901234567' }, {
      binotelDialImpl: async () => ({ ok: false, reason: 'bad_credentials', comment: 'Wrong api key' }),
    });
    assert.match(r.message, /ключ доступа/, 'по-русски сказано, в чём дело');
    assert.match(r.message, /Wrong api key/, 'ответ станции сохранён для разбора');
  } finally { db.close(); }
});

test('отказ телефонии — это 400, а не 500: иначе экран покажет «RPC failed»', async () => {
  const db = seed({ binotel: true });
  try {
    addUser(db, { id: 1, role: 'callcenter', ext: '108' });
    await assert.rejects(
      () => telephonyDial(db, { phone: '+998901234567' }, user('callcenter', 1), {
        binotelDialImpl: async () => ({ ok: false, reason: 'offline' }),
      }),
      (e) => e.status === 400, 'маршрут RPC спрячет всё, что 500 и выше, за общей фразой');
  } finally { db.close(); }
});

// --- AUTO_EXTENSION_V1: программа сама находит живую трубку -------------------
//
// Владелец: «я не знаю какой включен, прошу сделай так чтобы пользователь только
// настроил авторизацию и это сработало».

function seedJournal(db, rows) {
  const ins = db.prepare(`INSERT INTO calls (general_call_id, started_at, call_type, external_number,
      internal_number, billsec, disposition, source) VALUES (?,?,?,?,?,?,?,'poll')`);
  rows.forEach(([ext, minutesAgo, talk], i) => {
    const t = new Date(Date.now() - minutesAgo * 60000).toISOString().slice(0, 19) + 'Z';
    ins.run('j' + i, t, 0, '+998901111111', ext, talk, talk ? 'ANSWER' : 'NOANSWER');
  });
}

test('никто не назвал номер — берём трубку, которая недавно РАЗГОВАРИВАЛА', async () => {
  const db = seed({ pbx: true });
  try {
    // 102 отвечал позже всех, 101 раньше, 900 вообще не разговаривал.
    seedJournal(db, [['101', 300, 60], ['102', 30, 45], ['900', 10, 0]]);
    assert.deepEqual(candidateExtensions(db), ['102', '101'], 'кандидаты не те или не в том порядке');
    const seen = [];
    const r = await dialCall(db, { extension: '', phone: '901234567' }, {
      pbxCallNowImpl: async (d, from) => { seen.push(from); return { ok: true, data: { data: 'u' } }; },
    });
    assert.equal(r.ok, true, 'клинике без настроенного добавочного снова запретили звонить');
    assert.deepEqual(seen, ['102']);
    assert.equal(r.from, '102', 'оператору не сказали, какая трубка зазвонит');
  } finally { db.close(); }
});

test('трубка не в сети — программа пробует следующую, а не сдаётся', async () => {
  const db = seed({ pbx: true });
  try {
    seedJournal(db, [['101', 300, 60], ['102', 30, 45]]);
    const seen = [];
    const r = await dialCall(db, { extension: '', phone: '901234567' }, {
      pbxCallNowImpl: async (d, from) => {
        seen.push(from);
        // Ровно тот ответ, который видела клиника.
        if (from === '102') return { ok: false, reason: 'server_error', comment: 'There is no registered user and no push token' };
        return { ok: true, data: { data: 'u' } };
      },
    });
    assert.deepEqual(seen, ['102', '101'], 'перебор не дошёл до второй трубки');
    assert.equal(r.ok, true);
    assert.equal(r.from, '101');
  } finally { db.close(); }
});

test('ПЕРЕБИРАЕМ НЕ ВСЕГДА: неверный ключ повторять восемь раз нельзя', async () => {
  const db = seed({ pbx: true });
  try {
    seedJournal(db, [['101', 300, 60], ['102', 30, 45], ['103', 20, 30]]);
    let calls = 0;
    const r = await dialCall(db, { extension: '', phone: '901234567' }, {
      pbxCallNowImpl: async () => { calls += 1; return { ok: false, reason: 'bad_credentials', comment: 'Wrong api key' }; },
    });
    assert.equal(calls, 1, 'в дверь вендора постучались несколько раз без шанса на успех');
    assert.equal(r.ok, false);
    assert.match(r.message, /ключ доступа/);
  } finally { db.close(); }
});

test('настроенный номер главнее догадки — его пробуют первым', async () => {
  const db = seed({ pbx: true });
  try {
    seedJournal(db, [['102', 30, 45]]);
    const seen = [];
    await dialCall(db, { extension: '777', phone: '901234567' }, {
      pbxCallNowImpl: async (d, from) => { seen.push(from); return { ok: true, data: { data: 'u' } }; },
    });
    assert.deepEqual(seen, ['777'], 'свой добавочный оператора отодвинули догадкой');
  } finally { db.close(); }
});
