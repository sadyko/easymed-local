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
const { tubeGroups, tubeDeviceMap, tubeDay, localDay, shortTestName, tubeLabelStamp, TUBE_STATUSES, tubeRecent, BARE_ID_MAX_AGE_DAYS } = await import('../views/lab-tube.js');

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
    // Ревью U11, M1: № 55 ещё ждёт забора, а № 53 и № 54 уже взяты — № 55 своя пробирка (новый забор).
    assert.deepEqual(summary(tubeGroups(rows, { deviceByService: BC780, today: TODAY })), [
        [53, [53, 54], ['Анализ крови']],
        [55, [55], ['Анализ крови']],
    ]);
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

test('короткое название: сокращение из имени, иначе из скобок, иначе имя до скобок или до 18 знаков', () => {
    const cases = [
        ['Анализ крови', 'Анализ крови'],
        ['Общий анализ крови (ОАК, клинический анализ крови без лейкоцитарной формулы)', 'ОАК'],
        ['Скорость оседания эритроцитов (СОЭ, РОЭ, ESR)', 'СОЭ'],
        ['Антимюллеров гормон АМГ (ИФА)', 'АМГ'],
        ['Гемоглобин (Hb, гемоглобин крови)', 'Hb'],
        ['Тиреотропный гормон  ТТГ  (TSH)', 'ТТГ'],
        // Ревью U11, L3: имя до скобок помещается — оно и есть (было «Витамин D (25-OH…»).
        ['Витамин D (25-OH витамин D, кальциферол)', 'Витамин D'],
        ['Время свертываемости крови (Корел)', 'Время свертываемо…'],
        ['', ''], [null, ''],
    ];
    for (const [name, want] of cases) assert.equal(shortTestName(name), want, String(name));
});

// Ревью U11, L3 (проба p4): короткое имя бралось у метода или у части анализа:
// «… методом ИХЛА» → «ИХЛА», «Коагулограмма (ПТИ, МНО, …)» → «ПТИ», «Т4 свободный
// (Free T4) …» → «Т4», любое «… (ИФА)» длиннее 18 знаков → «ИФА», «На …» — сокращение.
test('ревью U11, L3: метод (ИХЛА, ИФА, ПЦР…), состав панели и обычное слово — не короткое имя анализа', () => {
    const cases = [
        ['Ферритин в сыворотке крови методом ИХЛА', 'Ферритин в сыворо…'],
        ['Коагулограмма (ПТИ, МНО, АЧТВ, фибриноген)', 'Коагулограмма'],
        ['Липидограмма (ХС, ТГ, ЛПВП, ЛПНП, индекс атерогенности)', 'Липидограмма'],
        ['Т4 свободный (Free T4) в крови', 'Т4 свободный'],
        ['ПСА общий (простатспецифический антиген)', 'ПСА общий'],
        ['Пролактин в крови (ИФА)', 'Пролактин в крови'],
        ['Антитела к вирусу гепатита C (ИФА)', 'Антитела к вирусу…'],
        ['Вирус папилломы человека (ПЦР)', 'Вирус папилломы ч…'],
        ['На скрытую кровь в кале, количественно', 'На скрытую кровь…'],
        // сокращение САМОГО анализа по-прежнему берётся
        ['С-реактивный белок (СРБ) количественно', 'СРБ'],
        ['Хорионический гонадотропин (ХГЧ)', 'ХГЧ'],
        ['Антитела к ТПО в крови (ИФА)', 'ТПО'],
        ['Гликированный гемоглобин HbA1c', 'HbA1c'],
        ['Общий анализ крови (ОАК, CBC) с лейкоформулой', 'ОАК'],
        ['ТТГ (тиреотропный гормон, третье поколение)', 'ТТГ'],
    ];
    for (const [name, want] of cases) assert.equal(shortTestName(name), want, name);
});

