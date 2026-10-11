// PUBLIC_API_V1 — окно «Онлайн-запись через API» карточки заявки и строка на
// доске: что выбрал пациент и до какого времени держим; «Подтвердить запись» —
// только после выбора карты; новая карта — окном регистрации; другое время —
// из свободного времени врача; отказ — с причиной; заявка без времени — «Взять
// в работу»; отказ сервера «время занято» — словами шаблона.
import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, onRpc, calls, walk, textOf, byAttr, buttonByText, lastToast, tick } from './api-harness.mjs';

const { apiBookingBox, apiBoardLine, loadApiMarks, errorText } = await import('../views/crm-api-booking.js');

const ITEM = {
  id: 41, public_id: 'rq_e2a9f0c1', kind: 'appointment', status: 'pending', partner_status: 'pending',
  connection: { id: 3, name: 'med24.uz' }, external_id: 'med-8f2c41', received_at: '2030-03-11T04:01:00Z', picked_at: '2030-03-11T04:01:10Z',
  doctor: { id: 7, name: 'Петров Пётр Петрович' }, branch: { id: 1, name: 'Главный корпус' },
  what: { kind: 'consultation', name: 'Первичный приём', price: 150000 },
  start_at: '2030-03-12T05:00:00Z', duration_minutes: 30, hold_until: '2030-03-11T04:31:00Z', offered_start: null, offer_until: null,
  decline_reason: '', patient_name: 'Абдурахмонов Фаррух', patient_phone: '+998901234567', comment: 'Записываю сына, 5 лет',
  patient: null, visit_id: null, partner_cancel_at: null, can: { confirm: true, offer: true, decline: true, accept: false },
};
const CANDS = [
  { id: 1, full_name: 'Абдурахмонов Фаррух', mrn: 'A-1', date_of_birth: '1988-03-12', why: 'phone_name' },
  { id: 2, full_name: 'Абдурахмонов Тимур', mrn: 'A-2', date_of_birth: '2021-07-04', why: 'phone' },
];
function mount(items = [ITEM], opts = {}) {
  reset();
  onRpc('api_booking_list', () => ({ items }));
  onRpc('api_booking_candidates', () => ({ items: CANDS }));
  const box = apiBookingBox({ id: 900 }, opts);
  return box;
}
const btn = (root, k) => byAttr(root, 'data-apib', k)[0];

test('окно: подключение, номер у партнёра, что выбрал пациент и цена, «держим до», комментарий; данные — как есть', async () => {
  const box = mount();
  await tick();
  assert.equal(box.style.display, '');
  const t = textOf(box);
  for (const s of ['Онлайн-запись через API', 'med24.uz', 'med-8f2c41', 'Петров Пётр Петрович', 'Первичный приём', '150 000 сум',
    'Главный корпус', 'Ждёт подтверждения', 'Записываю сына, 5 лет', 'Карта пациента', 'тот же телефон и имя']) {
    assert.ok(t.includes(s), 'нет: ' + s);
  }
  assert.match(t, /время держим за пациентом до \d\d:\d\d/);
});

test('без заявок из API — блок скрыт', async () => {
  const box = mount([]);
  await tick();
  assert.equal(box.style.display, 'none');
  assert.equal(box.children.length, 0);
});

test('«Подтвердить запись» — только после выбора карты; подтверждение уходит с выбранной картой', async () => {
  const box = mount();
  const changed = [];
  await tick();
  assert.ok('disabled' in btn(box, 'confirm').attrs, 'до выбора карты — выключено');
  const pick = walk(box).find((n) => n.attrs && n.attrs['data-candidate'] === '2');
  buttonByText(pick, /Выбрать/).click();
  await tick();
  assert.ok(!('disabled' in btn(box, 'confirm').attrs));
  onRpc('api_booking_confirm', (b) => { changed.push(b); return { id: 41, status: 'confirmed', visit_id: 501, already: false }; });
  btn(box, 'confirm').click();
  await tick(40);
  assert.deepEqual(changed, [{ id: 41, patient_id: 2 }]);
  assert.equal(lastToast(), 'Запись подтверждена. Визит в календаре врача, партнёр получит уведомление.');
});

test('«Создать карту» — окно регистрации с именем и телефоном из заявки; новая карта становится выбранной', async () => {
  const asked = [];
  const box = mount([ITEM], { newPatient: async (prefill) => { asked.push(prefill); return { id: 77, full_name: 'Абдурахмонов Али', mrn: 'A-77' }; } });
  await tick();
  buttonByText(box, /Создать карту/).click();
  await tick();
  assert.deepEqual(asked, [{ full_name: 'Абдурахмонов Фаррух', phone: '+998901234567' }]);
  assert.ok(textOf(box).includes('Абдурахмонов Али') && textOf(box).includes('Новая карта'));
  onRpc('api_booking_confirm', (b) => ({ id: 41, status: 'confirmed', visit_id: 1, b }));
  btn(box, 'confirm').click();
  await tick(40);
  assert.deepEqual(calls.filter((c) => c[0] === 'api_booking_confirm').map((c) => c[1]), [{ id: 41, patient_id: 77 }]);
});

