// BRANCH_SYNC_HOURLY_V1 — кто может нажать «Синхронизация» и что при этом
// происходит.
//
// Решение владельца 2026-09-02: кнопка появляется в окне регистратуры и
// лаборатории. Это люди без прав администратора, и делать их администраторами
// ради подтягивания данных соседнего филиала было бы куда хуже, чем открыть им
// одно безопасное действие.
//
// Действие безопасно не потому, что «ну, наверное»: ровно то же самое каждый
// час выполняют часы (schedule-pull.js) вообще без человека. Кнопка не даёт
// новых возможностей — она лишь избавляет от ожидания до следующего часа.
// Здесь это и закреплено, вместе с двумя границами: анонимный запрос всё-таки
// отклоняется, а повторное нажатие не превращается во второе скачивание
// справочника по узкому каналу.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { setDataDir } from '../control/config.js';
import { writePairing } from '../branch-sync/pairing.js';
import { withExchangeLock, publishCatalogue, maybePublish } from '../branch-sync/relay.js';
import { branchSyncNow, runBranchSync } from './branch-sync.js';

const dirs = [];
function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsync-now-'));
  dirs.push(dir);
  setDataDir(dir);
  const db = openDb(':memory:');
  migrate(db);
  return { db, dir };
}
test.after(() => {
  for (const d of dirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

// Синхронизация, которая ничего не нашла: pullCatalogue отвечает «нет связи».
// Этого достаточно — проверяется допуск и частота, а не применение справочника
// (оно покрыто catalogue.test.js и sync-e2e.test.js).
const offline = { pullImpl: async () => ({ ok: false, reason: 'offline' }),
                  relayImpl: async () => ({ ok: false, reason: 'offline' }) };

const REGISTRAR = { id: 7, role: 'registrar', roles: ['registrar'] };
const LABORANT = { id: 8, role: 'laborant', roles: ['laborant'] };

test('регистратура может запустить синхронизацию', async () => {
  const { db } = harness();
  const res = await branchSyncNow(db, {}, REGISTRAR, offline);
  // Важен не успех (сети в тесте нет), а отсутствие 403.
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'offline');
});

test('лаборатория может запустить синхронизацию', async () => {
  const { db } = harness();
  const res = await branchSyncNow(db, {}, LABORANT, offline);
  assert.equal(res.reason, 'offline', 'лаборанту не нужен админ, чтобы подтянуть данные');
});

test('анонимный запрос отклоняется', async () => {
  const { db } = harness();
  await assert.rejects(
    () => branchSyncNow(db, {}, null, offline),
    (e) => e.status === 401,
    'открыть всем вошедшим — не то же самое, что открыть всем');
});

test('два нажатия одновременно — по очереди, и каждый получает СВОЙ ответ', async () => {
  // ОЧЕРЕДЬ, А НЕ СКЛЕЙКА (ревью BRANCH_MAIN_PUSH_V1, 2026-09-03). Раньше здесь
  // утверждалось «одно скачивание на два нажатия»: опоздавший получал обещание
  // того, кто уже в полёте. Экономию пришлось разменять, и вот на что.
  //
  // Замок общий с часами (relay.js), а часовой такт главной клиники держит его
  // вокруг exchangeJournals, чей ответ — {published, fetched}: ни ok, ни reason,
  // ни message. Нажавший в эту секунду владелец получал ЧУЖОЙ ответ чужой
  // формы: копия справочника не отправлялась вовсе, а экран читал ответ как
  // неудачу — «Не удалось синхронизировать». Одно и то же действие раз в час на
  // минуту переставало работать, и объяснить это было нечем.
  //
  // Цена размена — два прогона вместо одного при одновременном нажатии двух
  // человек; каждый из них при этом настоящий. Одиночное нажатие (99% случаев)
  // не изменилось никак.
  const { db } = harness();
  let pulls = 0;
  const slow = {
    pullImpl: async () => {
      pulls += 1;
      await new Promise((r) => setTimeout(r, 20));
      return { ok: false, reason: 'offline' };
    },
    relayImpl: async () => ({ ok: false, reason: 'offline' }),
  };

  // Регистратор и лаборант нажали почти одновременно.
  const [a, b] = await Promise.all([
    branchSyncNow(db, {}, REGISTRAR, slow),
    branchSyncNow(db, {}, LABORANT, slow),
  ]);

  assert.equal(pulls, 2, 'второй нажавший делает свой прогон, а не пересказывает чужой');
  // И это ГЛАВНОЕ: оба видят настоящий результат, а не «подождите» и не чужой
  // прошлый ответ. Пауза с отдачей прошлого результата показывала бы второму
  // бодрое «обновлено» там, где его собственная попытка ничего бы не дала.
  assert.equal(a.reason, 'offline');
  assert.equal(b.reason, 'offline');
});

test('после завершения следующий запуск идёт в сеть заново', async () => {
  const { db } = harness();
  let pulls = 0;
  const counting = {
    pullImpl: async () => { pulls += 1; return { ok: false, reason: 'offline' }; },
    relayImpl: async () => ({ ok: false, reason: 'offline' }),
  };
  await branchSyncNow(db, {}, REGISTRAR, counting);
  await branchSyncNow(db, {}, REGISTRAR, counting);
  // Склейка — только на время полёта. Иначе починивший связь администратор
  // жал бы кнопку и получал старый отказ.
  assert.equal(pulls, 2, 'последовательные нажатия — настоящие попытки');
});
test('часам пользователь не нужен вообще', async () => {
  const { db } = harness();
  // runBranchSync — то, что вызывает scheduleBranchPull: без user, без прав.
  // Если однажды сюда вернут проверку прав, часы молча перестанут работать,
  // и заметит это владелец по устаревшим отчётам, а не тест.
  const res = await runBranchSync(db, offline);
  assert.equal(res.reason, 'offline');
});

// --- BRANCH_MAIN_PUSH_V1: та же кнопка в ГЛАВНОЙ клинике -------------------
//
// ЧТО УВИДЕЛ ВЛАДЕЛЕЦ 2026-09-03. Он нажал «Синхронизация» в главной клинике и
// получил отказ: «Это главный филиал — он раздаёт справочник, а не забирает
// его». В журнале попыток осталось ровно это (ok:false, reason:not_secondary),
// и по делу владелец был прав, а программа — нет: он только что поменял цены и
// нажал кнопку, чтобы филиалы их увидели.
//
// ЧЕМ ЭТО БЫЛО НА САМОМ ДЕЛЕ. Кнопка звала runBranchSync, у которого первый шаг
// — ЗАБРАТЬ справочник. Главной забирать не у кого, поэтому шаг отвечал
// not_secondary, и его фраза уезжала на экран как итог всей синхронизации —
// даже когда второй шаг (обмен записями) отработал. А копию справочника
// главная отправляла только по часам (maybePublish), да и то лишь если хэш
// изменился или прошли сутки: нажатие кнопки не отправляло НИЧЕГО.
//
// ЧТО ЗДЕСЬ ЗАКРЕПЛЕНО. У главной клиники та же кнопка означает зеркальное
// действие: ОТПРАВИТЬ копию сейчас (без экономии по хэшу — владелец нажал
// именно потому, что что-то изменил) и обменяться записями, а потом честно
// рассказать об обоих шагах.

const MAIN_URL = 'http://10.0.0.5:8000';

/** Пара «эта установка — главный филиал», как её пишет branchSyncMakeKey. */
function mainPairing(dir, { relay = true } = {}) {
  return writePairing(dir, {
    role: 'main',
    group_id: 'BR-AAAAAAAAAAAA',
    secret: 'sec',
    main_url: MAIN_URL,
    group_key: 'k'.repeat(43),
    relay,
    created_at: '2026-09-01T00:00:00Z',
  });
}

function lastAttempt(db) {
  const row = db.prepare("SELECT value FROM control_state WHERE key = 'branch_sync_last_attempt'").get();
  return row ? JSON.parse(row.value) : null;
}

test('главная клиника: кнопка ОТПРАВЛЯЕТ копию справочника, а не отказывает', async () => {
  const { db, dir } = harness();
  mainPairing(dir, { relay: true });

  let published = 0;
  let pulled = 0;
  const res = await branchSyncNow(db, {}, REGISTRAR, {
    pullImpl: async () => { pulled += 1; return { ok: false, reason: 'not_secondary' }; },
    relayImpl: async () => ({ ok: false, reason: 'relay_not_secondary' }),
    publishImpl: async () => {
      published += 1;
      return { ok: true, bytes: 17 * 1024, at: '2026-09-03T08:41:40Z', hash: 'h' };
    },
    publishJournalImpl: async () => ({ ok: true, peers: { B: 4 } }),
    fetchJournalsImpl: async () => ({ ok: true, peers: { B: { applied: 3, refused: 0, skipped: 0 } } }),
  });

  assert.equal(published, 1, 'кнопка обязана отправить копию, а не ждать часового прогона');
  assert.equal(pulled, 0, 'забирать справочник главной не у кого — и стучаться незачем');
  assert.equal(res.ok, true);
  assert.equal(res.reason, 'published');
  assert.doesNotMatch(res.message, /раздаёт справочник/, 'отказ шага «забрать» — не итог этой кнопки');
  assert.match(res.message, /отправлена/, 'владелец должен прочитать, что копия ушла');
  assert.match(res.message, /17 КБ/, 'и сколько её ушло');
  assert.match(res.message, /получено 3/);
  // «на сервер» — потому что записи уезжают на сервер поставщика, а филиалы
  // забирают их оттуда сами (ревью 2026-09-03).
  assert.match(res.message, /отправлено на сервер 4/);
  assert.doesNotMatch(res.message, /[{}]/, 'дырка на экране — это ошибка, которую видит владелец');

  // Журнал попыток — то, что рисует карточка «Настройки → Филиалы».
  const rec = lastAttempt(db);
  assert.equal(rec.ok, true, 'в журнале стоял ok:false — по нему и жаловался владелец');
  assert.equal(rec.reason, 'published');
  assert.equal(rec.message, res.message, 'кнопка и карточка обязаны говорить одно и то же');
  db.close();
});

test('главная клиника: выключенный резервный канал не отменяет обмен записями', async () => {
  const { db, dir } = harness();
  mainPairing(dir, { relay: false });

  let published = 0;
  const res = await branchSyncNow(db, {}, LABORANT, {
    publishImpl: async () => { published += 1; return { ok: true, bytes: 1024 }; },
    publishJournalImpl: async () => ({ ok: true, peers: {} }),
    fetchJournalsImpl: async () => ({ ok: true, peers: { B: { applied: 2 } } }),
  });

  assert.equal(published, 0, 'выключенный канал — не повод стучаться на сервер');
  assert.equal(res.ok, true, 'записи приехали, и это успех');
  assert.equal(res.reason, 'relay_disabled', 'но про невыгруженную копию надо сказать');
  assert.match(res.message, /Резервный канал/);
  assert.match(res.message, /получено 2/);
  db.close();
});

test('главная клиника: сервер недоступен — честный отказ с причиной сервера', async () => {
  const { db, dir } = harness();
  mainPairing(dir, { relay: true });

  const res = await branchSyncNow(db, {}, REGISTRAR, {
    publishImpl: async () => ({ ok: false, reason: 'relay_offline' }),
    // Обе причины «тихие» (QUIET_JOURNAL_REASONS): рассказывать про записи
    // нечего, и итогом остаётся неудача отправки.
    publishJournalImpl: async () => ({ ok: false, reason: 'relay_no_peers' }),
    fetchJournalsImpl: async () => ({ ok: false, reason: 'relay_no_peers' }),
  });

  assert.equal(res.ok, false);
  assert.equal(res.reason, 'relay_offline');
  assert.match(res.message, /Нет связи с сервером Easy-Med/);
  assert.equal(lastAttempt(db).ok, false);
  db.close();
});

test('подключённый филиал: путь прежний — забрать справочник, копию не слать', async () => {
  const { db, dir } = harness();
  writePairing(dir, {
    role: 'secondary',
    group_id: 'BR-AAAAAAAAAAAA',
    secret: 'sec',
    main_url: MAIN_URL,
    group_key: 'k'.repeat(43),
    paired_at: '2026-09-01T00:00:00Z',
  });

  let published = 0;
  let pulled = 0;
  const res = await branchSyncNow(db, {}, REGISTRAR, {
    pullImpl: async () => { pulled += 1; return { ok: false, reason: 'offline' }; },
    relayImpl: async () => ({ ok: false, reason: 'relay_empty' }),
    publishImpl: async () => { published += 1; return { ok: true, bytes: 1 }; },
    publishJournalImpl: async () => ({ ok: false, reason: 'relay_no_peers' }),
    fetchJournalsImpl: async () => ({ ok: false, reason: 'relay_no_peers' }),
  });

  assert.equal(pulled, 1);
  assert.equal(published, 0, 'копию на сервер выкладывает только главный филиал');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'offline');
  db.close();
});

test('часы на главной клинике копию не шлют — это делает КНОПКА', async () => {
  // runBranchSync зовут и часы (schedule-pull.js), и сквозные тесты обмена
  // записями. Отправка копии — действие человека, нажавшего кнопку: развесить
  // её по всем прогонам значило бы гнать мегабайты справочника на сервер
  // каждый раз, когда узел просто меняется записями.
  const { db, dir } = harness();
  mainPairing(dir, { relay: true });

  let published = 0;
  await runBranchSync(db, {
    pullImpl: async () => ({ ok: false, reason: 'not_secondary' }),
    relayImpl: async () => ({ ok: false, reason: 'relay_not_secondary' }),
    publishImpl: async () => { published += 1; return { ok: true, bytes: 1 }; },
    publishJournalImpl: async () => ({ ok: false, reason: 'relay_no_peers' }),
    fetchJournalsImpl: async () => ({ ok: false, reason: 'relay_no_peers' }),
  });

  assert.equal(published, 0);
  db.close();
});

// ===========================================================================
// РЕВЬЮ BRANCH_MAIN_PUSH_V1 (2026-09-03) — четыре дыры, найденные разбором.
//
// Все четыре об одном: кнопка обязана делать СВОЁ дело и рассказывать о нём
// правду. Разбор нашёл, что в час пик она делала чужое, а в остальное время
// пересчитывала и пересказывала своё неверно.
// ===========================================================================

test('часовой обмен в полёте — кнопка ЖДЁТ его и делает свой прогон, а не пересказывает чужой', async () => {
  // САМАЯ ДОРОГАЯ ИЗ ЧЕТЫРЁХ. Замок общий с часами, а часовой такт главной
  // клиники держит его вокруг exchangeJournals — та отвечает {published,
  // fetched}: ни ok, ни reason, ни message. Пока замок отдавал опоздавшему
  // ОБЕЩАНИЕ ИДУЩЕЙ работы, нажатие в эту секунду не отправляло копию
  // справочника вовсе (publishCatalogue не звался), не обменивалось записями
  // от своего имени и возвращало ответ чужой формы — который экран честно
  // читал как неудачу: «Не удалось синхронизировать». Владелец, поменявший
  // цены, получал отказ и не мог понять, почему кнопка работает не всегда.
  const { db, dir } = harness();
  mainPairing(dir, { relay: true });

  let release;
  const held = new Promise((r) => { release = r; });
  const hourly = withExchangeLock(async () => {
    await held;
    return { published: { ok: true, peers: {} }, fetched: { ok: true, peers: {} } };
  });

  let published = 0;
  const pressed = branchSyncNow(db, {}, REGISTRAR, {
    publishImpl: async () => { published += 1; return { ok: true, bytes: 17 * 1024 }; },
    publishJournalImpl: async () => ({ ok: true, peers: { B: 3 }, rows: 3 }),
    fetchJournalsImpl: async () => ({ ok: true, peers: { B: { applied: 2 } } }),
  });

  // Пока чужая работа не кончилась, наша не начинается: два обмена разом — это
  // две резервные копии и две транзакции приёма, спорящие за одну базу.
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(published, 0, 'замок обязан остаться замком, а не превратиться в два потока');

  release();
  await hourly;
  const res = await pressed;

  assert.equal(published, 1, 'дождавшись, кнопка выполняет СВОЙ полный прогон');
  assert.equal(res.ok, true);
  assert.equal(res.reason, 'published', 'и отвечает своей формой: ok, reason, message');
  assert.match(res.message, /отправлена на сервер/);
  assert.equal(res.fetched, undefined, 'форма часового обмена ({published, fetched}) наружу не уезжает');
  assert.equal(lastAttempt(db).reason, 'published');
  db.close();
});

test('нет интернета — ОДНА новость, а не три подряд', async () => {
  // Все три вызова офлайн отвечают одной причиной, и владелец читал:
  // «Нет связи с сервером Easy-Med. Записи: получено 0, отправлено на сервер 0.
  //  Нет связи с сервером Easy-Med. Нет связи с сервером Easy-Med.»
  // Трижды повторённая новость выглядит как сломанная программа — ровно там,
  // где программа исправна, а выключен интернет.
  const { db, dir } = harness();
  mainPairing(dir, { relay: true });

  const res = await branchSyncNow(db, {}, REGISTRAR, {
    publishImpl: async () => ({ ok: false, reason: 'relay_offline' }),
    publishJournalImpl: async () => ({ ok: false, reason: 'relay_offline' }),
    fetchJournalsImpl: async () => ({ ok: false, reason: 'relay_offline' }),
  });

  const OFFLINE = 'Нет связи с сервером Easy-Med.';
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'relay_offline');
  assert.equal(res.message, OFFLINE, 'одна причина — одна фраза');
  assert.equal(res.message.split(OFFLINE).length - 1, 1, 'и ровно один раз');
  assert.doesNotMatch(res.message, /Записи/,
    'два нуля рядом с «нет связи» ничего не добавляют: их объясняет сама причина');
  assert.equal(lastAttempt(db).message, res.message, 'экран и кнопка говорят одно и то же');
  db.close();
});

