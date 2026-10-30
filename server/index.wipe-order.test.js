// TEST_DATA_WIPE_V1 — место удаления тестовых данных в запуске. Удалению нужна
// открытая база с текущей схемой (после migrate), и оно обязано закончиться
// раньше всего, что пишет или читает визиты и деньги. Запуск целиком (isMain)
// в тесте не поднять — он слушает порт и опрашивает Telegram, — поэтому
// порядок проверяется по тексту server/index.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8');
const at = (needle) => {
  const i = src.indexOf(needle);
  assert.notEqual(i, -1, `в server/index.js нет «${needle}»`);
  return i;
};

test('удаление — после processPendingAction, openDb и migrate', () => {
  const wipe = at('applyPendingTestDataWipe(db, DATA_DIR)');
  for (const before of ['processPendingAction(DATA_DIR)', "openDb(path.join(DATA_DIR, 'easymed.db'))", 'migrate(db);']) {
    assert.ok(at(before) < wipe, `${before} — раньше удаления`);
  }
});

test('удаление — раньше исправлений CRM, ботов, опросов, анализаторов и listen', () => {
  const wipe = at('applyPendingTestDataWipe(db, DATA_DIR)');
  for (const after of ['crmUnifyRepair(db)', 'scheduleCrmNoShow(db)', 'startTelegramBot(db)', 'startDoctorBot(db)',
    'schedulePolling(db)', 'scheduleMetaPolling(db)', 'startLisListeners(db)', '.listen(PORT', 'scheduleDailyBackups(db, DATA_DIR)',
    'scheduleBranchPull(db', 'schedulePublicSync(db, DATA_DIR)',
    // ревью C2/C3 — и всё прочее, что трогает базу после миграций
    'crmOneWayRepair(db)', 'bootstrapAdmin(db)', 'scheduleCrmTaskRehome(db)', 'createApp(db', 'scheduleCheckin(db, DATA_DIR)',
    'scheduleUpdater(db, DATA_DIR', 'scheduleRelayPublish(db, DATA_DIR)', 'scheduleLivePull(db, DATA_DIR)']) {
    assert.ok(wipe < at(after), `${after} — после удаления`);
  }
});

// Ревью C3: удаление (и его повтор после сбоя) идёт ТОЛЬКО в этой точке
// запуска, до listen. Повтор после listen снёс бы настоящие визиты и
// документы, загруженные после удаления (removeVisitDocFiles).
test('вызов один, прямо в теле запуска — не в обработчике, таймере или запросе', () => {
  const calls = src.match(/applyPendingTestDataWipe\(/g) || [];
  assert.equal(calls.length, 1, 'ровно один вызов (импорт — без скобок)');
  assert.match(src, /\n {2}const testDataWipe = applyPendingTestDataWipe\(db, DATA_DIR\);\n/,
    'отступ два пробела — прямо в блоке if (isMain), а не во вложенной функции');
});

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') yield* walk(p); }
    else if (e.name.endsWith('.js') && !/\.test\./.test(e.name)) yield p;
  }
}

test('удаляющие функции больше никто не зовёт: ни RPC, ни таймеры, ни маршруты', () => {
  const own = path.join(HERE, 'services', 'test-data-wipe.js');
  // Вызов — имя и скобка; упоминание в комментарии вызовом не считается.
  const CALL = /\b(applyPendingTestDataWipe|runTestDataWipe|wipeTestData|removeVisitDocFiles|vacuumAfterWipe)\s*\(/;
  const bad = [];
  for (const f of walk(HERE)) {
    if (f === own) continue;
    const text = fs.readFileSync(f, 'utf8');
    if (!CALL.test(text)) continue;
    const rel = path.relative(HERE, f).split(path.sep).join('/');
    if (rel === 'index.js') continue;   // единственный вызов — проверен выше
    bad.push(rel + ': ' + text.match(CALL)[1]);
  }
  assert.deepEqual(bad, []);
  // Внутри модуля файлы документов удаляет только полное удаление, а его зовёт
  // только запуск (вызовы — без объявлений «function имя(»).
  const mod = fs.readFileSync(own, 'utf8');
  const calls = (name) => (mod.match(new RegExp(`(?<!function )\\b${name}\\(`, 'g')) || []).length;
  assert.equal(calls('removeVisitDocFiles'), 1, 'removeVisitDocFiles — только из runTestDataWipe');
  assert.equal(calls('runTestDataWipe'), 1, 'runTestDataWipe — только из applyPendingTestDataWipe');
  assert.equal(calls('wipeTestData'), 1, 'wipeTestData — только из runTestDataWipe');
  assert.equal(calls('applyPendingTestDataWipe'), 0, 'applyPendingTestDataWipe сам себя не зовёт');
});
