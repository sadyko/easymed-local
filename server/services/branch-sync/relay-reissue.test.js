// BRANCH_REISSUE_V1 — клиентская половина перевыпуска кода активации филиала.
//
// ЧТО ЗДЕСЬ ПРОВЕРЯЕТСЯ и почему это отдельный файл. Серверная ручка
// (control-plane/server/routes/branch.js + branch-reissue.route.test.js) уже
// живёт на settings.easymed.uz и своими тестами закрыта. Здесь — то, чего с
// той стороны не видно: КАК главная клиника её зовёт и во что превращает
// КАЖДЫЙ её ответ. Превращение это не косметическое: reason отсюда доезжает
// до владельца готовой фразой, и промах между 404 и 401 означает «обратитесь
// в поддержку» вместо «проверьте активацию клиники» — то есть вечер,
// потраченный не туда.
//
// СЕТИ ЗДЕСЬ НЕТ ВООБЩЕ: fetchImpl подставной в каждом тесте. Это не только
// скорость — это ещё и prod-guard.js: без подставного fetch и без
// EASYMED_CONTROL_URL вызов ушёл бы на ЖИВОЙ сервер поставщика, и такое уже
// случалось (см. шапку prod-guard.js).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { reissueBranchOnControlPlane } from './relay.js';

const ENV = { EASYMED_CONTROL_URL: 'http://127.0.0.1:8099' };

/** Каталог данных активированной ГЛАВНОЙ клиники: install_token — вся её аутентификация. */
function mainDir({ token = 'tok-MAIN' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-reissue-'));
  if (token) {
    fs.writeFileSync(path.join(dir, 'control.json'),
      JSON.stringify({ clinic_id: 'c-000005', install_token: token }));
  }
  return dir;
}

/** Ответ поставщика в той форме, в какой его читает вызов (res.json()). */
const reply = (status, body) => async (url, init) => {
  reply.last = { url, init };
  return { ok: status >= 200 && status < 300, status, json: async () => body };
};

test('перевыпуск идёт на ручку филиала и предъявляет install_token ГЛАВНОЙ клиники', async () => {
  // Аутентификация та же, что у заведения филиала, и это свойство, а не
  // совпадение: на той стороне обе ручки ходят через одну функцию. Токен
  // едет В ТЕЛЕ, а не заголовком, — так вся клиентская половина control plane
  // и разговаривает (enroll, checkin).
  const dir = mainDir();
  const fetchImpl = reply(200, { clinic_id: 'c-000005-b2', name: 'Чиланзар', enrollment_code: 'EM-NEW-0002' });

  const r = await reissueBranchOnControlPlane(dir, { clinicId: 'c-000005-b2', fetchImpl, env: ENV });

  assert.deepEqual(r, {
    ok: true, enrollment_code: 'EM-NEW-0002', clinic_id: 'c-000005-b2', name: 'Чиланзар',
  });
  assert.equal(reply.last.url, 'http://127.0.0.1:8099/cp/v1/branch/c-000005-b2/reissue');
  assert.equal(reply.last.init.method, 'POST');
  assert.equal(reply.last.init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(reply.last.init.body), { install_token: 'tok-MAIN' });
});

test('идентификатор филиала уезжает экранированным, а не склеенным в путь', async () => {
  // Он приходит из нашей же записи, но путь собирается строкой, и знак «/» в
  // значении означал бы запрос совсем к другой ручке.
  const dir = mainDir();
  const fetchImpl = reply(404, { error: 'not_found' });
  await reissueBranchOnControlPlane(dir, { clinicId: 'c-1/../relay', fetchImpl, env: ENV });
  assert.equal(reply.last.url, 'http://127.0.0.1:8099/cp/v1/branch/c-1%2F..%2Frelay/reissue');
});

test('без идентификатора филиала В СЕТЬ НЕ ХОДИМ', async () => {
  // POST на /reissue без адресата — это 404 у поставщика, то есть «филиал не
  // найден» на экране. Правда другая: мы не знаем, КУДА обращаться, и лечится
  // это не поддержкой, а заведением филиала заново.
  const dir = mainDir();
  let called = false;
  const fetchImpl = async () => { called = true; throw new Error('сюда ходить не должны'); };

  for (const clinicId of [null, undefined, '', '   ']) {
    const r = await reissueBranchOnControlPlane(dir, { clinicId, fetchImpl, env: ENV });
    assert.deepEqual(r, { ok: false, reason: 'reissue_unknown_branch' });
  }
  assert.equal(called, false);
});

test('неактивированная клиника перевыпускать не может, и это своя причина', async () => {
  // Ей нечем доказать поставщику, кто она: install_token выдаётся при
  // активации. Та же причина и тем же кодом, что у заведения филиала.
  const dir = mainDir({ token: null });
  let called = false;
  const fetchImpl = async () => { called = true; throw new Error('сюда ходить не должны'); };
  const r = await reissueBranchOnControlPlane(dir, { clinicId: 'c-000005-b1', fetchImpl, env: ENV });
  assert.deepEqual(r, { ok: false, reason: 'branch_not_enrolled' });
  assert.equal(called, false);
});

test('каждый ответ поставщика превращается в СВОЮ причину', async () => {
  const dir = mainDir();
  const cases = [
    // 404 у этой ручки означает сразу три вещи (нет такого / не ваш /
    // погашен), и поставщик отвечает на все три одинаково НАМЕРЕННО — чтобы
    // по разнице ответов нельзя было перебирать чужой реестр. Значит и
    // причина здесь одна.
    [404, 'reissue_not_found'],
    [401, 'branch_unauthorized'],
    [403, 'branch_unauthorized'],
    [500, 'branch_server_error'],
    [502, 'branch_server_error'],
    // 402 у ЗАВЕДЕНИЯ филиала означает «неоплаченная сеть не заводит новых
    // платящих клиентов». Здесь ручка подписку не проверяет вовсе (см.
    // routes/branch.js), поэтому отдельного кода этому статусу не заводится:
    // придёт — будет честной ошибкой сервера.
    [402, 'branch_server_error'],
  ];
  for (const [status, reason] of cases) {
    const r = await reissueBranchOnControlPlane(dir, {
      clinicId: 'c-000005-b1', fetchImpl: reply(status, { error: 'x' }), env: ENV,
    });
    assert.deepEqual(r, { ok: false, reason }, `статус ${status}`);
  }
});

test('мёртвая сеть — это branch_offline, а не исключение', async () => {
  // Клиника офлайновая по построению: отсутствие интернета обязано выглядеть
  // как состояние, а не как поломка программы.
  const dir = mainDir();
  const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  const r = await reissueBranchOnControlPlane(dir, { clinicId: 'c-000005-b1', fetchImpl, env: ENV });
  assert.deepEqual(r, { ok: false, reason: 'branch_offline' });
});

test('ответ без кода активации — отказ, а не «успех без кода»', async () => {
  // Ключ без кода — это ключ, которым филиал не активируется. Отдать такой
  // молча значит отправить человека ставить систему, которая не заведётся, —
  // ровно та ошибка, ради которой перевыпуск и написан.
  const dir = mainDir();
  for (const body of [{}, { enrollment_code: '' }, { enrollment_code: '   ' }, { enrollment_code: 42 }, null]) {
    const r = await reissueBranchOnControlPlane(dir, {
      clinicId: 'c-000005-b1', fetchImpl: reply(200, body), env: ENV,
    });
    assert.deepEqual(r, { ok: false, reason: 'branch_server_error' }, JSON.stringify(body));
  }
});

test('нечитаемое тело при 200 — тоже отказ', async () => {
  const dir = mainDir();
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => { throw new Error('not json'); } });
  const r = await reissueBranchOnControlPlane(dir, { clinicId: 'c-000005-b1', fetchImpl, env: ENV });
  assert.deepEqual(r, { ok: false, reason: 'branch_server_error' });
});

