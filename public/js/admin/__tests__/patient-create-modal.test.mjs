// PATIENT_ONE_WINDOW_V1 (2026-09-05) — пациент заводится ОДНИМ окном без
// прокрутки (docs/plans/2026-09-05-ui-redesign-and-calendar.md, задача 7).
//
// Что здесь действительно проверяется — по предложению на решение:
//
//   * ВЛЕЗАЕТ. Высота первого экрана считается по модели (METRICS + LAYOUT в
//     views/patient-create-modal.js), а сама модель сверяется с admin.css:
//     каждое её число обязано найтись в блоке .mg-dense. Поэтому «подогнать
//     модель под желаемый ответ» невозможно, не подогнав вёрстку. Порог —
//     calc(100vh - 60px) и на киоске (768), и в окне Chrome на том же
//     железе (~648 после панелей браузера и полосы задач).
//   * ШРИФТ НЕ УМЕНЬШЕН. Плотность даёт поле 32 px и узкие зазоры; в CSS
//     плотного окна не появилось ни одного кегля мимо шкалы (это же
//     гарантирует type-scale.test.mjs, здесь — адресно по блоку).
//   * СОСТАВ ПЕРВОГО ЭКРАНА — ровно двенадцать полей из плана, а фото,
//     Telegram, география, гражданство и поведение спрятаны за «Подробнее»
//     В ТОМ ЖЕ окне (второго оверлея не появляется).
//   * ЗВЁЗДОЧКИ НЕ ВРУТ. Решение: обязательны фамилия, имя, дата рождения и
//     пол — и ровно они помечены. У телефона звёздочки нет, потому что
//     правило «голый +998 сохраняется пустым» означает, что карта без
//     номера — штатный случай; помечать поле и принимать его пустым — это и
//     есть та ложь, которую задача велела убрать.
//   * ДУБЛИКАТ. Серверный страж по-прежнему открывает диалог выбора, а
//     «Создать принудительно» доводит сохранение до вставки.
//   * ВОЗРАСТ И КАТЕГОРИЯ считаются из даты рождения, как считались.
//   * МАРШРУТ `registration` не 404: он рисует живую панель и сразу
//     открывает то же окно (admin.js кэширует панели и НЕ перерисовывает их,
//     поэтому пустая панель была бы хуже отсутствующего маршрута).
//   * СОЗДАНИЕ ИЗ ШАПКИ СПИСКА пациентов открывает то же окно и после
//     сохранения перечитывает список, а не уводит на другую страницу.

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUB  = path.resolve(HERE, '..', '..', '..');            // …/public
const ADMIN_CSS = fs.readFileSync(path.join(PUB, 'css', 'admin.css'), 'utf8');

// ---------------------------------------------------------------------------
// Фальшивый DOM — тот же, что в patients-hub.test.mjs / lab-panels-mode.
// ---------------------------------------------------------------------------
class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this.value='';}
 appendChild(c){this.children.push(c);c.parentNode=this;return c;} removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
 append(...cs){for(const c of cs)if(c)this.appendChild(c);}
 get firstChild(){return this.children[0]||null;} replaceChildren(){this.children.length=0;}
 setAttribute(k,v){this.attrs[k]=String(v); if (k === 'value') this.value = String(v);} getAttribute(k){return this.attrs[k]??null;} hasAttribute(k){return k in this.attrs;}
 removeAttribute(k){delete this.attrs[k];}
 addEventListener(t,fn){(this._l[t]||(this._l[t]=[])).push(fn);} removeEventListener(){}
 dispatchEvent(e){for(const fn of this._l[e.type]||[])fn(e);return true;}
 click(){this.dispatchEvent({type:'click',currentTarget:this,target:this,preventDefault(){},stopPropagation(){}});}
 fireInput(){this.dispatchEvent({type:'input',currentTarget:this,target:this});}
 focus(){} blur(){} scrollTo(){} scrollIntoView(){} remove(){ if(this.parentNode) this.parentNode.removeChild(this); } select(){}
 querySelector(){return null;} querySelectorAll(){return [];}
 getBoundingClientRect(){return {top:0,left:0,width:0,height:0,bottom:0,right:0};}
 get textContent(){return this._t;} set textContent(v){this._t=String(v);this.children.length=0;}
 get classList(){const s=this;return{contains:c=>String(s.className||'').split(/\s+/).includes(c),add(c){s.className=(s.className?s.className+' ':'')+c;},remove(){},toggle(){}};}
 get isConnected(){return true;}}
