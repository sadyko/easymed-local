// TELEGRAM_BOT_V1 — что именно уходит пациенту автоматически.
//
// Проверяются правила отбора, а не сама отправка: отправка требует Chrome и
// сети, и её честнее гонять на живой базе, чем имитировать.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { pendingDocuments, runPushScan, LOOKBACK_DAYS } from './push.js';

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  const p = db.prepare("INSERT INTO patients (full_name, phone) VALUES ('Алиев А.','+998 90 111 22 33')").run().lastInsertRowid;
  const v = db.prepare("INSERT INTO visits (patient_id, visit_date) VALUES (?, date('now'))").run(p).lastInsertRowid;
  const s = db.prepare("INSERT INTO services (name, price) VALUES ('Общий анализ крови', 60000)").run().lastInsertRowid;
  const vs = db.prepare('INSERT INTO visit_services (visit_id, service_id) VALUES (?,?)').run(v, s).lastInsertRowid;
  return { db, p, v, s, vs };
}

const ALL = ['lab', 'conclusion', 'diag'];

test('неподтверждённый анализ не рассылается', () => {
  const { db, vs } = seed();
  // Введён лаборантом, но НЕ подтверждён: пациенту такого показывать нельзя.
  db.prepare("INSERT INTO lab_results (visit_service_id, value, parameter) VALUES (?,'11','WBC')").run(vs);
  assert.deepEqual(pendingDocuments(db, ALL), []);
  db.close();
});

test('подтверждённый анализ попадает в рассылку один раз на услугу', () => {
  const { db, vs, p } = seed();
  const ins = db.prepare(
    "INSERT INTO lab_results (visit_service_id, value, parameter, verified_at) VALUES (?,?,?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))");
  ins.run(vs, '11', 'WBC');
  ins.run(vs, '4.2', 'RBC');   // вторая строка того же анализа

  const out = pendingDocuments(db, ALL);
  assert.equal(out.length, 1, 'бланк один, сколько бы показателей в нём ни было');
  assert.equal(out[0].kind, 'lab');
  assert.equal(out[0].ref, 'lab:' + vs);
  assert.equal(out[0].patientId, p);
  db.close();
});

test('подписанное заключение рассылается, черновик без body — нет', () => {
  const { db, p, v } = seed();
  db.prepare("INSERT INTO visit_documents (patient_id, visit_id, doc_type, title, body) VALUES (?,?,'protocol','Протокол','{\"dx\":\"ОРВИ\"}')").run(p, v);
  db.prepare("INSERT INTO visit_documents (patient_id, visit_id, doc_type, title, body) VALUES (?,?,'protocol','Пустой','')").run(p, v);

  const out = pendingDocuments(db, ALL);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'conclusion');
  db.close();
});

test('счета не рассылаются автоматически никогда', () => {
  const { db, p } = seed();
  db.prepare("INSERT INTO invoices (patient_id, total_amount, status) VALUES (?, 100000, 'unpaid')").run(p);
  // Даже если администратор разрешил счета в настройках выдачи — это про то,
  // что пациент может ЗАБРАТЬ счёт сам, а не про рассылку на телефон.
  assert.deepEqual(pendingDocuments(db, ['lab', 'conclusion', 'diag', 'invoice', 'file']).filter((d) => d.kind === 'invoice'), []);
  db.close();
});

test('выключенный вид документа не рассылается', () => {
  const { db, p, v, vs } = seed();
  db.prepare("INSERT INTO lab_results (visit_service_id, value, parameter, verified_at) VALUES (?,'11','WBC', strftime('%Y-%m-%dT%H:%M:%SZ','now'))").run(vs);
  db.prepare("INSERT INTO visit_documents (patient_id, visit_id, doc_type, title, body) VALUES (?,?,'diag','УЗИ','{\"conclusion\":\"норма\"}')").run(p, v);

  assert.deepEqual(pendingDocuments(db, ['lab']).map((d) => d.kind), ['lab']);
  assert.deepEqual(pendingDocuments(db, ['diag']).map((d) => d.kind), ['diag']);
  assert.deepEqual(pendingDocuments(db, []), []);
  db.close();
});

