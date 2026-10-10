// SERVICES_PACKAGES_V1 — экран «Услуги для сайта и партнёров» (views/services-public.js;
// макет screen-services.js): три цифры, вкладки пяти групп с числами,
// «Консультации» — врачи с ценами и услуги-консультации прайса с теми, кто их
// оказывает (решение владельца 12), остальные группы — услуги с переключателем
// показа и «Показать всю группу». Данные — RPC services_public_overview.
import { test } from 'node:test';
import assert from 'node:assert';
import { reset, onRpc, calls, textOf, buttonByText, tick, walk, lastToast, rpcNames } from './api-harness.mjs';

const { renderServicesPublic, consultPriceText, doctorStateText } = await import('../views/services-public.js');

const svc = (id, ru, uz, en, price, group, online, extra = {}) => ({ id, name: { ru, uz, en }, group, api_group: group, price, online,
  state: !uz ? 'no_uz' : (online ? 'shown' : 'off'), ...extra });
function overview(over = {}) {
  return {
    can_edit: true, secondary: false,
    facts: { services_shown: 3, services_total: 7, doctors_shown: 1, doctors_total: 2, no_en: 2 },
    groups: [
      { key: 'consultation', api: 'consultations', label: 'Консультации', count: 2 },
      { key: 'lab', api: 'lab', label: 'Лаборатория', count: 3 },
      { key: 'imaging', api: 'diagnostics', label: 'Диагностика', count: 0 },
      { key: 'procedure', api: 'procedures', label: 'Процедуры', count: 0 },
      { key: 'other', api: 'surgery', label: 'Хирургия', count: 0 },
    ],
    services: [
      svc(1, 'Общий анализ крови', 'Umumiy qon tahlili', 'Complete blood count', 45000, 'lab', true),
      svc(2, 'Глюкоза', 'Glyukoza', '', 25000, 'lab', false),
      svc(3, 'Липидный профиль', '', '', 120000, 'lab', false),
      svc(10, 'Консультация невролога', 'Nevrolog konsultatsiyasi', '', 150000, 'consultation', true,
        { performers: [{ id: 1, name: 'Абдуллаев Шерзод', shown: true }], warning: null }),
      svc(12, 'Консультация хирурга', 'Jarroh konsultatsiyasi', '', 160000, 'consultation', false, { performers: [], warning: 'noPerformer' }),
    ],
    doctors: [
      { id: 1, name: 'Абдуллаев Шерзод', specialty: 'Педиатр', specialty_slug: 'pediatr', mode: 'schedulable', state: 'shown',
        consultations: [
          { consultation_type_id: 1, name: { ru: 'Первичный приём' }, price: 150000, own: true, empty: false },
          { consultation_type_id: 2, name: { ru: 'Повторный приём' }, price: 0, own: true, empty: false },
          { consultation_type_id: 3, name: { ru: 'Онлайн' }, price: 0, own: true, empty: true },
        ],
        services: [{ service_id: 10, name: { ru: 'Консультация невролога' }, price: 150000, own: false, online: true }] },
      { id: 2, name: 'Каримов Азиз', specialty: 'Эндокринолог', specialty_slug: null, mode: 'live_queue', state: 'off', consultations: [], services: [] },
    ],
    ...over,
  };
}
async function mount(data = overview(), opts = {}) {
  reset();
  let current = data;
  onRpc('services_public_overview', () => current);
  onRpc('services_set_online', (b) => {
    const ids = new Set(b.ids);
    current = { ...current, services: current.services.map((s) => (ids.has(s.id) && s.state !== 'no_uz' ? { ...s, online: b.on, state: b.on ? 'shown' : 'off' } : s)) };
    return { changed: b.ids, skipped: [] };
  });
  const box = document.createElement('div');
  await renderServicesPublic(box, opts);
  await tick(20);
  return box;
}
const tab = (box, key) => walk(box).find((n) => n.tagName === 'BUTTON' && n.attrs && n.attrs['data-group'] === key);
const rowOf = (box, attr, id) => walk(box).find((n) => n.tagName === 'TR' && n.attrs && n.attrs[attr] === String(id));
const flat = (n) => textOf(n).replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/\s+/g, ' ').trim();

test('цена консультации: «Бесплатно» — своя строка с нулём; пустая — «0 сум · цена не введена» (решение 13)', () => {
  assert.equal(consultPriceText({ price: 150000, own: true }), '150 000 сум');
  assert.equal(consultPriceText({ price: 0, own: true, empty: false }), 'Бесплатно');
  assert.equal(consultPriceText({ price: 0, own: true, empty: true }), '0 сум · цена не введена');
  assert.equal(consultPriceText({ price: 100000, own: false }), '100 000 сум', 'строки нет — общая цена вида');
  assert.deepEqual(doctorStateText('shown'), ['На сайте', 'ok', '']);
  assert.deepEqual(doctorStateText('off'), ['Скрыт с сайта', '', 'врач скрыт в своей карточке']);
  assert.deepEqual(doctorStateText('branch_hidden'), ['Скрыт с сайта', '', 'филиал скрыт с сайта']);
});

