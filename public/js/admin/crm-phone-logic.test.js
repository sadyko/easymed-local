// CRM_PHONE_V1 (2026-10-17) — решения панели «Телефон» без DOM: набранное, группы по
// дням, фильтры журнала, исход звонка, «только что звонили», совпадение набранного
// со строкой журнала. Стенда с поддельным DOM здесь нет намеренно: это те части,
// которые стоит проверять на граничных значениях, а не на отрисовке.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanTyped, groupTyped, canDial, dayGroup, groupCalls, timeLabel, outcomeOf, talkLabel,
         filterCalls, justCalled, matchDialed, initialsOf, whoIs, JUST_CALLED_MS } from './crm-phone-logic.js';

test('набранное: цифры, * и #, плюс только ведущий; показ группами по три', () => {
  assert.equal(cleanTyped('+99(8) 90-12+34'), '+998901234');
  assert.equal(cleanTyped('99+8'), '998');
  assert.equal(cleanTyped('*12#'), '*12#');
  assert.equal(groupTyped('998901234567'), '998 901 234 567');
  assert.equal(groupTyped('+9989012'), '+998 901 2');
  assert.equal(groupTyped(''), '');
  assert.equal(canDial('901234'), false, 'шесть цифр — ещё не номер');
  assert.equal(canDial('9012345'), true);
  assert.equal(canDial('+998 90 123 45 67'), true);
});

test('группы по ЛОКАЛЬНЫМ дням: сегодня, вчера, ранее; порядок и пропуск пустых', () => {
  const now = new Date(2026, 9, 17, 10, 0, 0);
  const at = (d, h) => new Date(2026, 9, d, h, 0, 0).toISOString();
  assert.equal(dayGroup(at(17, 0), now), 'today');
  assert.equal(dayGroup(at(16, 23), now), 'yesterday');
  assert.equal(dayGroup(at(15, 23), now), 'earlier');
  assert.equal(dayGroup('мусор', now), 'earlier');
  const g = groupCalls([{ started_at: at(15, 9) }, { started_at: at(17, 9) }, { started_at: at(17, 8) }], now);
  assert.deepEqual(g.map((x) => [x.key, x.rows.length]), [['today', 2], ['earlier', 1]]);
  assert.equal(timeLabel(at(17, 9), now), '09:00');
  assert.equal(timeLabel(at(16, 9), now), '16.10 09:00');
  assert.equal(timeLabel('мусор', now), '—');
});

test('исход звонка — словами клиники, по направлению и разговору', () => {
  assert.deepEqual(outcomeOf({ call_type: 0, billsec: 42 }), { out: false, answered: true, kind: 'in', word: 'Отвечен', icon: 'PhoneIn' });
  assert.deepEqual(outcomeOf({ call_type: 0, billsec: 0, disposition: 'NOANSWER' }), { out: false, answered: false, kind: 'miss', word: 'Пропущен', icon: 'PhoneMissed' });
  assert.deepEqual(outcomeOf({ call_type: 1, billsec: 96 }), { out: true, answered: true, kind: 'out', word: 'Отвечен', icon: 'PhoneOut' });
  assert.equal(outcomeOf({ call_type: 1, billsec: 0, disposition: 'BUSY' }).word, 'Абонент занят');
  assert.equal(outcomeOf({ call_type: 1, billsec: 0, disposition: '' }).word, 'Без ответа');
  assert.equal(outcomeOf({ call_type: '1', billsec: '0', disposition: 'CANCEL' }).word, 'Отменён');
  assert.equal(talkLabel(96), '1:36');
  assert.equal(talkLabel(0), '—');
  assert.equal(talkLabel(null), '—');
});

const CALLS = [
  { id: 1, call_type: 0, billsec: 42, external_number: '998901112233', patient_name: 'Каримова Азиза', started_at: '2026-10-17T05:00:00Z' },
  { id: 2, call_type: 0, billsec: 0,  external_number: '998935550112', patient_name: null,            started_at: '2026-10-17T05:01:00Z' },
  { id: 3, call_type: 1, billsec: 96, external_number: '998977012345', patient_name: 'Юсупова Малика', started_at: '2026-10-16T05:00:00Z' },
  { id: 4, call_type: 1, billsec: 0,  external_number: '+998 90 333 11 22', patient_name: 'Рахимов Бекзод', started_at: '2026-10-16T04:00:00Z', disposition: 'BUSY' },
];
const ids = (rows) => rows.map((r) => r.id);

