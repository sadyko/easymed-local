// LAB_TUBE_LABEL_V1 (решение владельца 2026-11-02) — этикетка на пробирку.
//
// Чистые правила views/lab-tube.js: какие строки визита идут в одну пробирку,
// какой у пробирки номер, что на этикетке написано и в каком поясе время.
//
// Часовой пояс — до первого обращения к Date. На Windows Node понимает только
// имя IANA: POSIX-строку «UZT-5» он молча читает как UTC.
process.env.TZ = 'Asia/Tashkent';

const { default: test } = await import('node:test');
const { default: assert } = await import('node:assert/strict');
const { tubeGroups, tubeDeviceMap, tubeDay, localDay, shortTestName, tubeLabelStamp, TUBE_STATUSES } = await import('../views/lab-tube.js');

const BLOOD = { name: 'Анализ крови', is_lab: 1, specimen: null };
const URINE = { name: 'Анализ мочи', is_lab: 1, specimen: null };
const TODAY = '2026-11-02';
const line = (id, serviceId, services, status = 'queued', extra = {}) => ({
    id, visit_id: 20, service_id: serviceId, status,
    created_at: '2026-11-02T13:50:00Z', scheduled_at: null, sample_collected_at: null,
    services, ...extra,
});
const BC780 = { 40: 3 };   // «Анализ крови» (услуга 40) кормит BC-780 (lab_devices.id = 3); у мочи прибора нет
// Снимок владельца, в порядке очереди (новые первыми): счёт А — № 28 кровь, № 29 моча; счёт Б — № 31, № 32.
const PHOTO = () => [line(32, 41, URINE), line(31, 40, BLOOD), line(29, 41, URINE), line(28, 40, BLOOD)];
const summary = (tubes) => tubes.map((t) => [t.labelId, t.rowIds, t.tests]);

test('снимок владельца: кровь двух счетов — одна пробирка с номером самой старой строки (28); моча без прибора и материала — этикетка на строку', () => {
    const tubes = tubeGroups(PHOTO(), { deviceByService: BC780, today: TODAY });
    assert.deepEqual(summary(tubes), [
        [28, [28, 31], ['Анализ крови']],
        [29, [29], ['Анализ мочи']],
        [32, [32], ['Анализ мочи']],
    ]);
    assert.equal(tubes[0].code, '00000028');
    assert.equal(tubes[0].deviceId, 3);
    assert.ok(!tubes.some((t) => t.rowIds.includes(28) && t.code === '00000032'), 'кровь с номером мочи — ровно ошибка со снимка');
});

test('номер не зависит от порядка выборки', () => {
    const want = summary(tubeGroups(PHOTO(), { deviceByService: BC780, today: TODAY }));
    const rows = PHOTO();
    for (const order of [rows.slice().reverse(), [rows[2], rows[0], rows[3], rows[1]]]) {
        assert.deepEqual(summary(tubeGroups(order, { deviceByService: BC780, today: TODAY })), want);
    }
});

test('строки, добавленные позже, номер этикетки не меняют', () => {
    const later = PHOTO().concat([line(35, 40, BLOOD), line(36, 41, URINE)]);
    const tubes = tubeGroups(later, { deviceByService: BC780, today: TODAY });
    assert.equal(tubes[0].labelId, 28);
    assert.deepEqual(tubes[0].rowIds, [28, 31, 35]);
    assert.deepEqual(tubes.map((t) => t.labelId), [28, 29, 32, 36]);
});

test('без прибора — по материалу (ключ приёма specimenKey); без материала — этикетка на строку', () => {
    const rows = [
        line(10, 1, { name: 'Общий анализ мочи', is_lab: 1, specimen: 'Моча' }),
        line(11, 2, { name: 'Нечипоренко', is_lab: 1, specimen: 'моча (утренняя)' }),
        line(12, 3, { name: 'Глюкоза', is_lab: 1, specimen: 'Сыворотка крови' }),
        line(13, 4, { name: 'Коагулограмма', is_lab: 1, specimen: '' }),
        line(14, 5, { name: 'СОЭ', is_lab: 1, specimen: null }),
    ];
    assert.deepEqual(tubeGroups(rows, { today: TODAY }).map((t) => [t.labelId, t.rowIds, t.material]), [
        [10, [10, 11], 'urine'], [12, [12], 'serum'], [13, [13], ''], [14, [14], ''],
    ]);
});