class TX extends F{constructor(t){super('#text');this.nodeType=3;this._t=String(t);}}
function mk(t){
  const el = new F(t);
  if (el.tagName === 'TEMPLATE') {
    el.content = { firstChild: null };
    Object.defineProperty(el, 'innerHTML', { set(v) { const s = new F('svg'); s._t = String(v); el.content.firstChild = s; }, get() { return ''; } });
  }
  return el;
}
globalThis.Node=F; globalThis.Event=class{constructor(t,o){this.type=t;Object.assign(this,o||{});}};
const toastEl = mk('div');
globalThis.document={createElement:mk,createElementNS:(_n,t)=>mk(t),createTextNode:t=>new TX(t),
  head:mk('head'),body:mk('body'),documentElement:mk('html'),
  addEventListener(){},removeEventListener(){},
  getElementById:(id)=> (id === 'toast' ? toastEl : null),
  querySelector(){return null;},querySelectorAll(){return [];}};
const toasts = [];
Object.defineProperty(toastEl, 'textContent', { get(){ return toastEl._t; }, set(v){ toastEl._t = String(v); toasts.push(String(v)); } });

function makeLocalStorage() {
  const store = new Map();
  return { getItem:(k)=>(store.has(k)?store.get(k):null), setItem:(k,v)=>{store.set(k,String(v));},
           removeItem:(k)=>{store.delete(k);}, clear:()=>store.clear() };
}
const fakeLocalStorage = makeLocalStorage();
globalThis.localStorage = fakeLocalStorage;
// I18N_LOCALE_PIN_V1 — i18n.js выбирает язык ОДИН раз при загрузке модуля.
fakeLocalStorage.setItem('admin.lang', 'ru');

globalThis.window = {
  location: { hostname: 'localhost', hash: '' }, localStorage: fakeLocalStorage,
  addEventListener(){}, removeEventListener(){}, dispatchEvent(){ return true; },
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  scrollTo(){}, scrollY: 0,
  easymed: { state: { user: { id: 'u-1', full_name: 'Регистратор', company_id: 'c-1', role: 'registrar' } } },
  CLINIC: { id: 'c-1' },
  confirm: () => true,
  prompt: () => null,
  easymedSetTabSub(){}, easymedSetTabLabel(){},
};
globalThis.location = globalThis.window.location;
globalThis.MutationObserver=class{observe(){}disconnect(){}};
globalThis.requestAnimationFrame=(fn)=>fn();
globalThis.cancelAnimationFrame=()=>{};
globalThis.history = { state: null, replaceState(){}, pushState(){} };
try { Object.defineProperty(globalThis, 'navigator', { value: { mediaDevices: null }, configurable: true }); } catch (e) { /* node уже дал свой navigator — камеру всё равно не зовём */ }

// --- фальшивый транспорт ---------------------------------------------------
// Один выключатель: что возвращает выборка по patients. Пусто — дубликатов
// нет и сохранение проходит; строка — страж находит совпадение.
let patientRows = [];
let inserted = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  const ok = (payload) => ({ ok: true, status: 200, json: async () => payload });
  if (u.startsWith('/api/auth/me')) return ok({ user: globalThis.window.easymed.state.user });
  if (u.startsWith('/api/rpc/'))    return ok({ data: null });
  if (u.startsWith('/api/db')) {
    const table = body && body.table;
    const op = (body && body.op) || 'select';
    if (op === 'insert') {
      inserted.push({ table, values: body.values });
      const row = { id: 'p-new', mrn: 'MRN-NEW', ...body.values };
      return ok({ data: body.single ? row : [row] });
    }
    const rows = table === 'patients' ? patientRows : [];
    return ok({ data: body && body.single ? (rows[0] || null) : JSON.parse(JSON.stringify(rows)), count: rows.length });
  }
  return ok({ data: null });
};

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

const modal = await import('../views/patient-create-modal.js?v=onewin1');
const { renderRegistration } = await import('../views/registration.js?v=onewin1');
const { renderPatients } = await import('../views/patients.js');
const { setFullAccess } = await import('../permissions.js');