test('но при УДАЧНОМ обмене нули остаются: «получено 0» — это ответ, а не шум', async () => {
  // Обратная сторона правки выше, без которой она была бы просто сокрытием:
  // причины нет, значит спросили и узнали — новых записей у соседей не было.
  const { db, dir } = harness();
  mainPairing(dir, { relay: true });

  const res = await branchSyncNow(db, {}, REGISTRAR, {
    publishImpl: async () => ({ ok: true, bytes: 2048 }),
    publishJournalImpl: async () => ({ ok: true, peers: { B: 0 }, rows: 0 }),
    fetchJournalsImpl: async () => ({ ok: true, peers: { B: { applied: 0 } } }),
  });

  assert.equal(res.ok, true);
  assert.match(res.message, /получено 0, отправлено на сервер 0/,
    'молчание здесь читалось бы как «кнопка ничего не сделала»');
  db.close();
});

test('копия ушла, а чужие записи база ОТВЕРГЛА — это не зелёная галочка', async () => {
  // ok у главной клиники значит «получилось хоть одно из двух дел». Копия
  // справочника ушла — и ok:true, даже когда записи соседа отвергнуты
  // (records_refused: строка потеряна, второй раз её не пришлют). Экран красил
  // такую попытку обычной удачей.
  const { db, dir } = harness();
  mainPairing(dir, { relay: true });

  const res = await branchSyncNow(db, {}, REGISTRAR, {
    publishImpl: async () => ({ ok: true, bytes: 17 * 1024 }),
    publishJournalImpl: async () => ({ ok: true, peers: { B: 2 }, rows: 2 }),
    fetchJournalsImpl: async () => ({ ok: true, peers: { B: { applied: 1, refused: 3 } } }),
  });

  assert.equal(res.ok, true, 'копия и правда ушла — врать в другую сторону тоже нельзя');
  assert.equal(res.records_ok, false, 'а записи — нет, и это отдельная новость');
  assert.equal(res.records.fetch_reason, 'records_refused');
  assert.equal(lastAttempt(db).records_ok, false, 'экран рисует по журналу попыток, а не по ответу RPC');
  db.close();
});

