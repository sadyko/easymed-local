// CALL_RECORDING_V1 — запись разговора: находится у любой из трёх телефоний,
// в карточку попадает вместе с именем оператора, и лишнего с ней не уезжает.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { recordingUrlOf } from './recording.js';
import { crmLeadCalls } from '../rpc/telephony.js';

test('ссылка на запись находится, как бы вендор её ни назвал', () => {
  assert.equal(recordingUrlOf({ recording: 'https://a.uz/1.mp3' }), 'https://a.uz/1.mp3');        // Мои Звонки
  assert.equal(recordingUrlOf({ recordingLink: 'https://b.uz/2.mp3' }), 'https://b.uz/2.mp3');    // Binotel
  assert.equal(recordingUrlOf({ record_url: 'http://c.uz/3.wav' }), 'http://c.uz/3.wav');         // onlinePBX
  // Вложенность встречается у обоих: запись лежит в событии звонка.
  assert.equal(recordingUrlOf({ events: [{ type: 'user' }, { audio_file: 'https://d.uz/4.mp3' }] }), 'https://d.uz/4.mp3');
});

test('в плеер не попадёт то, что записью не является', () => {
  // Пусто — нормальное состояние: не ответили или запись не включена.
  assert.equal(recordingUrlOf({}), '');
  assert.equal(recordingUrlOf(null), '');
  assert.equal(recordingUrlOf({ recording: '' }), '');
  // Не адрес, а текст вендора.
  assert.equal(recordingUrlOf({ recording: 'нет записи' }), '');
  assert.equal(recordingUrlOf({ record: 'true' }), '');
  // Общий «url» НЕ берётся: у вендоров это адрес карточки звонка в кабинете, а
  // не звук — плеер по нему молчал бы.
  assert.equal(recordingUrlOf({ url: 'https://pbx.uz/calls/17' }), '');
  // И ничего, что не http(s): javascript: в src плеера — это уже не «молчит».
  assert.equal(recordingUrlOf({ recording: 'javascript:alert(1)' }), '');
});

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare('INSERT INTO users (id, username, password_hash, full_name, role, pbx_extension) VALUES (?,?,?,?,?,?)')
    .run(21, 'nasiba', 'x', 'Насиба Алиева', 'callcenter', '102');
  const ins = db.prepare(`INSERT INTO calls (general_call_id, started_at, call_type, external_number,
      internal_number, billsec, disposition, source, recording_url)
      VALUES (?,?,?,?,?,?,?,?,?)`);
  ins.run('c1', '2026-09-17T09:00:00Z', 1, '+998 90 123-45-67', '102', 95, 'ANSWER', 'poll', 'https://pbx.uz/rec/c1.mp3');
  ins.run('c2', '2026-09-17T10:00:00Z', 0, '998901234567',      '102', 0,  'NOANSWER', 'poll', null);
  ins.run('c3', '2026-09-17T11:00:00Z', 1, '+998 99 000-00-00', '103', 30, 'ANSWER', 'poll', 'https://pbx.uz/rec/c3.mp3');
  return db;
}

const OPERATOR = { id: 21, role: 'callcenter', extra_roles: [] };

test('в карточку приезжают звонки ЭТОГО номера, как бы он ни был записан', () => {
  const db = seed();
  try {
    const rows = crmLeadCalls(db, { phone: '+998 90 123 45 67' }, OPERATOR);
    assert.deepEqual(rows.map((r) => r.id).sort(), [1, 2],
      'звонки того же номера в другой записи потерялись, или приехал чужой');
    assert.equal(rows[0].started_at > rows[1].started_at, true, 'порядок не от свежего к старому');
  } finally { db.close(); }
});

