// LICENCE_LOCKOUT_E2E_V1 (2026-09-06) — «БЕЗ СВЯЗИ КЛИНИКА В КОНЦЕ КОНЦОВ
// ПЕРЕСТАЁТ РАБОТАТЬ» — ПРОВЕРЕНО, А НЕ ОБЪЯВЛЕНО.
//
// Владелец: «confirm that without connection clinics doesnt will work. confirm
// with real world tests». И отдельно: клинику удалили в панели, а она работает.
//
// Ответ на оба вопроса — один механизм, и его нельзя проверять по частям:
// лицензия это ВЫКЛЮЧАТЕЛЬ МЁРТВОГО ЧЕЛОВЕКА. Она подписана на 14 дней и
// перевыдаётся при каждом успешном ежечасном обращении к панели. Пропала
// связь, клинику удалили, подписка кончилась — обращение перестаёт приносить
// новую лицензию, и клиника доживает на старой. Поэтому «удалил, а она
// работает» — это не сбой, а идущий обратный отсчёт.
//
// ЗДЕСЬ РАБОТАЮТ ОБЕ НАСТОЯЩИЕ СТОРОНЫ: настоящая база панели с настоящей
// выдачей и подписью лицензии, настоящий клиентский обход и настоящий
// лицензионный шлюз приложения. Ни одной заглушки на пути, который проверяем.
//
// ЧЕГО НЕЛЬЗЯ БЫЛО ПРОВЕРИТЬ ИМИТАЦИЕЙ. Время. Подкрутить часы машины нельзя,
// поэтому будущее подаётся аргументом (controlState(db, dir, systemNow)), а
// «уже просроченная лицензия» берётся не из подделанного файла, а из
// НАСТОЯЩЕЙ подписи с days: 0 — signLicence это умеет именно ради такой
// проверки.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { hashPassword } from '../auth.js';
import { createApp } from '../../app.js';
import { controlState } from './state.js';
import { runCheckin } from './checkin.js';
import { __setPublicKeyForTests } from './state.js';
import { listen } from '../../../control-plane/server/test-helpers/listen.js';

import { openDb as openCpDb } from '../../../control-plane/server/db/connection.js';
import { migrate as migrateCp } from '../../../control-plane/server/db/migrate.js';
import { createEnrollmentCode, redeemEnrollmentCode } from '../../../control-plane/server/services/enrollment.js';
import { checkIn as cpCheckIn } from '../../../control-plane/server/services/checkin.js';
import { signLicence } from '../../../control-plane/server/services/signing.js';
import { generateKeyPairSync } from 'node:crypto';

const DAY = 24 * 60 * 60 * 1000;
const tmp = [];
function tmpDir() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'em-lockout-'));
    tmp.push(d);
    return d;
}
test.after(() => { for (const d of tmp) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

// --- настоящая панель: база, ключ подписи, зачисленная клиника ---------------
function controlPlane() {
    const db = openCpDb(':memory:');
    migrateCp(db);
    return db;
}

/** Заводит клинику в панели и раскладывает её файлы на «диск клиники». */
function enrolClinic(cpDb, { name = 'Тестовая клиника' } = {}) {
    const clinicId = 'c-' + String(Math.floor(Math.random() * 900000) + 100000);
    const code = createEnrollmentCode(cpDb, { clinicId, name });
    const redeemed = redeemEnrollmentCode(cpDb, { code, fingerprint: 'fp-1' }, {
        // Так же, как это делает настоящий маршрут зачисления: лицензию
        // подписывает панель, до фиксации записи.
        beforeCommit: ({ clinicId: id, clinicName, modules }) =>
            signLicence({ clinicId: id, clinicName, modules }),
    });
    assert.ok(redeemed && redeemed.licence, 'панель не выдала лицензию при зачислении');

    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'control.json'), JSON.stringify({
        clinic_id: redeemed.clinic_id,
        clinic_name: name,
        unlock_secret: redeemed.unlock_secret || 'secret',
        subscription: 'active',
        install_token: redeemed.install_token,
    }));
    fs.writeFileSync(path.join(dir, 'licence.dat'), JSON.stringify(redeemed.licence));
    return { dir, clinicId: redeemed.clinic_id, installToken: redeemed.install_token, licence: redeemed.licence };
}

