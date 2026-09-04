// STAFF_SYNC_SEAL_V1 (ревью Фазы 3, C1) — СПРАВОЧНИК ПО ПРЯМОМУ КАНАЛУ
// ЗАПЕЧАТАН, И ХЕШИ ПАРОЛЕЙ НЕ МОГУТ УЙТИ ОТКРЫТЫМ ТЕКСТОМ.
//
// Почему этот файл вообще появился. С 9a1c75b в справочник входят учётные
// записи сотрудников — вместе с bcrypt-хешами, ФИО, телефонами, почтой и
// номерами лицензий, — а Маршрут А отдавал их обычным JSON. Адрес главного
// филиала владелец вводит как «10.4.1.10:8000», и pairing.js по умолчанию
// дописывает http://: в НОРМАЛЬНОЙ клинической установке весь корпус хешей
// ехал по локальной сети открытым каждый час.
//
// Здесь поднимается настоящий маршрут на настоящем порту и проверяется РЕЗУЛЬТАТ
// НА ПРОВОДЕ: что именно лежит в переданных байтах. Это не проверка вызовов —
// «ни один из переданных байт не содержит подстроки password_hash» невозможно
// подделать заглушкой.
//
// Разбор ответа делает pull.js — тот самый код, что работает в филиале, а не
// его тестовая копия: обе стороны обязаны сходиться, и сойтись они должны
// здесь, а не в клинике.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { randomBytes } from 'node:crypto';

import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../services/auth.js';
import { branchSyncRoutes } from './branch-sync.js';
import { pullCatalogue } from '../services/branch-sync/pull.js';
import {
  writePairing, signRequest, CATALOGUE_PATH, b64url, GROUP_KEY_BYTES,
} from '../services/branch-sync/pairing.js';
import { ACCEPT_HEADER, SEALED_FORM } from '../services/branch-sync/catalogue.js';
import { listen as listenOnFreePort } from '../../control-plane/server/test-helpers/listen.js';

const GROUP = 'BR-AAAABBBBCCCC';
const SECRET = 'общий-секрет-пары';
const newKey = () => b64url(randomBytes(GROUP_KEY_BYTES));

/** Главная клиника: прайс, панель и двое сотрудников с настоящими хешами. */
function mainDb() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO service_categories (name, code) VALUES ('Кардиология','CARD')").run();
  db.prepare(`INSERT INTO services (name, code, price, type, category_id, active)
              VALUES ('Приём кардиолога','S-CARD',250000,'consultation',1,1)`).run();
  db.prepare(`INSERT INTO services (name, code, price, type, is_lab, active)
              VALUES ('Биохимия крови','S-BIO',180000,'lab',1,1)`).run();
  const bio = db.prepare("SELECT id FROM services WHERE code='S-BIO'").get().id;
  db.prepare('INSERT INTO lab_panels (name, code, service_id) VALUES (?,?,?)').run('Биохимия', 'P-BIO', bio);
  const panel = db.prepare("SELECT id FROM lab_panels WHERE code='P-BIO'").get().id;
  db.prepare(`INSERT INTO lab_panel_analytes (panel_id, code, name, unit, sort_order)
              VALUES (?,'GLU','Глюкоза','ммоль/л',1)`).run(panel);

  db.prepare(`INSERT INTO users (username, password_hash, full_name, role, phone, email, license_number)
              VALUES ('ivanov', ?, 'Иванов Иван', 'doctor', '+998901112233', 'ivanov@clinic.uz', 'LIC-4242')`)
    .run(hashPassword('sekret12345'));
  db.prepare(`INSERT INTO users (username, password_hash, full_name, role)
              VALUES ('glavvrach', ?, 'Каримова Дилноза', 'admin')`).run(hashPassword('adminpass1'));
  return db;
}

/** Каталог данных главной клиники: пара role=main, с ключом группы или без. */
function mainDir({ groupKey = newKey() } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-seal-main-'));
  const record = { role: 'main', group_id: GROUP, secret: SECRET, main_url: 'http://127.0.0.1:1' };
  if (groupKey) record.group_key = groupKey;
  writePairing(dir, record);
  return dir;
}