test('у звонка видно, КТО говорил, и слышно запись', () => {
  const db = seed();
  try {
    const [newest, older] = crmLeadCalls(db, { phone: '901234567' }, OPERATOR);
    assert.equal(newest.operator_name, 'Насиба Алиева', 'оператор не опознан по внутреннему номеру');
    assert.equal(older.recording_url, 'https://pbx.uz/rec/c1.mp3');
    assert.equal(newest.recording_url, null, 'у неотвеченного звонка записи быть не должно');
  } finally { db.close(); }
});

test('наружу не выходит сырой ответ вендора', () => {
  const db = seed();
  try {
    const [row] = crmLeadCalls(db, { phone: '901234567' }, OPERATOR);
    assert.equal('raw' in row, false, 'сырой ответ телефонии уехал в браузер');
  } finally { db.close(); }
});

test('журнал звонков закрыт для тех, кому CRM не положена', () => {
  const db = seed();
  try {
    assert.deepEqual(crmLeadCalls(db, { phone: '901234567' }, { id: 9, role: 'lab', extra_roles: [] }), undefined);
  } catch (e) {
    assert.equal(e.status, 403);
  } finally { db.close(); }
});

test('обрывок номера не превращается в запрос «покажи все звонки»', () => {
  const db = seed();
  try {
    assert.deepEqual(crmLeadCalls(db, { phone: '123' }, OPERATOR), []);
    assert.deepEqual(crmLeadCalls(db, { phone: '' }, OPERATOR), []);
  } finally { db.close(); }
});

// --- ПОЧЕМУ ЗАПИСЕЙ НЕ БЫЛО ВОВСЕ -------------------------------------------
//
// Владелец: «we dont have any audios uploaded to the system. we cannot play the
// records». В сохранённых ответах станции не было НИ ОДНОГО поля, похожего на
// запись, — и правильно: onlinePBX прикладывает ссылку только по флагу
// download. Без него мы честно спрашивали историю без записей.

test('историю у станции спрашиваем СО ССЫЛКОЙ на запись', async () => {
  const { pbxHistory } = await import('./onlinepbx.js');
  const seen = [];
  await pbxHistory('clinic.onpbx.ru', 1758000000, {
    creds: { key_id: 'i', key: 'k' },
    fetchImpl: async (url, opts) => {
      seen.push(String(opts && opts.body));
      return { ok: true, status: 200, json: async () => ({}), text: async () => '{"status":"1","data":[]}',
               body: null, headers: { get: () => null } };
    },
  });
  assert.equal(seen.length, 1);
  assert.match(seen[0], /download=1/, 'без этого флага станция записей не отдаёт — и не отдавала');
});

test('ссылка, узнанная ПОЗЖЕ, дописывается к уже сохранённому звонку', async () => {
  const { recordCall } = await import('./poller.js');
  const db = openDb(':memory:');
  migrate(db);
  try {
    const call = (rec) => ({
      general_call_id: 'onlinepbx:u1', started_at: '2026-09-17T09:00:00Z', call_type: 1,
      external_number: '+998901234567', internal_number: '101', billsec: 60,
      disposition: 'ANSWER', raw: rec ? { uuid: 'u1', record_url: rec } : { uuid: 'u1' },
    });
    // Первый опрос: станция ещё дописывает файл, ссылки нет.
    recordCall(db, call(null), 'poll');
    assert.equal(db.prepare('SELECT recording_url FROM calls').get().recording_url, null);
    // Второй опрос той же минуты: ссылка появилась. Строка уже есть, вставка
    // молчит — и без дописки запись потерялась бы навсегда.
    recordCall(db, call('https://pbx.uz/rec/u1.mp3'), 'poll');
    assert.equal(db.prepare('SELECT recording_url FROM calls').get().recording_url, 'https://pbx.uz/rec/u1.mp3');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM calls').get().n, 1, 'звонок раздвоился');
    // Уже стоящую ссылку не перетираем.
    recordCall(db, call('https://pbx.uz/OTHER.mp3'), 'poll');
    assert.equal(db.prepare('SELECT recording_url FROM calls').get().recording_url, 'https://pbx.uz/rec/u1.mp3');
  } finally { db.close(); }
});