test('старые документы не досылаются', () => {
  const { db, vs } = seed();
  // Бот, включённый через месяц после установки, не должен обрушить на
  // пациента весь архив: он присылает только то, что созрело недавно.
  db.prepare(
    `INSERT INTO lab_results (visit_service_id, value, parameter, verified_at)
     VALUES (?,'11','WBC', strftime('%Y-%m-%dT%H:%M:%SZ','now','-${LOOKBACK_DAYS + 1} days'))`).run(vs);
  assert.deepEqual(pendingDocuments(db, ALL), []);
  db.close();
});

test('повторная отправка в тот же чат невозможна, а после отзыва счётчик попыток растёт', () => {
  const { db, p } = seed();
  const ins = db.prepare(
    `INSERT INTO telegram_deliveries (chat_id, patient_id, doc_kind, doc_ref, trigger, status, attempts)
     VALUES (?,?,?,?, 'push', 'pending', 1)
     ON CONFLICT(chat_id, doc_kind, doc_ref) WHERE trigger = 'push'
     DO UPDATE SET attempts = attempts + 1, status = 'pending', error = ''
     RETURNING id`);
  const first = ins.get('55', p, 'lab', 'lab:1').id;
  const second = ins.get('55', p, 'lab', 'lab:1').id;
  assert.equal(first, second, 'повтор обновляет ту же строку, а не создаёт вторую');
  assert.equal(db.prepare('SELECT attempts FROM telegram_deliveries WHERE id=?').get(first).attempts, 2);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM telegram_deliveries WHERE trigger='push'").get().c, 1);
  db.close();
});

// PUSH_SCAN_PERF_V1 — проход не должен блокировать сервер.
test('связки разбираются один раз на проход, а не на каждый документ', async () => {
  const { db } = (() => {
    const d = openDb(':memory:');
    migrate(d);
    d.prepare("UPDATE telegram_settings SET push_enabled=1, doc_kinds='lab,conclusion,diag' WHERE id=1").run();
    return { db: d };
  })();

  // 40 пациентов на разных номерах, у каждого — готовый анализ и свой чат.
  const svc = db.prepare("INSERT INTO services (name, price) VALUES ('ОАК', 1)").run().lastInsertRowid;
  for (let i = 0; i < 40; i++) {
    const phone = '+998 90 000 00 ' + String(i).padStart(2, '0');
    const p = db.prepare('INSERT INTO patients (full_name, phone) VALUES (?,?)').run('П' + i, phone).lastInsertRowid;
    const v = db.prepare("INSERT INTO visits (patient_id, visit_date) VALUES (?, date('now'))").run(p).lastInsertRowid;
    const vs = db.prepare('INSERT INTO visit_services (visit_id, service_id) VALUES (?,?)').run(v, svc).lastInsertRowid;
    db.prepare(`INSERT INTO lab_results (visit_service_id, parameter, value, verified_at)
                VALUES (?,?,?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))`).run(vs, 'HGB', '140');
    db.prepare('INSERT INTO telegram_links (chat_id, phone) VALUES (?,?)').run(String(1000 + i), phone.replace(/\D/g, ''));
    // Всё уже отправлено — именно этот случай раньше не доходил до await и
    // выполнялся одним синхронным куском.
    db.prepare(`INSERT INTO telegram_deliveries (chat_id, doc_kind, doc_ref, trigger, status)
                VALUES (?, 'lab', ?, 'push', 'sent')`).run(String(1000 + i), 'lab:' + vs);
  }

  // Событийный цикл обязан продолжать работать ВО ВРЕМЯ прохода: без этого
  // сервер не отвечает на запросы, и сохранение анализов «подвисает».
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 5);
  const res = await runPushScan(db, 'tok', { fetchImpl: async () => { throw new Error('сеть не нужна'); } });
  clearInterval(timer);

  assert.equal(res.sent, 0);
  assert.equal(res.skipped, 40, 'все уже отправлены — ни одной повторной выдачи');
  assert.ok(ticks > 0, 'цикл событий не должен быть заблокирован на время прохода');
  db.close();
});