/** Каталог данных филиала: пара role=secondary, смотрящая на поднятый порт. */
function branchDir(base, { groupKey } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-seal-branch-'));
  const record = { role: 'secondary', group_id: GROUP, secret: SECRET, main_url: base };
  if (groupKey) record.group_key = groupKey;
  writePairing(dir, record);
  return dir;
}

/** Только маршрут раздачи — ни сессий, ни лицензии: он гейтит себя сам. */
async function serve(db, dir) {
  const app = express();
  app.use('/api/branch-sync', branchSyncRoutes(db, dir));
  const server = await listenOnFreePort(app);
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

function shutdown(server) {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

/** Подписанный запрос — с заголовком «умею распечатать» или без него. */
function ask(base, { sealed = false } = {}) {
  const ts = String(Date.now());
  return fetch(base + CATALOGUE_PATH, {
    headers: {
      'x-em-branch-group': GROUP,
      'x-em-branch-ts': ts,
      'x-em-branch-sig': signRequest({ secret: SECRET, groupId: GROUP, ts, requestPath: CATALOGUE_PATH }),
      ...(sealed ? { [ACCEPT_HEADER]: SEALED_FORM } : {}),
    },
  });
}

test('запечатанный ответ довозит сотрудников — и тем же кодом, что в филиале', async (t) => {
  const key = newKey();
  const db = mainDb();
  const dir = mainDir({ groupKey: key });
  const { server, base } = await serve(db, dir);
  const branch = branchDir(base, { groupKey: key });
  t.after(async () => { await shutdown(server); db.close(); });

  // Сначала — что лежит НА ПРОВОДЕ. Тело запечатано целиком: ни хеша, ни
  // логина, ни телефона, ни номера лицензии в переданных байтах нет.
  const raw = await (await ask(base, { sealed: true })).text();
  assert.equal(raw.includes('password_hash'), false, 'имя колонки не должно быть даже видно');
  assert.equal(raw.includes('ivanov'), false);
  assert.equal(raw.includes('+998901112233'), false);
  assert.equal(raw.includes('LIC-4242'), false);
  assert.equal(raw.includes('S-CARD'), false, 'прайс тоже внутри блоба, а не рядом с ним');
  const shape = JSON.parse(raw);
  assert.equal(shape.v, 2);
  assert.equal(typeof shape.sealed, 'string');
  assert.equal('catalogue' in shape, false, 'открытого справочника в этой форме не существует');

  // А теперь то же самое глазами филиала: он распечатывает и получает всё.
  const r = await pullCatalogue(branch);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.group_id, GROUP);
  const doc = r.catalogue.users.find((u) => u.username === 'ivanov');
  assert.ok(doc, 'сотрудники доехали');
  assert.match(doc.password_hash, /^\$2[aby]\$/, 'едет bcrypt-хеш, а не пароль');
  assert.equal(doc.license_number, 'LIC-4242');
  assert.equal(r.catalogue.role_permissions.length > 0, true, 'права ролей — тоже под замком');
  assert.ok(r.catalogue.services.some((s) => s.code === 'S-CARD'));
});

test('СТАРЫЙ ФИЛИАЛ ПОЛУЧАЕТ ТЕЛО, В КОТОРОМ НЕТ НИ ОДНОГО ХЕША', async (t) => {
  const db = mainDb();
  const dir = mainDir();
  const { server, base } = await serve(db, dir);
  t.after(async () => { await shutdown(server); db.close(); });

  // Ровно то, что делает филиал 0.7.x: подписанный запрос без заголовка о
  // запечатывании. Он ДОЛЖЕН продолжать получать справочник — иначе обновление
  // главной клиники отключило бы прайс во всех зданиях сразу.
  const wire = await (await ask(base)).text();

  // Главное утверждение всего файла, и проверяется оно по переданным БАЙТАМ, а
  // не по разобранному объекту: подстроки нет вообще нигде.
  assert.equal(wire.includes('password_hash'), false, 'хеши паролей не уходят открытым текстом НИКОГДА');
  assert.equal(wire.includes('$2b$'), false, 'и ни одного bcrypt-хеша по значению');
  assert.equal(wire.includes('ivanov'), false, 'вместе с хешем не уезжают и логины');
  assert.equal(wire.includes('LIC-4242'), false, 'ни номера лицензий');
  assert.equal(wire.includes('ivanov@clinic.uz'), false, 'ни почта');

  const body = JSON.parse(wire);
  assert.equal(body.ok, true);
  assert.equal('users' in body.catalogue, false, 'ключа нет вовсе: в этом теле сотрудников не существует');
  assert.equal('role_permissions' in body.catalogue, false);

  // И то, ради чего старая форма вообще осталась: прайс и панели по-прежнему
  // едут. Запрет адресный, а не «раздача выключена».
  assert.ok(body.catalogue.services.some((s) => s.code === 'S-CARD'), 'услуги доезжают');
  assert.ok(body.catalogue.lab_panels.some((p) => p.code === 'P-BIO'), 'лабораторные панели доезжают');
  assert.ok(body.catalogue.lab_panel_analytes.some((a) => a.code === 'GLU'), 'и показатели внутри них');
  assert.ok(body.catalogue.doc_settings, 'и сведения о клинике');
});

test('чужой ключ группы не распечатывает ничего — и говорит, что чинить', async (t) => {
  const db = mainDb();
  const dir = mainDir({ groupKey: newKey() });
  const { server, base } = await serve(db, dir);
  // Так выглядит филиал, которому не разнесли перевыпущенный ключ: секрет пары
  // тот же (подпись сойдётся), а ключ шифрования — другой.
  const branch = branchDir(base, { groupKey: newKey() });
  t.after(async () => { await shutdown(server); db.close(); });

  const r = await pullCatalogue(branch);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'relay_bad_key', 'та же причина, что у Маршрута Б: поломка одна и чинится одинаково');
  assert.equal('catalogue' in r, false, 'наполовину распечатанного справочника не бывает');
});