function clinicDb() {
    const db = openDb(':memory:');
    migrate(db);
    db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)')
        .run('reg', hashPassword('password1'), 'Регистратор', 'registrar');
    return db;
}

async function startClinic(db, dataDir) {
    const server = await listen(createApp(db, { dataDir }));
    return { server, base: `http://127.0.0.1:${server.address().port}` };
}
async function login(base) {
    const res = await fetch(base + '/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'reg', password: 'password1' }),
    });
    assert.equal(res.status, 200, 'вход не удался');
    return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}
/** Настоящая работа клиники: завести пациента. Возвращает HTTP-код. */
async function tryWork(base, cookie) {
    const res = await fetch(base + '/api/db', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ table: 'patients', op: 'insert', values: [{ full_name: 'Тест Тестов' }] }),
    });
    return res.status;
}

// ОДНА ПАРА КЛЮЧЕЙ НА ОБЕ СТОРОНЫ. Панель подписывает своим закрытым ключом
// (она читает его путь из EASYMED_SIGNING_KEY — ровно как в работе), клиника
// проверяет парным открытым. Возьми разные — и проверялось бы совпадение
// ключей, а не механизм лицензии.
let _keysReady = false;
function pairKeys() {
    if (_keysReady) return;
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const keyFile = path.join(tmpDir(), 'signing.pem');
    fs.writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    process.env.EASYMED_SIGNING_KEY = keyFile;
    __setPublicKeyForTests(publicKey);
    _keysReady = true;
}

test('пока лицензия жива, клиника работает — и без всякой связи', async (t) => {
    pairKeys();
    const cp = controlPlane();
    const { dir } = enrolClinic(cp);
    const db = clinicDb();
    const { server, base } = await startClinic(db, dir);
    t.after(() => { server.close(); db.close(); cp.close(); });
    const cookie = await login(base);

    assert.equal(await tryWork(base, cookie), 200, 'зачисленная клиника обязана работать');

    // Связи нет ВООБЩЕ: адрес панели указывает в закрытый порт. Обход обязан
    // тихо не удаться и не тронуть лицензию.
    const before = fs.readFileSync(path.join(dir, 'licence.dat'), 'utf8');
    await runCheckin({ db, dataDir: dir, endpoint: 'http://127.0.0.1:9' }).catch(() => {});
    assert.equal(fs.readFileSync(path.join(dir, 'licence.dat'), 'utf8'), before,
        'неудачный обход не имеет права трогать лицензию');
    assert.equal(await tryWork(base, cookie), 200,
        'клиника перестала работать из-за пропавшей связи — а это ровно то, чего механизм не должен делать');
});

test('без связи клиника доживает 14 дней и запирается — по дням', () => {
    pairKeys();
    const cp = controlPlane();
    const { dir } = enrolClinic(cp);
    const db = clinicDb();

    const at = (days) => controlState(db, dir, new Date(Date.now() + days * DAY));

    // ТОЧНОЕ РАСПИСАНИЕ, а не «примерно две недели» — по нему владелец считает,
    // сколько времени у него есть, и сколько его есть у клиники без интернета.
    //   дни 0-6   молча работает
    //   дни 7-10  тихое предупреждение (7 дней до конца)
    //   дни 11-13 ежедневное предупреждение (3 дня до конца)
    //   день 14   ЗАПЕРТО
    assert.equal(at(0).state, 'ok', 'в день зачисления клиника уже о чём-то предупреждает');
    assert.equal(at(6).state, 'ok', 'на шестой день без связи предупреждать ещё не о чем');
    assert.equal(at(7).state, 'notice', 'за неделю до конца обязано появиться тихое предупреждение');
    assert.equal(at(10).state, 'notice');
    assert.equal(at(11).state, 'warn', 'за три дня до конца — ежедневное предупреждение');
    assert.equal(at(13).state, 'warn');
    assert.equal(at(13).locked, false, 'за сутки до конца клиника ещё работает');

    const dead = at(14);
    assert.equal(dead.locked, true, 'на четырнадцатый день без связи клиника ОБЯЗАНА запереться');
    assert.equal(dead.daysLeft, 0);
    // И слова: клинике, которая платит, нельзя говорить про деньги.
    assert.equal(dead.reason, 'offline',
        'клинике без связи сказали про неоплату — так нельзя: она могла заплатить, а роутер умереть');

    db.close(); cp.close();
});