test('удачный обмен помечен records_ok:true — иначе экран ругался бы всегда', async () => {
  const { db, dir } = harness();
  mainPairing(dir, { relay: true });

  const res = await branchSyncNow(db, {}, REGISTRAR, {
    publishImpl: async () => ({ ok: true, bytes: 1024 }),
    publishJournalImpl: async () => ({ ok: true, peers: { B: 1 }, rows: 1 }),
    fetchJournalsImpl: async () => ({ ok: true, peers: { B: { applied: 1 } } }),
  });
  assert.equal(res.records_ok, true);
  db.close();
});

test('«отправлено на сервер» считает РАЗНЫЕ записи, а не сумму по филиалам', async () => {
  // Блоб один, и одна и та же карта пациента едет в нём каждому соседу.
  // Сложив срезы, клиника с двумя филиалами читала «отправлено 24» там, где
  // завела 12 строк, — и рядом честное «получено 5», посчитанное по разным
  // строкам. Число, вдвое больше правды, хуже отсутствующего.
  const { db, dir } = harness();
  mainPairing(dir, { relay: true });

  const res = await branchSyncNow(db, {}, REGISTRAR, {
    publishImpl: async () => ({ ok: true, bytes: 1024 }),
    publishJournalImpl: async () => ({ ok: true, peers: { B: 12, C: 12 }, rows: 12 }),
    fetchJournalsImpl: async () => ({ ok: true, peers: { B: { applied: 3 }, C: { applied: 2 } } }),
  });

  assert.match(res.message, /получено 5/);
  assert.match(res.message, /отправлено на сервер 12/);
  assert.doesNotMatch(res.message, /24/, 'сумма по соседям — это «сколько раз», а не «сколько записей»');
  // Поимённый срез остаётся: он отвечает на другой вопрос — «кому и сколько».
  assert.deepEqual(res.records.published, { B: 12, C: 12 });
  db.close();
});

