// DISK_GUARD_V1 (docs/specs/2026-10-29-3181-cabinet-print-disk-design.md, раздел 3,
// п. 2, 3, 5 и 8) — чистые решения карточки «Место на диске» и колокола
// администратора: что показать, что красным, о чём звонить. Без DOM и без
// i18n.js — подписи проверяются русским исходником (перевод — в h()), а
// десятичный знак — по языку экрана (ru и uz — запятая, en — точка).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diskUsageView, diskNotices } from '../system-logic.js';

const GB = 1024 ** 3;
const MB = 1024 ** 2;

test('diskUsageView: что сколько занимает — в порядке экрана, «свободно» из всего диска', () => {
  const v = diskUsageView({
    db_bytes: 2 * GB, backups_bytes: 30 * GB, storage_bytes: 5 * GB, versions_bytes: 110 * MB,
    free_bytes: 300 * GB, total_bytes: 1000 * GB, low: false,
  });
  assert.deepEqual(v.rows, [
    { label: 'База данных', value: '2 ГБ' },
    { label: 'Резервные копии', value: '30 ГБ' },
    { label: 'Файлы (сканы и документы)', value: '5 ГБ' },
    { label: 'Версии программы', value: '110 МБ' },
    { label: 'Свободно', value: '300 ГБ из 1000 ГБ' },
  ]);
  assert.deepEqual(v.warnings, []);
  assert.equal(v.low, false);
});

test('diskUsageView: из исходников версий нет — строки нет, а не «0 Б»', () => {
  const v = diskUsageView({ db_bytes: 1024, backups_bytes: 0, storage_bytes: 0, versions_bytes: null, free_bytes: 300 * GB, total_bytes: 1000 * GB });
  assert.deepEqual(v.rows.map((r) => r.label), ['База данных', 'Резервные копии', 'Файлы (сканы и документы)', 'Свободно']);
});

test('diskUsageView: папку сосчитали не до конца — «не меньше», а не точное число', () => {
  const v = diskUsageView({ db_bytes: GB, storage_bytes: 120 * GB, partial: ['storage_bytes'], free_bytes: 300 * GB, total_bytes: 1000 * GB });
  assert.deepEqual(v.rows.find((r) => r.label === 'Файлы (сканы и документы)'), { label: 'Файлы (сканы и документы)', value: '≥ 120 ГБ' });
  assert.deepEqual(v.rows.find((r) => r.label === 'База данных'), { label: 'База данных', value: '1 ГБ' });
});

test('diskUsageView: мало места, отказ в копии, ручные копии сверх предела — три красные строки', () => {
  const v = diskUsageView({
    free_bytes: 3 * GB, total_bytes: 100 * GB, low: true,
    copy_refused: { at: '2026-10-29T03:05:00.000Z', kind: 'daily', need_bytes: 3 * GB + 300 * MB, free_bytes: 3 * GB },
    kept_over_cap: { at: '2026-10-29T03:05:00.000Z', bytes: 40 * GB, cap_bytes: 30 * GB },
  });
  assert.deepEqual(v.warnings, [
    'Мало места на диске: свободно 3 ГБ. Освободите место, иначе копии базы и обновления перестанут делаться.',
    'Недостаточно места на диске: нужно 3,3 ГБ, свободно 3,0 ГБ. Копия не сделана.',
    'Ручные копии и копии перед удалением данных занимают 40 ГБ — больше 30 % диска. Сами они не удаляются.',
  ]);
  assert.equal(v.low, true);
});

test('diskUsageView: обновление не поставилось из-за места — с числами, а без чисел — общей фразой', () => {
  const withNumbers = diskUsageView({
    free_bytes: 20 * GB, total_bytes: 100 * GB, low: false,
    update_refused: { at: '2026-10-29T03:05:00.000Z', version: '3.18.1', need_bytes: 2 * GB + 1, free_bytes: GB },
  });
  assert.deepEqual(withNumbers.warnings, [
    'Обновление 3.18.1 не установлено — недостаточно места: нужно 2,1 ГБ, свободно 1,0 ГБ. Освободите место, и мы попробуем снова.',
  ]);
  // Диск заполнился посреди копии перед обновлением — чисел нет (updater.js).
  const noNumbers = diskUsageView({ update_refused: { version: '3.18.1', need_bytes: null, free_bytes: null } });
  assert.deepEqual(noNumbers.warnings, [
    'Обновление 3.18.1 не установлено — на диске не хватило места. Освободите место, и мы попробуем снова.',
  ]);
  assert.deepEqual(diskUsageView({ update_refused: { need_bytes: GB, free_bytes: GB } }).warnings, [], 'без версии отметка не правда — сервер такую снимает');
});