test('удалённая в панели клиника перестаёт получать лицензию — и запирается по тому же сроку', () => {
    pairKeys();
    const cp = controlPlane();
    const { dir, installToken, clinicId } = enrolClinic(cp);

    // До удаления обход панели приносит свежую лицензию.
    const before = cpCheckIn(cp, { installToken, version: '0.9.2', fingerprint: 'fp-1' }, { signLicence });
    assert.ok(before && before.licence, 'живая клиника обязана получать лицензию');
    assert.equal(before.subscription, 'active');

    // Удаление строки — ровно то, что делает кнопка «удалить» в панели.
    cp.prepare('DELETE FROM clinics WHERE clinic_id = ?').run(clinicId);

    const after = cpCheckIn(cp, { installToken, version: '0.9.2', fingerprint: 'fp-1' }, { signLicence });
    assert.equal(after, null,
        'удалённая клиника всё ещё получает лицензию — тогда удаление не значит ничего');

    // Лицензия на диске осталась прежней: клиника доживает свой срок.
    const db = clinicDb();
    assert.equal(controlState(db, dir, new Date()).locked, false,
        'удаление НЕ гасит клинику мгновенно — и это осознанное решение, а не ошибка');
    assert.equal(controlState(db, dir, new Date(Date.now() + 15 * DAY)).locked, true,
        'удалённая клиника обязана запереться, когда истечёт выданный ей срок');

    db.close(); cp.close();
});

test('снятая с обслуживания (retired) клиника — то же самое: лицензии больше нет', () => {
    pairKeys();
    const cp = controlPlane();
    const { installToken, clinicId } = enrolClinic(cp);

    // Кнопка «снять с обслуживания» в панели: строка цела, active = 0.
    cp.prepare("UPDATE clinics SET active = 0, retired_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE clinic_id = ?")
        .run(clinicId);

    const after = cpCheckIn(cp, { installToken, version: '0.9.2', fingerprint: 'fp-1' }, { signLicence });
    assert.equal(after, null, 'снятая с обслуживания клиника продолжает получать лицензию');
    cp.close();
});

test('кончилась подписка — лицензия не перевыдаётся, хотя клиника ещё жива', () => {
    pairKeys();
    const cp = controlPlane();
    const { installToken, clinicId } = enrolClinic(cp);

    // Подписка оплачена по вчерашний день.
    const yesterday = new Date(Date.now() - DAY).toISOString().slice(0, 10);
    cp.prepare('UPDATE clinics SET subscription_until = ? WHERE clinic_id = ?').run(yesterday, clinicId);

    const res = cpCheckIn(cp, { installToken, version: '0.9.2', fingerprint: 'fp-1' }, { signLicence });
    assert.ok(res, 'клиника узнаваема — отвечать 401 ей не за что');
    assert.equal(res.licence, null, 'просроченной подписке выдали свежую лицензию');
    assert.equal(res.subscription, 'unpaid',
        'клинике не сказали про неоплату — а это единственный случай, когда про деньги говорить МОЖНО');

    cp.close();
});

test('запертая клиника отказывает в работе по-настоящему, через HTTP', async (t) => {
    pairKeys();
    const cp = controlPlane();
    const { dir, clinicId } = enrolClinic(cp);

    // НАСТОЯЩАЯ подпись просроченной лицензии (days: 0) — не подделанный файл:
    // проверяется тот же путь, что и у живой лицензии, включая проверку подписи.
    const expired = signLicence({ clinicId, clinicName: 'Тестовая клиника', modules: [], days: 0 });
    fs.writeFileSync(path.join(dir, 'licence.dat'), JSON.stringify(expired));

    const db = clinicDb();
    const { server, base } = await startClinic(db, dir);
    t.after(() => { server.close(); db.close(); cp.close(); });
    const cookie = await login(base);

    const status = await tryWork(base, cookie);
    assert.equal(status, 402,
        'клиника с истёкшей лицензией продолжает записывать данные — значит замка нет вовсе');

    const st = controlState(db, dir, new Date());
    assert.equal(st.locked, true);
    assert.deepEqual(st.modules, [], 'у запертой клиники не остаётся ни одного модуля');
});