// Ревью U11, M1 (проба P2k): «Биохимия» утром взята и посчитана (не выдана), вечером
// врач назначил «Электролиты» на тот же BS-200 — новый забор. Одна пробирка на обе
// давала вечерней пробирке номер утренней строки, и вечерний калий перезаписывал
// утренний черновик. Теперь «уже взята» — часть ключа: строка, которая ещё ждёт
// забора, не делит пробирку со взятыми — у неё своя этикетка. Анализ, добавленный
// ДО забора, по-прежнему в той же пробирке и номер не меняет.
test('ревью U11, M1: строка, ждущая забора, не делит пробирку со взятыми; до забора — одна пробирка, номер прежний', () => {
    const BIO = { name: 'Биохимия', is_lab: 1, specimen: 'Сыворотка' };
    const ELY = { name: 'Электролиты', is_lab: 1, specimen: 'Сыворотка' };
    const BS200 = { 9: 1, 14: 1 };
    // Утро взято (resulted), вечер ждёт забора: две пробирки, у вечерней — свой номер.
    const evening = tubeGroups([line(66, 14, ELY, 'queued'), line(60, 9, BIO, 'resulted')], { deviceByService: BS200, today: TODAY });
    assert.deepEqual(evening.map((t) => [t.labelId, t.rowIds, t.drawn]), [[60, [60], true], [66, [66], false]]);
    // Обе ещё ждут забора — одна пробирка, номер самой старой (анализ добавили до забора).
    const before = tubeGroups([line(66, 14, ELY, 'queued'), line(60, 9, BIO, 'queued')], { deviceByService: BS200, today: TODAY });
    assert.deepEqual(before.map((t) => [t.labelId, t.rowIds]), [[60, [60, 66]]]);
    // Взятые вместе (проба взята, в работе, результаты внесены) — одна пробирка.
    const drawn = tubeGroups([line(66, 14, ELY, 'collected'), line(60, 9, BIO, 'in_progress'), line(61, 9, BIO, 'resulted')], { deviceByService: BS200, today: TODAY });
    assert.deepEqual(drawn.map((t) => [t.labelId, t.rowIds]), [[60, [60, 61, 66]]]);
    // Без прибора, по материалу — то же правило; без материала — своя этикетка у строки, как было.
    const URINE_M = { name: 'Общий анализ мочи', is_lab: 1, specimen: 'Моча' };
    const byMaterial = tubeGroups([line(12, 13, URINE_M, 'queued'), line(11, 13, URINE_M, 'collected'), line(10, 13, URINE_M, 'collected')], { today: TODAY });
    assert.deepEqual(byMaterial.map((t) => [t.labelId, t.rowIds]), [[10, [10, 11]], [12, [12]]]);
});