test('прибор — первый ключ, материал внутри прибора — второй: BS-200 гонит сыворотку и мочу — две пробирки', () => {
    const rows = [
        line(20, 9, { name: 'Биохимия', is_lab: 1, specimen: 'Сыворотка' }),
        line(21, 13, { name: 'Общий анализ мочи', is_lab: 1, specimen: 'Моча' }),
        line(22, 14, { name: 'Креатинин', is_lab: 1, specimen: 'Сыворотка' }),
        line(23, 15, { name: 'Мочевина', is_lab: 1, specimen: 'Сыворотка' }),   // сыворотка, но прибора у услуги нет
    ];
    const tubes = tubeGroups(rows, { deviceByService: { 9: 1, 13: 1, 14: 1 }, today: TODAY });
    assert.deepEqual(tubes.map((t) => [t.labelId, t.rowIds, t.deviceId]), [[20, [20, 22], 1], [21, [21], 1], [23, [23], null]]);
});

test('два прибора — две пробирки, даже при одном материале', () => {
    const rows = [line(30, 40, BLOOD), line(31, 50, { name: 'HbA1c', is_lab: 1, specimen: null })];
    assert.deepEqual(tubeGroups(rows, { deviceByService: { 40: 3, 50: 4 }, today: TODAY }).map((t) => t.labelId), [30, 31]);
});

test('услуга без флага «лабораторная» прибором не группируется: такой заказ приём не заполняет', () => {
    const rows = [line(40, 40, BLOOD), line(41, 60, { name: 'Кровь (отдел)', is_lab: 0, specimen: null })];
    const tubes = tubeGroups(rows, { deviceByService: { 40: 3, 60: 3 }, today: TODAY });
    assert.deepEqual(tubes.map((t) => [t.labelId, t.rowIds, t.deviceId]), [[40, [40], 3], [41, [41], null]]);
});

test('в пробирку — только открытые оплаченные строки; номер — самая старая ОТКРЫТАЯ', () => {
    assert.deepEqual([...TUBE_STATUSES], ['queued', 'collected', 'in_progress', 'resulted']);
    const rows = [
        line(50, 40, BLOOD, 'completed'), line(51, 40, BLOOD, 'added'), line(52, 40, BLOOD, 'cancelled'),
        line(53, 40, BLOOD, 'resulted'), line(54, 40, BLOOD, 'in_progress'), line(55, 40, BLOOD, 'queued'),
    ];
    assert.deepEqual(summary(tubeGroups(rows, { deviceByService: BC780, today: TODAY })), [[53, [53, 54, 55], ['Анализ крови']]]);
    assert.deepEqual(tubeGroups([line(60, 40, BLOOD, 'added'), line(61, 40, BLOOD, 'completed')], { deviceByService: BC780, today: TODAY }), [],
        'клеить нечего — этикеток нет');
});

test('строка «услуга возвращена» (без результата) — не пробирка', () => {
    const tubes = tubeGroups(PHOTO(), { deviceByService: BC780, skipIds: new Set([28]), today: TODAY });
    const blood = tubes.find((t) => t.deviceId === 3);
    assert.deepEqual([blood.labelId, blood.rowIds], [31, [31]]);
});

test('местный день: 00:30 по Ташкенту (19:30 UTC прошлых суток) — уже другой день и другая пробирка', () => {
    assert.equal(localDay('2026-11-01T19:30:00Z'), '2026-11-02');
    assert.equal(localDay('2026-11-01T18:30:00Z'), '2026-11-01');
    assert.equal(localDay('2026-11-02'), '2026-11-02', 'дата без времени — сама собой');
    assert.equal(localDay(''), '');
    assert.equal(localDay('вчера'), '');
    const rows = [
        line(70, 40, BLOOD, 'queued', { created_at: '2026-11-01T18:30:00Z' }),   // 1 ноября, 23:30
        line(71, 40, BLOOD, 'queued', { created_at: '2026-11-01T19:30:00Z' }),   // 2 ноября, 00:30
        line(72, 40, BLOOD, 'queued', { created_at: '2026-11-02T06:00:00Z' }),   // 2 ноября, 11:00
    ];
    assert.deepEqual(tubeGroups(rows, { deviceByService: BC780, today: TODAY }).map((t) => t.rowIds), [[70], [71, 72]]);
});