test('идентификатор берётся ИЗ ОТВЕТА, а имя может и не приехать', async () => {
  // Ответ поставщика — подтверждение того, что перевыпущен именно тот филиал.
  // Имя же служебное: у него нет ни одного потребителя, кроме журнала, и
  // отсутствие имени не повод объявлять перевыпуск неудачным.
  const dir = mainDir();
  const r = await reissueBranchOnControlPlane(dir, {
    clinicId: 'c-000005-b1', env: ENV,
    fetchImpl: reply(200, { clinic_id: 'c-000005-b1', enrollment_code: ' EM-A ' }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.clinic_id, 'c-000005-b1');
  assert.equal(r.name, null);
  assert.equal(r.enrollment_code, 'EM-A', 'пробелы по краям кода — не часть кода');
});

test('адрес поставщика читается из окружения при каждом вызове', async () => {
  // То же правило, что у relayUrl/checkinUrl: окружение читается на вызове, а
  // не запоминается при загрузке модуля, иначе тестовый и рабочий адрес
  // разъезжаются в одном процессе.
  const dir = mainDir();
  await reissueBranchOnControlPlane(dir, {
    clinicId: 'c-1-b1', fetchImpl: reply(200, { enrollment_code: 'EM-1' }),
    env: { EASYMED_CONTROL_URL: 'https://other.example///' },
  });
  assert.equal(reply.last.url, 'https://other.example/cp/v1/branch/c-1-b1/reissue');
});