test('шапка: подзаголовок макета, три цифры, вкладки пяти групп с числами; открыто «Консультации»', async () => {
  const box = await mount();
  const t = flat(box);
  assert.match(t, /Какие услуги и цены видят пациенты на сайте клиники, в Symptex и у партнёров\. Группы те же пять, что в прейскуранте\./);
  assert.match(t, /Показываем услуг ?3 из 7/);
  assert.match(t, /Врачей с ценами консультаций ?1 из 2/);
  assert.match(t, /2 — партнёры покажут русское название/);
  assert.deepEqual(['consultation', 'lab', 'imaging', 'procedure', 'other'].map((k) => flat(tab(box, k))),
    ['Консультации 2', 'Лаборатория 3', 'Диагностика 0', 'Процедуры 0', 'Хирургия 0']);
  assert.equal(tab(box, 'consultation').attrs['aria-selected'], 'true');
  assert.equal(buttonByText(box, /Показать всю группу/), null, 'у «Консультаций» групповой кнопки нет (макет)');
});

test('«Консультации»: врачи с ценами и услугами из прайса, показ врача; услуги-консультации — кто оказывает и «нет врача»', async () => {
  const opened = [];
  const box = await mount(overview(), { onOpenConsultTypes: () => opened.push(1) });
  const d1 = flat(rowOf(box, 'data-doctor-id', 1));
  assert.match(d1, /Абдуллаев Шерзод/);
  assert.match(d1, /Педиатр · по записи/);
  assert.match(d1, /Первичный приём ?150 000 сум/);
  assert.match(d1, /Повторный приём ?Бесплатно/);
  assert.match(d1, /Онлайн ?0 сум · цена не введена/);
  assert.match(d1, /Из прайса/);
  assert.match(d1, /Консультация невролога ?На сайте ?150 000 сум/);
  assert.match(d1, /На сайте/);
  const d2 = flat(rowOf(box, 'data-doctor-id', 2));
  assert.match(d2, /живая очередь/);
  assert.match(d2, /Скрыт с сайта/);
  assert.match(d2, /врач скрыт в своей карточке/);
  assert.match(flat(box), /Услуги прайса в группе «Консультации»/);
  assert.match(flat(rowOf(box, 'data-service-id', 10)), /Абдуллаев Шерзод/);
  assert.match(flat(rowOf(box, 'data-service-id', 12)), /Нет врача — в профилях врачей партнёры её не увидят\./);
  buttonByText(box, /Открыть «Консультации врачей»/).click();
  assert.deepEqual(opened, [1]);
});

test('группа услуг: названия RU / UZ / EN, цена, переключатель; без узбекского — «Нужно название на узбекском»; переключение — RPC', async () => {
  const box = await mount();
  tab(box, 'lab').click();
  await tick();
  const r1 = rowOf(box, 'data-service-id', 1);
  assert.match(flat(r1), /Общий анализ крови ?Umumiy qon tahlili · Complete blood count/);
  assert.match(flat(r1), /45 000/);
  assert.match(flat(rowOf(box, 'data-service-id', 2)), /Glyukoza · —/, 'нет английского — прочерк');
  const r3 = rowOf(box, 'data-service-id', 3);
  assert.match(flat(r3), /Нужно название на узбекском/);
  assert.equal(walk(r3).some((n) => n.attrs && n.attrs.role === 'switch'), false);
  const sw = walk(rowOf(box, 'data-service-id', 2)).find((n) => n.attrs && n.attrs.role === 'switch');
  assert.equal(sw.attrs['aria-checked'], 'false');
  sw.click();
  await tick(20);
  const set = calls.find((c) => c[0] === 'services_set_online');
  assert.deepEqual(set[1], { ids: [2], on: true });
  assert.equal(walk(rowOf(box, 'data-service-id', 2)).find((n) => n.attrs && n.attrs.role === 'switch').attrs['aria-checked'], 'true');
});

test('«Показать всю группу»: включает выключенные с названиями RU и UZ, пропущенные — в сообщении', async () => {
  const box = await mount();
  tab(box, 'lab').click();
  await tick();
  buttonByText(box, /Показать всю группу/).click();
  await tick(30);
  const set = calls.filter((c) => c[0] === 'services_set_online').pop();
  assert.deepEqual(set[1], { ids: [2], on: true });
  assert.equal(lastToast(), 'Показали группу. Без узбекского названия пропущено: 1.');
});

test('не администратор и филиал — только смотрят: переключатели закрыты, групповой кнопки нет, пояснение', async () => {
  let box = await mount(overview({ can_edit: false }));
  tab(box, 'lab').click();
  await tick();
  assert.match(flat(box), /Показ услуг на сайте и у партнёров меняет администратор\./);
  assert.equal(buttonByText(box, /Показать всю группу/), null);
  const sw = walk(rowOf(box, 'data-service-id', 2)).find((n) => n.attrs && n.attrs.role === 'switch');
  assert.ok('disabled' in sw.attrs);
  sw.click();
  await tick();
  assert.equal(rpcNames().includes('services_set_online'), false);
  box = await mount(overview({ can_edit: false, secondary: true }));
  assert.match(flat(box), /Показ услуг меняется в главном здании — сюда он приходит с прайсом\./);
});