// ---------------------------------------------------------------------------
const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join('');
const hasClass = (n, c) => String(n.className || '').split(/\s+/).includes(c);
const labelsOf = (root) => walk(root).filter((n) => n.tagName === 'LABEL').map((n) => textOf(n).replace(/\s+/g, ' ').trim());
const overlays = () => (document.body.children || []).filter((n) => hasClass(n, 'modal'));
const dialogs = (name) => walk(document.body).filter((n) => n.attrs['data-dialog'] === name);

function reset() {
  patientRows = []; inserted = []; toasts.length = 0;
  document.body.children.length = 0;
  setFullAccess('Admin');
}

// Заполнить окно валидным минимумом (фамилия, имя, дата рождения, пол).
function fillMinimum(dlg, over = {}) {
  dlg.fields.last_name.value  = over.last_name  ?? 'Каримова';
  dlg.fields.first_name.value = over.first_name ?? 'Азиза';
  dlg.fields.date_of_birth.value = over.date_of_birth ?? '1990-04-01';
  dlg.setGender(over.gender ?? 'F');
}

// ===========================================================================
test('первый экран влезает в 1366×768 без прокрутки — и модель высоты сверена с CSS', () => {
  const { METRICS } = modal;

  // 1. Модель не выдумана: каждое её число объявлено в admin.css.
  const dense = ADMIN_CSS.slice(ADMIN_CSS.indexOf('PATIENT_ONE_WINDOW_V1'));
  assert.ok(dense.length > 400, 'блок .mg-dense не найден в admin.css');
  const declared = [
    ['.mg-section padding',        /\.mg-dense \.mg-section \{ padding: 14px 22px; gap: 10px; \}/, [METRICS.sectionPadV, METRICS.rowGap], [14, 10]],
    ['h3 line-height',             /\.mg-dense \.mg-section h3 \{ margin: 0; line-height: 17px; \}/, [METRICS.sectionTitleH], [17]],
    ['.mg-grid gap',               /\.mg-dense \.mg-grid \{ gap: 10px; \}/, [METRICS.rowGap], [10]],
    ['.field gap',                 /\.mg-dense \.field \{ gap: 4px; \}/, [METRICS.labelGap], [4]],
    ['label line-height',          /\.mg-dense \.field label \{ line-height: 17px; \}/, [METRICS.labelH], [17]],
    ['высота поля',                /\.mg-dense \.field select \{ height: 32px; \}/, [METRICS.fieldH], [32]],
    ['высота «Подробнее»',         /\.mg-more-btn \{\s*height: 38px;/, [METRICS.moreRowH], [38]],
  ];
  for (const [what, re, got, want] of declared) {
    assert.ok(re.test(dense), 'CSS не объявляет: ' + what);
    assert.deepEqual(got, want, 'METRICS разошлись с CSS: ' + what);
  }
  // Шапка и подвал — из общих правил модального окна, не из плотного блока.
  assert.ok(/\.modal-head \{[^}]*padding: 16px 22px;/.test(ADMIN_CSS), '.modal-head потерял отступ 16px');
  assert.ok(/\.modal-foot \{[^}]*padding: 14px 22px;/.test(ADMIN_CSS), '.modal-foot потерял отступ 14px');
  assert.ok(/\.btn \{\s*height: 36px;/.test(ADMIN_CSS), '.btn больше не 36px — подвал считается неверно');
  assert.ok(/max-height: calc\(100vh - 60px\)/.test(ADMIN_CSS), '.modal-card потерял max-height');
  assert.equal(METRICS.headPadV, 16);
  assert.equal(METRICS.footPadV, 14);
  assert.equal(METRICS.footRowH, 36);
  assert.equal(METRICS.viewportGap, 60);

  // 2. Считаем и сравниваем с доступной высотой.
  const H = modal.firstScreenHeight();
  assert.ok(H > 0, 'высота не посчиталась');
  assert.ok(modal.fitsViewport(768), 'не влезает на киоске 1366×768: ' + H + ' > ' + (768 - 60));
  // То же железо, но окно Chrome: вкладки + адресная строка + панель задач.
  assert.ok(modal.fitsViewport(648), 'не влезает в окне Chrome на 768-м экране: ' + H + ' > ' + (648 - 60));
  // 3. И по ширине: 1366 минус поля окна.
  assert.ok(METRICS.cardWidth <= 1366 - 32, 'окно шире экрана 1366');
  assert.ok(METRICS.cardWidth > 1120, 'окно не стало шире стандартного сгруппированного — поля останутся длинными');
});

test('плотность сделана размером полей, а не кеглем: в плотном блоке нет шрифта мимо шкалы', () => {
  const dense = ADMIN_CSS.slice(ADMIN_CSS.indexOf('PATIENT_ONE_WINDOW_V1'), ADMIN_CSS.indexOf('/* ---- Report placeholder ---- */'));
  const STEPS = new Set(['12.5', '13.5', '15', '17', '20', '24', '30', '40']);
  const sizes = [...dense.matchAll(/font-size:\s*([\d.]+)px/g)].map((m) => m[1]);
  assert.ok(sizes.length > 0, 'в блоке нет ни одного font-size — правило проверять нечего');
  for (const s of sizes) assert.ok(STEPS.has(s), 'кегль мимо шкалы в плотном окне: ' + s + 'px');
  assert.ok(!/font-size:\s*1[01](\.\d+)?px/.test(dense), 'в плотном окне появился шрифт мельче 12.5px');
});

test('на первом экране — двенадцать полей из плана; фото, Telegram, адрес и поведение за «Подробнее»', () => {
  reset();
  const dlg = modal.buildPatientCreateDialog({});

  // Первый экран = всё окно минус скрытая секция «Подробнее».
  assert.equal(dlg.moreSection.style.display, 'none', 'раскрытие открыто с самого начала');
  const walkExcept = (e, skip, o = []) => { if (e === skip) return o; o.push(e); for (const c of e.children || []) walkExcept(c, skip, o); return o; };
  const first = walkExcept(dlg.card, dlg.moreSection);
  const firstLabels = first.filter((n) => n.tagName === 'LABEL').map((n) => textOf(n).replace(/\s+/g, ' ').trim());

  for (const want of ['Фамилия *', 'Имя *', 'Отчество', 'Дата рождения *', 'Возраст', 'Пол *',
                      'Номер телефона', 'Доп. номер телефона', 'Предпочитаемый язык',
                      'ПИНФЛ (ЖШШИР)', 'Паспорт / документ №', 'Категория пациента']) {
    assert.ok(firstLabels.some((l) => l === want), 'на первом экране нет поля «' + want + '»: ' + firstLabels.join(' | '));
  }
  // Поиск существующего пациента — одной строкой сверху, как и был.
  assert.ok(firstLabels.some((l) => l.startsWith('Найти существующего пациента')), 'строка поиска пропала с первого экрана');

  // За «Подробнее» — ровно то, что план туда отправил.
  const moreLabels = labelsOf(dlg.moreSection);
  for (const want of ['Фото пациента', 'Улица, дом, квартира', 'Махалля', 'Страна', 'Регион', 'Район',
                      'Резидентство', 'Гражданство / национальность', 'Telegram-бот', 'Поведение / предупреждение']) {
    assert.ok(moreLabels.includes(want), 'за «Подробнее» нет «' + want + '»: ' + moreLabels.join(' | '));
  }
  for (const nope of ['Фото пациента', 'Telegram-бот', 'Поведение / предупреждение', 'Махалля']) {
    assert.ok(!firstLabels.includes(nope), '«' + nope + '» осталось на первом экране');
  }

  // Окно — двухколоночное сгруппированное, плотный вариант.
  for (const c of ['modal-card', 'modal-grouped', 'has-groups', 'mg-dense']) {
    assert.ok(hasClass(dlg.card, c), 'на окне нет класса ' + c);
  }
});

test('«Подробнее» раскрывает остальное В ТОМ ЖЕ окне, а не открывает второе', () => {
  reset();
  const dlg = modal.openPatientCreateModal({});
  assert.equal(overlays().length, 1, 'окон не одно');

  dlg.moreBtn.click();
  assert.equal(dlg.isMoreOpen(), true);
  assert.equal(dlg.moreSection.style.display, '', 'раскрытие не показалось');
  assert.equal(dlg.moreBtn.getAttribute('aria-expanded'), 'true');
  assert.equal(dlg.moreLabel.textContent, 'Свернуть подробности');
  assert.equal(overlays().length, 1, '«Подробнее» открыло ВТОРОЕ окно вместо раскрытия');

  dlg.moreBtn.click();
  assert.equal(dlg.isMoreOpen(), false);
  assert.equal(dlg.moreSection.style.display, 'none');
  assert.equal(dlg.moreLabel.textContent, 'Подробнее');
  dlg.close();
});

test('звёздочки не врут: помечены и проверяются ровно фамилия, имя, дата рождения и пол', () => {
  reset();
  const dlg = modal.buildPatientCreateDialog({});

  // 1. Помечено ровно четыре поля — и именно эти.
  const starred = walk(dlg.card)
    .filter((n) => n.tagName === 'LABEL' && walk(n).some((x) => hasClass(x, 'req')))
    .map((n) => textOf(n).replace(/\s+/g, ' ').trim());
  assert.deepEqual(starred.sort(), ['Дата рождения *', 'Имя *', 'Пол *', 'Фамилия *'].sort(),
    'помечены не те поля: ' + starred.join(' | '));

  // 2. Каждая звезда — настоящая проверка.
  const cases = [
    [{ last_name: '' },     'Фамилия и имя обязательны.'],
    [{ first_name: '' },    'Фамилия и имя обязательны.'],
    [{ date_of_birth: '' }, 'Укажите дату рождения'],
    [{ gender: '' },        'Укажите пол'],
  ];
  for (const [over, expect] of cases) {
    toasts.length = 0;
    const d = modal.buildPatientCreateDialog({});
    fillMinimum(d, over);
    assert.equal(d.collect(), null, 'пропущено без ' + Object.keys(over)[0]);
    assert.ok(toasts.some((t) => t.includes(expect)), 'нет объяснения про ' + Object.keys(over)[0] + ': ' + toasts.join(' | '));
  }
  // Нелепая дата тоже не проходит — иначе «звезда есть, проверки нет» вернётся.
  toasts.length = 0;
  const d2 = modal.buildPatientCreateDialog({});
  fillMinimum(d2, { date_of_birth: '1650-01-01' });
  assert.equal(d2.collect(), null);
  assert.ok(toasts.some((t) => t.includes('Проверьте дату рождения')), toasts.join(' | '));

  // 3. Телефон НЕ помечен и НЕ обязателен — карта без номера штатна.
  fillMinimum(dlg);
  const payload = dlg.collect();
  assert.ok(payload, 'минимум без телефона не сохраняется: ' + toasts.join(' | '));
  assert.equal(payload.phone, '', 'нетронутый телефон приехал непустым');
});

test('голый «+998» сохраняется пустым — и в набранном виде номер доезжает', () => {
  reset();
  const dlg = modal.buildPatientCreateDialog({});
  fillMinimum(dlg);

  // Нетронутое поле держит код страны — но это НЕ номер.
  assert.ok(String(dlg.fields.phone.input.value).includes('998'), 'поле не предзаполнено кодом страны');
  assert.equal(dlg.collect().phone, '', 'голый «+998» сохранился как номер');

  dlg.fields.phone.value = '+998909610004';
  const p = dlg.collect();
  assert.ok(p.phone.replace(/\D/g, '').endsWith('909610004'), 'набранный номер потерялся: ' + p.phone);
  assert.equal(dlg.collect().phone_secondary, '', 'второй телефон приехал непустым');
});

test('возраст считается из даты рождения, категория подставляется по возрасту', () => {
  reset();
  const dlg = modal.buildPatientCreateDialog({});
  const ageEl = walk(dlg.card).find((n) => n.attrs.name === '__age');
  assert.ok(ageEl, 'поля возраста нет');

  const y = new Date().getFullYear();
  dlg.fields.date_of_birth.value = (y - 30) + '-01-01';
  dlg.fields.date_of_birth.fireInput();
  assert.equal(ageEl.value, '30', 'возраст не посчитался');
  assert.equal(dlg.fields.patient_category.value, 'Взрослый', 'категория не подставилась');

  const d2 = modal.buildPatientCreateDialog({});
  d2.fields.date_of_birth.value = (y - 7) + '-01-01';
  d2.fields.date_of_birth.fireInput();
  assert.equal(d2.fields.patient_category.value, 'Ребёнок');

  // Чистая функция — та же, что раньше жила в registration.js.
  assert.equal(modal.categoryFromAge(0), 'Новорождённый');
  assert.equal(modal.computeAge(''), null);
});

test('дубликат открывает диалог выбора, а «Создать принудительно» доводит вставку', async () => {
  reset();
  // Страж найдёт эту карту: тот же ПИНФЛ.
  patientRows = [{ id: 'p-1', mrn: 'MRN-1', full_name: 'Каримова Азиза', last_name: 'Каримова',
                   first_name: 'Азиза', phone: '+998901112233', date_of_birth: '1990-04-01',
                   national_id: '12345678901234' }];

  const dlg = modal.openPatientCreateModal({});
  fillMinimum(dlg);
  dlg.fields.national_id.value = '12345678901234';

  await dlg.save({ openVisit: false });
  const dup = dialogs('patient-duplicate');
  assert.equal(dup.length, 1, 'диалог дубликата не открылся');
  assert.equal(inserted.length, 0, 'дубликат всё-таки вставился');
  assert.ok(textOf(dup[0]).includes('Возможный дубликат пациента'));

  // Принудительное создание — вставка проходит.
  const force = walk(dup[0]).find((n) => n.attrs['data-act'] === 'force-create');
  assert.ok(force, 'кнопки «Создать принудительно» нет');
  force.click();
  await tick();
  assert.equal(inserted.length, 1, 'принудительное создание не вставило карту');
  assert.equal(inserted[0].table, 'patients');
  assert.equal(inserted[0].values.national_id, '12345678901234');
});

test('обычное сохранение доходит до вставки и отдаёт карту вызвавшему экрану', async () => {
  reset();
  let saved = null;
  const dlg = modal.openPatientCreateModal({ onSaved: (p) => { saved = p; } });
  fillMinimum(dlg);
  const patient = await dlg.save({ openVisit: false });

  assert.ok(patient && patient.id, 'сохранение не вернуло пациента');
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].values.last_name, 'Каримова');
  assert.equal(inserted[0].values.gender, 'female', 'пол не перевёлся в колонку');
  assert.ok(saved && saved.id === patient.id, 'onSaved не вызван — список не узнает о новой карте');
  assert.equal(overlays().length, 0, 'окно осталось открытым после сохранения');
  assert.ok(toasts.some((t) => t.includes('Пациент сохранён')), toasts.join(' | '));
});