test('старая выгрузка без rows считается по САМОМУ БОЛЬШОМУ срезу, а не по сумме', async () => {
  // Запасной путь для ответа, пришедшего без rows: самый большой срез — нижняя
  // граница числа разных строк, и соврать в большую сторону она не даст.
  const { db, dir } = harness();
  mainPairing(dir, { relay: true });

  const res = await branchSyncNow(db, {}, REGISTRAR, {
    publishImpl: async () => ({ ok: true, bytes: 1024 }),
    publishJournalImpl: async () => ({ ok: true, peers: { B: 7, C: 4 } }),
    fetchJournalsImpl: async () => ({ ok: true, peers: { B: { applied: 1 } } }),
  });
  assert.match(res.message, /отправлено на сервер 7/);
  db.close();
});

/** Подставной сервер поставщика: считает выгрузки и ничего не отдаёт. */
function fakeVendor() {
  const vendor = { puts: 0 };
  vendor.fetchImpl = async (url, init = {}) => {
    if ((init.method || 'GET') === 'PUT') vendor.puts += 1;
    return { ok: true, status: 200, body: null, arrayBuffer: async () => new ArrayBuffer(0) };
  };
  return vendor;
}

test('нажатие отправляет копию ДАЖЕ при совпавшем хэше — экономия тут не к месту', async () => {
  // Проверка ПРИНУДИТЕЛЬНОСТИ, а не самого факта отправки: фоновый прогон
  // (maybePublish) молчит, пока справочник не изменился, и владелец, поменявший
  // цены и нажавший кнопку, не должен зависеть от того, совпал ли отпечаток.
  // Поэтому здесь отпечаток заранее ПРИВЕДЁН К ТЕКУЩЕМУ — состоянием, в котором
  // фоновая выгрузка заведомо промолчала бы.
  const { db, dir } = harness();
  mainPairing(dir, { relay: true });
  fs.writeFileSync(path.join(dir, 'control.json'),
    JSON.stringify({ clinic_id: 'c-1', install_token: 'tok-AAAA' }));

  const vendor = fakeVendor();
  const opts = { fetchImpl: vendor.fetchImpl, env: {} };

  const first = await maybePublish(db, dir, opts);
  assert.equal(first.ok, true, 'первая выгрузка записывает отпечаток: ' + JSON.stringify(first));
  assert.equal(vendor.puts, 1);

  // Страж на месте: справочник не менялся — фоновый прогон не ходит на сервер.
  const again = await maybePublish(db, dir, opts);
  assert.equal(again.skipped, true, 'иначе тест ниже не доказывал бы ничего');
  assert.equal(vendor.puts, 1);

  const res = await branchSyncNow(db, {}, REGISTRAR, {
    publishImpl: (d, dd) => publishCatalogue(d, dd, opts),
    publishJournalImpl: async () => ({ ok: false, reason: 'relay_no_peers' }),
    fetchJournalsImpl: async () => ({ ok: false, reason: 'relay_no_peers' }),
  });

  assert.equal(vendor.puts, 2, 'кнопка обязана отправить копию поверх совпавшего отпечатка');
  assert.equal(res.reason, 'published');
  assert.match(res.message, /отправлена на сервер/);
  db.close();
});