// Ревью U11, L6: голый номер заказа старше 7 дней приём отказывает («старше 7 дней»,
// bareIdRefusal) — карточка такую пробирку не печатает. Срок — одна константа с
// приёмом (shared/lab-label-age.js), а не своё число.
test('ревью U11, L6: пробирка «свежая», пока приём примет её номер: день не раньше, чем 7 дней назад (как orderAge)', () => {
    assert.equal(BARE_ID_MAX_AGE_DAYS, 7);
    assert.equal(tubeRecent('2026-11-02', TODAY), true, 'сегодня');
    assert.equal(tubeRecent('2026-10-26', TODAY), true, 'ровно 7 дней — ещё принимается (day >= today − 7)');
    assert.equal(tubeRecent('2026-10-25', TODAY), false, '8 дней — уже нет');
    assert.equal(tubeRecent('', TODAY), false, 'день не известен — приём тоже отказывает');
    assert.equal(tubeRecent('2026-02-22', '2026-03-01'), true, 'через конец февраля — календарём');
    assert.equal(tubeRecent('2026-02-21', '2026-03-01'), false);
    const tubes = tubeGroups([
        line(31, 40, BLOOD, 'queued', { created_at: '2026-11-02T06:00:00Z' }),
        line(28, 40, BLOOD, 'queued', { created_at: '2026-10-24T06:00:00Z' }),   // стационар: забытая строка 9 дней назад
    ], { deviceByService: BC780, visitDate: '2026-10-24T05:00:00Z', today: TODAY });
    assert.deepEqual(tubes.map((t) => [t.labelId, t.day, t.recent]), [[28, '2026-10-24', false], [31, '2026-11-02', true]]);
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

// ═══ LAB_ONE_BARCODE_V1 (решение владельца 2026-11-07, п. 10) — один номер на день визита ═══
const { dayLabels } = await import('../views/lab-tube.js');

test('LAB_ONE_BARCODE_V1: один номер на день — 90000000 + самая старая открытая строка дня; копий — по числу пробирок', () => {
    const [d, ...more] = dayLabels(PHOTO(), { deviceByService: BC780, today: TODAY });
    assert.equal(more.length, 0, 'день один');
    assert.equal(d.code, '90000028');
    assert.equal(d.lineId, 28);
    assert.equal(d.copies, 3, 'кровь двух счетов — одна пробирка, моча — две');
    assert.deepEqual(d.rowIds, [28, 29, 31, 32]);
    assert.deepEqual(d.tests, ['Анализ крови', 'Анализ мочи']);
    assert.equal(d.recent, true);
});

test('LAB_ONE_BARCODE_V1: строка, добавленная позже, номер дня не меняет; возвращённая строка номера не даёт', () => {
    const later = PHOTO().concat([line(35, 40, BLOOD)]);
    assert.equal(dayLabels(later, { deviceByService: BC780, today: TODAY })[0].code, '90000028');
    assert.equal(dayLabels(PHOTO(), { deviceByService: BC780, today: TODAY, skipIds: new Set([28]) })[0].code, '90000029');
});

test('LAB_ONE_BARCODE_V1: стационар — свой номер на каждый день; строка не помещается — номера дня нет (прежние этикетки пробирок)', () => {
    const days = dayLabels([
        line(50, 40, BLOOD, 'queued', { created_at: '2026-11-01T06:00:00Z' }),
        line(60, 40, BLOOD, 'queued'),
    ], { deviceByService: BC780, today: TODAY, visitDate: '2026-11-01T06:00:00Z' });
    assert.deepEqual(days.map((d) => [d.day, d.code]), [['2026-11-01', '90000050'], ['2026-11-02', '90000060']]);
    const big = dayLabels([line(12345678, 40, BLOOD)], { deviceByService: BC780, today: TODAY });
    assert.equal(big[0].code, '');
    assert.equal(big[0].tubes[0].code, '12345678');
});

// Ревью S3, M-2 — второй забор того же анализа в тот же день (утренняя проба уже
// взята, вечерняя ждёт): по общему номеру дня приём не знает, в который из двух
// открытых заказов писать, и отказывает («неоднозначно»). Пробирке повторного
// забора — этикетка строки (номер заказа): приём ведёт её точно, прежним путём.
test('ревью M-2: повторный забор того же анализа в другой пробирке — у неё своя этикетка строки, номер дня остальным', () => {
    const rows = [
        line(100, 40, BLOOD, 'collected', { sample_collected_at: '2026-11-02T06:00:00Z' }),
        line(101, 41, URINE, 'queued'),
        line(106, 40, BLOOD, 'queued'),
    ];
    const [d, ...more] = dayLabels(rows, { deviceByService: BC780, today: TODAY });
    assert.equal(more.length, 0);
    assert.equal(d.code, '90000100');
    assert.equal(d.copies, 2, 'утренняя кровь и моча — номер дня');
    assert.deepEqual(d.own.map((o) => [o.code, o.why, o.tests]), [['00000106', 'repeat', ['Анализ крови']]]);
    assert.deepEqual(d.own[0].rowIds, [106]);
});

test('ревью M-2: два одинаковых анализа в ОДНОЙ пробирке (оба ждут забора) — отдельной этикетки нет; без прибора — правило не нужно', () => {
    const same = dayLabels([line(100, 40, BLOOD), line(106, 40, BLOOD)], { deviceByService: BC780, today: TODAY })[0];
    assert.deepEqual([same.code, same.copies, same.own], ['90000100', 1, []]);
    const noDevice = dayLabels([line(100, 40, BLOOD, 'collected'), line(106, 40, BLOOD)], { deviceByService: {}, today: TODAY })[0];
    assert.deepEqual([noDevice.copies, noDevice.own], [2, []], 'анализ без прибора приём не заполняет — номер дня, как был');
});