test('маршрут registration жив: панель не пустая и окно открывается сразу', () => {
  reset();
  const box = mk('div');
  const navigated = [];
  renderRegistration(box, { onNavigate: (v) => navigated.push(v) });

  const txt = textOf(box);
  assert.ok(txt.includes('Создать пациента'), 'панель маршрута пуста — возврат по закладке покажет белый экран');
  assert.ok(txt.includes('Госпитализация'), 'действие «Госпитализация» потерялось вместе со страницей');
  assert.equal(dialogs('patient-create').length, 1, 'маршрут не открыл окно заведения пациента');

  // Окно закрыли — панель умеет открыть его снова (панели кэшируются и не
  // перерисовываются, поэтому кнопка обязана быть).
  overlays().forEach((o) => o.remove());
  const again = walk(box).find((n) => n.attrs['data-act'] === 'open-create-patient');
  assert.ok(again, 'на панели нет кнопки повторного открытия');
  again.click();
  assert.equal(dialogs('patient-create').length, 1, 'кнопка не открыла окно');
});

test('создание из шапки списка пациентов открывает то же окно и обновляет список', async () => {
  reset();
  patientRows = [{ id: 'p-1', mrn: 'MRN-1', full_name: 'Эргашев Жахонгир', last_name: 'Эргашев',
                   first_name: 'Жахонгир', phone: '+998901112233', date_of_birth: '1990-04-01',
                   registration_date: '2026-09-01' }];
  const box = mk('div');
  await renderPatients(box, { onNavigate: () => {}, embedded: true });
  await tick();

  const createBtn = walk(box).find((n) => n.tagName === 'BUTTON' && n.attrs['data-onb'] === 'create-patient');
  assert.ok(createBtn, 'в шапке списка нет кнопки «Создать пациента»');
  createBtn.click();
  assert.equal(dialogs('patient-create').length, 1, 'кнопка списка не открыла окно');

  // «Госпитализация» доступна с того же экрана.
  assert.ok(walk(box).some((n) => n.tagName === 'BUTTON' && n.attrs['data-act'] === 'admission'),
    'из списка пациентов нельзя начать госпитализацию');

  // Сохранение обновляет ЭТОТ список, а не уводит на другую страницу: окно
  // зовёт onSaved, и список перечитывается тем же fetchAndPaint.
  patientRows = [];
  let refetched = 0;
  const dlg = modal.openPatientCreateModal({ onSaved: () => { refetched++; } });
  fillMinimum(dlg);
  await dlg.save({ openVisit: false });
  assert.equal(refetched, 1, 'onSaved не сработал — новая карта не появилась бы в списке');
});