test('фильтр журнала: сегменты как в образце (входящие — все входящие, пропущенные — без ответа входящие)', () => {
  assert.deepEqual(ids(filterCalls(CALLS, { seg: 'all' })), [1, 2, 3, 4]);
  assert.deepEqual(ids(filterCalls(CALLS, { seg: 'in' })), [1, 2]);
  assert.deepEqual(ids(filterCalls(CALLS, { seg: 'out' })), [3, 4]);
  assert.deepEqual(ids(filterCalls(CALLS, { seg: 'miss' })), [2], 'недозвон исходящего — не «пропущенный»');
});

test('поиск: по имени без пробелов и с «ё», по номеру в любом виде', () => {
  assert.deepEqual(ids(filterCalls(CALLS, { query: 'каримова' })), [1]);
  assert.deepEqual(ids(filterCalls(CALLS, { query: 'юсуповамалика' })), [3]);
  assert.deepEqual(ids(filterCalls(CALLS, { query: '90 333' })), [4]);
  assert.deepEqual(ids(filterCalls(CALLS, { query: '+998 93 555' })), [2]);
  assert.deepEqual(ids(filterCalls(CALLS, { query: 'нет такого' })), []);
  assert.deepEqual(ids(filterCalls(CALLS, { seg: 'in', query: '998' })), [1, 2]);
});

test('«только что звонили»: входящий без ответа моложе двух минут; разговор и исходящий не считаются', () => {
  const now = Date.parse('2026-10-17T05:02:00Z');
  assert.equal(justCalled(CALLS, now).id, 2);
  assert.equal(justCalled(CALLS, now + JUST_CALLED_MS), null, 'через две минуты полоса гаснет');
  assert.equal(justCalled([{ call_type: 0, billsec: 10, started_at: '2026-10-17T05:01:50Z' }], now), null, 'ответили — звонить не надо');
  assert.equal(justCalled([{ call_type: 1, billsec: 0, started_at: '2026-10-17T05:01:50Z' }], now), null, 'наш недозвон — не входящий');
  assert.equal(justCalled([], now), null);
});

test('наш набранный звонок в журнале: исходящий, хвост номера совпал, начался не раньше чем за минуту до нажатия', () => {
  const since = Date.parse('2026-10-16T04:59:30Z');
  const rows = [
    { id: 9, call_type: 1, external_number: '998977012345', started_at: '2026-10-16T05:00:00Z' },
    { id: 8, call_type: 0, external_number: '998977012345', started_at: '2026-10-16T05:00:00Z' },
    { id: 7, call_type: 1, external_number: '998977012345', started_at: '2026-10-16T04:00:00Z' },
  ];
  assert.equal(matchDialed(rows, { digits: '+998977012345', since }).id, 9);
  assert.equal(matchDialed(rows, { digits: '977012345', since }).id, 9, 'девять цифр без кода страны — тот же номер');
  assert.equal(matchDialed([rows[1], rows[2]], { digits: '998977012345', since }), null, 'входящий и давний не наши');
  assert.equal(matchDialed(rows, { digits: '', since }), null);
});

test('инициалы и «кому принадлежит номер»: заявка с доски раньше пациента из журнала', () => {
  assert.equal(initialsOf('Каримова Азиза Рустамовна'), 'КА');
  assert.equal(initialsOf('  Bek '), 'B');
  assert.equal(initialsOf(''), '#');
  const leads = [{ id: 11, full_name: 'Заявка Каримова', phone: '+998 90 111 22 33' }];
  assert.deepEqual(whoIs('998901112233', { leads, calls: CALLS }), { kind: 'lead', name: 'Заявка Каримова', lead: leads[0] });
  assert.deepEqual(whoIs('998977012345', { leads, calls: CALLS }), { kind: 'patient', name: 'Юсупова Малика', patient_id: null });
  assert.equal(whoIs('998900000000', { leads, calls: CALLS }), null);
  assert.equal(whoIs('9012', { leads, calls: CALLS }), null, 'по обрывку номера не угадываем');
});