test('день строки — как у приёма (orderAge): позднейшее из «создана», «записана», «день визита», не позже сегодня', () => {
    const visitDate = '2026-11-02T04:00:00Z';
    const ahead = line(80, 40, BLOOD, 'queued', { created_at: '2026-10-30T10:00:00Z' });   // запись колл-центра: строка заведена заранее
    const desk = line(81, 40, BLOOD, 'queued', { created_at: '2026-11-02T06:00:00Z' });    // добавлена в день визита
    assert.equal(tubeDay(ahead, { visitDate, today: TODAY }), TODAY);
    assert.deepEqual(tubeGroups([ahead, desk], { deviceByService: BC780, visitDate, today: TODAY }).map((t) => t.rowIds), [[80, 81]]);
    // Запись на завтра день строки вперёд не двигает.
    assert.equal(tubeDay(line(82, 40, BLOOD, 'queued', { scheduled_at: '2026-11-03T05:00:00Z' }), { visitDate, today: TODAY }), TODAY);
    // Долгий (стационарный) визит: забытый открытый ОАК трёхдневной давности — своя пробирка;
    // номер сегодняшней пробирки — сегодняшняя строка, а не он.
    const old = line(78, 40, BLOOD, 'queued', { created_at: '2026-10-30T06:00:00Z' });
    assert.deepEqual(tubeGroups([old, desk], { deviceByService: BC780, visitDate: '2026-10-28T06:00:00Z', today: TODAY }).map((t) => t.labelId), [78, 81]);
});

test('прибор услуги — панель услуги, как у приёма (активная, первая по номеру); панель без прибора — null', () => {
    const map = tubeDeviceMap([
        { id: 9, service_id: 40, device_id: 3 },
        { id: 5, service_id: 41, device_id: null },
        { id: 12, service_id: 40, device_id: 4 },
        { id: 2, service_id: 42, device_id: 5, active: 0 },
    ]);
    assert.deepEqual(map, { 40: 3, 41: null });
});

test('короткое название: сокращение из имени, иначе из скобок, иначе имя до 18 знаков', () => {
    const cases = [
        ['Анализ крови', 'Анализ крови'],
        ['Общий анализ крови (ОАК, клинический анализ крови без лейкоцитарной формулы)', 'ОАК'],
        ['Скорость оседания эритроцитов (СОЭ, РОЭ, ESR)', 'СОЭ'],
        ['Антимюллеров гормон АМГ (ИФА)', 'АМГ'],
        ['Гемоглобин (Hb, гемоглобин крови)', 'Hb'],
        ['Тиреотропный гормон  ТТГ  (TSH)', 'ТТГ'],
        ['Витамин D (25-OH витамин D, кальциферол)', 'Витамин D (25-OH…'],
        ['Время свертываемости крови (Корел)', 'Время свертываемо…'],
        ['', ''], [null, ''],
    ];
    for (const [name, want] of cases) assert.equal(shortTestName(name), want, String(name));
});

test('время на этикетке — местное, числом: 14:06 UTC — «02.11.2026, 19:06»', () => {
    assert.equal(tubeLabelStamp('2026-11-02T14:06:00Z'), '02.11.2026, 19:06');
    assert.equal(tubeLabelStamp(null, new Date('2026-11-02T14:06:00Z')), '02.11.2026, 19:06', 'забора нет — время печати, тоже местное');
    const tubes = tubeGroups([
        line(90, 40, BLOOD, 'collected', { sample_collected_at: '2026-11-02T14:20:00Z' }),
        line(91, 40, BLOOD, 'collected', { sample_collected_at: '2026-11-02T14:06:00Z' }),
    ], { deviceByService: BC780, today: TODAY });
    assert.equal(tubes[0].collectedAt, '2026-11-02T14:06:00Z', 'время пробирки — первый забор');
});