test('diskUsageView: английский экран — точка в гигабайтах, а не запятая', () => {
  const en = (s) => ({
    'Недостаточно места на диске: нужно {need} ГБ, свободно {free} ГБ. Копия не сделана.': 'Not enough disk space: {need} GB needed, {free} GB free. The backup was not made.',
    'ГБ': 'GB',
  }[s] || s);
  const v = diskUsageView({
    free_bytes: 3 * GB + 300 * MB, total_bytes: 1000 * GB, low: true,
    copy_refused: { need_bytes: 3 * GB + 300 * MB, free_bytes: 3 * GB },
  }, en, 'en');
  assert.match(v.warnings[0], /свободно 3\.3 GB\./);
  assert.equal(v.warnings[1], 'Not enough disk space: 3.3 GB needed, 3.0 GB free. The backup was not made.');
  assert.equal(v.rows[0].value, '3.3 GB из 1000 GB');
  assert.equal(diskUsageView({ free_bytes: 3 * GB + 300 * MB, total_bytes: 1000 * GB }).rows[0].value, '3,3 ГБ из 1000 ГБ', 'русский — с запятой');
});

test('diskUsageView: пустой или чужой ответ — ни строк, ни выдуманных предупреждений', () => {
  for (const bad of [null, undefined, {}, 'x', { free_bytes: 'много', low: true }, { copy_refused: { need_bytes: 'x' } }]) {
    const v = diskUsageView(bad);
    assert.deepEqual(v.rows, [], JSON.stringify(bad));
    assert.deepEqual(v.warnings, [], JSON.stringify(bad));
  }
});

test('diskNotices: отказ в копии — красное уведомление с числами; оно важнее «мало места»', () => {
  const n = diskNotices({
    low: true, free_bytes: GB, total_bytes: 100 * GB,
    copy_refused: { at: '2026-10-29T03:05:00.000Z', kind: 'daily', need_bytes: 2 * GB, free_bytes: GB },
  });
  assert.deepEqual(n, [{
    id: 'disk-copy', sev: 'danger', icon: 'Database',
    title: 'Резервная копия не сделана',
    message: 'Недостаточно места на диске: нужно 2,0 ГБ, свободно 1,0 ГБ. Копия не сделана.',
  }]);
});

test('diskNotices: только мало места — жёлтое уведомление', () => {
  assert.deepEqual(diskNotices({ low: true, free_bytes: 4 * GB, total_bytes: 100 * GB, copy_refused: null }), [{
    id: 'disk-low', sev: 'warn', icon: 'Warning',
    title: 'Мало места на диске',
    message: 'Свободно 4 ГБ из 100 ГБ. Освободите место, иначе копии базы и обновления перестанут делаться.',
  }]);
});

test('diskNotices: обновление не поставилось — своё уведомление, id с версией (новая версия — новое уведомление)', () => {
  assert.deepEqual(diskNotices({
    low: true, free_bytes: GB, total_bytes: 100 * GB,
    update_refused: { version: '3.18.1', need_bytes: null, free_bytes: null },
  }), [{
    id: 'disk-update:3.18.1', sev: 'warn', icon: 'Download',
    title: 'Нет места для обновления',
    message: 'Обновление 3.18.1 не установлено — на диске не хватило места. Освободите место, и мы попробуем снова.',
  }]);
});

test('diskNotices: ручные копии одни больше 30 % — только в колоколе, без полосы поперёк экрана', () => {
  assert.deepEqual(diskNotices({
    low: false, free_bytes: 300 * GB, total_bytes: 1000 * GB,
    kept_over_cap: { bytes: 400 * GB, cap_bytes: 300 * GB },
  }), [{
    id: 'disk-kept', sev: 'warn', icon: 'Database', bellOnly: true,
    title: 'Копии занимают много места',
    message: 'Ручные копии и копии перед удалением данных занимают 400 ГБ — больше 30 % диска. Сами они не удаляются.',
  }]);
});

test('diskNotices: места хватает или ответа нет — тишина', () => {
  assert.deepEqual(diskNotices({ low: false, free_bytes: 300 * GB, total_bytes: 1000 * GB }), []);
  assert.deepEqual(diskNotices(null), []);
  assert.deepEqual(diskNotices({ copy_refused: { need_bytes: 'x' } }), []);
});