test('другое время — из свободного времени врача на выбранный день; отказ — с причиной', async () => {
  const box = mount();
  onRpc('calendar_slots', () => ({ slots: [{ start: '14:00', start_iso: '2030-03-12T09:00:00.000Z' }, { start: '14:15', start_iso: '2030-03-12T09:15:00.000Z' }] }));
  await tick();
  btn(box, 'offer').click();
  await tick();
  const slotsCall = calls.find((c) => c[0] === 'calendar_slots');
  assert.deepEqual(slotsCall[1], { doctor_id: 7, date: '2030-03-12', duration_minutes: 30, step_minutes: 15 });
  onRpc('api_booking_offer', () => ({ id: 41, status: 'offered' }));
  buttonByText(box, /Отправить предложение/).click();
  await tick(40);
  assert.deepEqual(calls.find((c) => c[0] === 'api_booking_offer')[1], { id: 41, start: '2030-03-12T09:00:00.000Z' });

  const box2 = mount();
  await tick();
  btn(box2, 'decline').click();
  await tick();
  const form = byAttr(box2, 'data-apib-form', 'decline')[0];
  const sel = walk(form).find((n) => n.tagName === 'SELECT');
  buttonByText(form, /Отклонить запись/).click();
  assert.equal(lastToast(), 'Выберите причину отказа.');
  sel.value = 'doctor_unavailable';
  onRpc('api_booking_decline', () => ({ id: 41, status: 'declined' }));
  buttonByText(form, /Отклонить запись/).click();
  await tick(40);
  assert.deepEqual(calls.find((c) => c[0] === 'api_booking_decline')[1], { id: 41, reason: 'doctor_unavailable' });
});

test('заявка без времени — «Взять в работу»; отказ сервера «время занято» — шаблоном', async () => {
  const box = mount([{ ...ITEM, kind: 'request', status: 'new', what: null, doctor: null, start_at: null, can: { confirm: false, offer: false, decline: false, accept: true } }]);
  await tick();
  assert.ok(textOf(box).includes('Заявка через API'));
  assert.equal(btn(box, 'confirm'), undefined);
  onRpc('api_request_accept', () => ({ id: 41, status: 'accepted' }));
  btn(box, 'accept').click();
  await tick(40);
  assert.deepEqual(calls.find((c) => c[0] === 'api_request_accept')[1], { id: 41 });
  assert.equal(errorText({ code: 'slot_taken', params: { doctor: 'Петров', from: '10:00', to: '10:30' }, message: 'x' }),
    'Это время занято: у врача Петров уже есть приём 10:00–10:30. Выберите другое время.');
});

test('доска: строка онлайн-записи — подключение · API и «ждёт подтверждения до»; без заявок — ничего', async () => {
  reset();
  onRpc('api_board_marks', () => ({ marks: { 900: [{ id: 41, kind: 'appointment', status: 'pending', connection_name: 'med24.uz', hold_until: '2030-03-11T04:31:00Z' }] } }));
  const marks = await loadApiMarks();
  const line = apiBoardLine(marks[900]);
  assert.equal(line.attrs['data-api-mark'], 'pending');
  assert.match(textOf(line), /med24\.uz · APIждёт подтверждения до \d\d:\d\d$/);
  assert.equal(apiBoardLine(undefined), null);
  assert.match(textOf(apiBoardLine([{ kind: 'request', status: 'new', connection_name: 'Symptex' }])), /новая заявка/);
});

test('клавиатура: после «Выбрать» фокус — на «Подтвердить запись», после «Предложить другое время» — на дне; карта из дубликатов окна регистрации — выбранная из списка', async () => {
  const box = mount([ITEM], { newPatient: async () => ({ id: 2, full_name: 'Абдурахмонов Тимур', mrn: 'A-2' }) });
  onRpc('calendar_slots', () => ({ slots: [{ start: '14:00', start_iso: '2030-03-12T09:00:00.000Z' }] }));
  await tick();
  buttonByText(walk(box).find((n) => n.attrs && n.attrs['data-candidate'] === '1'), /Выбрать/).click();
  assert.equal(document.activeElement, btn(box, 'confirm'));
  btn(box, 'offer').click();
  assert.equal(document.activeElement && document.activeElement.attrs.type, 'date');
  buttonByText(box, /Создать карту/).click();
  await tick();
  const row = walk(box).find((n) => n.attrs && n.attrs['data-candidate'] === '2');
  assert.ok(String(row.className).split(/\s+/).includes('on'), 'выбрана карта из списка');
  assert.ok(!textOf(box).includes('Новая карта'), 'не «новая» — она уже была в списке');
  assert.ok(textOf(box).includes('12 марта 1988'), 'дата рождения — словами, как во всём приложении');
});

test('открытая форма «Предложить другое время» переживает перерисовку: выбранное время не сбрасывается, свободное время не спрашивается заново', async () => {
  const box = mount();
  onRpc('calendar_slots', () => ({ slots: [{ start: '14:00', start_iso: '2030-03-12T09:00:00.000Z' }, { start: '14:15', start_iso: '2030-03-12T09:15:00.000Z' }] }));
  await tick();
  btn(box, 'offer').click();
  await tick();
  const sel = walk(byAttr(box, 'data-apib-form', 'offer')[0]).find((n) => n.tagName === 'SELECT');
  sel.value = '2030-03-12T09:15:00.000Z';
  buttonByText(walk(box).find((n) => n.attrs && n.attrs['data-candidate'] === '1'), /Выбрать/).click();
  await tick();
  assert.equal(calls.filter((c) => c[0] === 'calendar_slots').length, 1);
  onRpc('api_booking_offer', () => ({ id: 41, status: 'offered' }));
  buttonByText(box, /Отправить предложение/).click();
  await tick(40);
  assert.deepEqual(calls.find((c) => c[0] === 'api_booking_offer')[1], { id: 41, start: '2030-03-12T09:15:00.000Z', patient_id: 1 });
});
