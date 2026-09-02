// BRANCH_SYNC_HOURLY_V1 — часы, забирающие обновления раз в час.
//
// Проверяется не «setInterval вызывается», а четыре свойства, каждое из
// которых легко потерять при следующей правке и каждое из которых стоило бы
// клинике работы:
//   1. главная клиника не тянет ни у кого (тянуть не у кого, и лишний запрос
//      раз в час с каждой главной установки — это нагрузка на ровном месте);
//   2. роль перечитывается КАЖДЫЙ такт: установку связывают филиалом без
//      перезапуска сервера, и часы обязаны это заметить сами;
//   3. упавшая синхронизация не роняет часы и не всплывает наружу — сети может
//      не быть, это норма, а не авария;
//   4. такты не накладываются: два одновременных применения справочника — это
//      гонка за одни и те же таблицы.
import test from 'node:test';
import assert from 'node:assert/strict';

import { scheduleBranchPull } from './schedule-pull.js';

const tick = (ms) => new Promise((r) => setTimeout(r, ms));
const FAST = { initialDelayMs: 5, intervalMs: 10 };

test('главная клиника не забирает ничего', async () => {
  let calls = 0;
  const clock = scheduleBranchPull({}, {
    ...FAST,
    isSecondary: () => false,
    syncImpl: async () => { calls += 1; },
  });
  await tick(40);
  clock.stop();
  assert.equal(calls, 0, 'у главной клиники нет источника, откуда тянуть');
});

test('филиал забирает по расписанию, а не один раз', async () => {
  let calls = 0;
  const clock = scheduleBranchPull({}, {
    ...FAST,
    isSecondary: () => true,
    syncImpl: async () => { calls += 1; },
  });
  await tick(45);
  clock.stop();
  assert.ok(calls >= 2, 'должно быть несколько прогонов, получено: ' + calls);
});

test('роль перечитывается каждый такт — связали филиалом, перезапуск не нужен', async () => {
  let secondary = false;
  let calls = 0;
  const clock = scheduleBranchPull({}, {
    ...FAST,
    isSecondary: () => secondary,
    syncImpl: async () => { calls += 1; },
  });
  await tick(25);
  assert.equal(calls, 0, 'пока установка не филиал — не тянет');

  // Администратор связал установку филиалом. Сервер НЕ перезапускали.
  secondary = true;
  await tick(35);
  clock.stop();
  assert.ok(calls >= 1, 'часы заметили новую роль сами, получено: ' + calls);
});

test('упавшая синхронизация не роняет часы и не всплывает наружу', async () => {
  let calls = 0;
  const clock = scheduleBranchPull({}, {
    ...FAST,
    isSecondary: () => true,
    syncImpl: async () => { calls += 1; throw new Error('нет связи'); },
  });
  await tick(45);
  clock.stop();
  // Сети может не быть — это норма. Часы обязаны пережить отказ и попробовать
  // снова, а не остановиться после первого.
  assert.ok(calls >= 2, 'после отказа часы продолжают идти, получено: ' + calls);
});

test('такты не накладываются', async () => {
  let running = 0;
  let overlapped = false;
  const clock = scheduleBranchPull({}, {
    ...FAST,
    isSecondary: () => true,
    syncImpl: async () => {
      running += 1;
      if (running > 1) overlapped = true;
      // Длиннее интервала: следующий такт наступит, пока этот ещё работает.
      await tick(30);
      running -= 1;
    },
  });
  await tick(70);
  clock.stop();
  assert.equal(overlapped, false, 'два применения справочника одновременно — гонка за одни таблицы');
});

test('stop останавливает часы', async () => {
  let calls = 0;
  const clock = scheduleBranchPull({}, {
    ...FAST,
    isSecondary: () => true,
    syncImpl: async () => { calls += 1; },
  });
  await tick(25);
  clock.stop();
  const after = calls;
  await tick(30);
  assert.equal(calls, after, 'после stop не должно быть новых прогонов');
});