test('главная клиника без ключа группы отдаёт справочник БЕЗ сотрудников, а не открытым текстом', async (t) => {
  const db = mainDb();
  // Пара, сделанная ключом EMB1 до появления Маршрута Б: шифровать нечем.
  const dir = mainDir({ groupKey: null });
  const { server, base } = await serve(db, dir);
  const branch = branchDir(base, { groupKey: newKey() });
  t.after(async () => { await shutdown(server); db.close(); });

  const wire = await (await ask(base, { sealed: true })).text();
  assert.equal(wire.includes('password_hash'), false, 'отката на открытый текст нет ни одного');
  assert.equal('users' in JSON.parse(wire).catalogue, false);

  // Филиал при этом не остаётся без прайса: он получает старую форму и
  // принимает её (см. pull.js — две формы ответа).
  const r = await pullCatalogue(branch);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.catalogue.services.some((s) => s.code === 'S-CARD'));
  assert.equal('users' in r.catalogue, false);
});

test('филиал без ключа группы не просит запечатанное — иначе остался бы и без прайса', async (t) => {
  const db = mainDb();
  const dir = mainDir({ groupKey: newKey() });
  const { server, base } = await serve(db, dir);
  const branch = branchDir(base, { groupKey: null });
  t.after(async () => { await shutdown(server); db.close(); });

  const r = await pullCatalogue(branch);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.catalogue.services.some((s) => s.code === 'S-CARD'), 'справочник он получает как раньше');
  assert.equal('users' in r.catalogue, false, 'а сотрудников — нет: прочитать их он всё равно не смог бы');
});

test('чужая подпись и чужая роль по-прежнему не получают ничего', async (t) => {
  const db = mainDb();
  const dir = mainDir();
  const { server, base } = await serve(db, dir);
  t.after(async () => { await shutdown(server); db.close(); });

  // Запечатывание не должно было ослабить гейт: он стоит ДО сборки тела.
  const bare = await fetch(base + CATALOGUE_PATH, { headers: { [ACCEPT_HEADER]: SEALED_FORM } });
  assert.equal(bare.status, 401);

  const ts = String(Date.now());
  const forged = await fetch(base + CATALOGUE_PATH, {
    headers: {
      'x-em-branch-group': GROUP,
      'x-em-branch-ts': ts,
      'x-em-branch-sig': signRequest({ secret: 'подобранный', groupId: GROUP, ts, requestPath: CATALOGUE_PATH }),
      [ACCEPT_HEADER]: SEALED_FORM,
    },
  });
  assert.equal(forged.status, 401);
});
