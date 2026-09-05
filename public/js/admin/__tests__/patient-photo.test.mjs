// PATIENT_PHOTO_V1 (2026-09-05) — ФОТОГРАФИЯ СО СТОРОНЫ БРАУЗЕРА.
//
// Серверная половина проверена по HTTP (server/routes/photo-storage.test.js).
// Здесь — то, что до сервера даже не доезжало:
//
//   • СЪЁМКА С ВЕБ-КАМЕРЫ ЦЕЛИКОМ. Регистратор нажимает «Сфотографировать»,
//     снимает кадр, сохраняет пациента — и в базу уезжает photo_url,
//     указывающий на настоящий загруженный файл. Это тот самый путь, который
//     молча падал на 400: кадр уходил в корзину, которой сервер не знал, и
//     карта сохранялась БЕЗ фотографии, ничего об этом не сказав.
//   • УМЕНЬШЕНИЕ. Кадр 4000×3000 не уезжает целиком: 1024 px по длинной
//     стороне — в 6.5 раза больше самого крупного места, где фото
//     показывают. Иначе клиника платит диском и КАЖДОЙ ежедневной копией за
//     то, чего никто не увидит.
//   • УМЕНЬШЕНИЕ НЕ ПОРТИТ ТО, ЧЕГО НЕ ДОЛЖНО КАСАТЬСЯ. Оно живёт в отдельном
//     модуле, который зовут ровно два виджета портрета; вложение карты
//     пациента (скан направления с мелким текстом) идёт мимо.
//   • НЕУДАЧА УМЕНЬШЕНИЯ — НЕ ОШИБКА. HEIC браузер не раскодирует; файл
//     уходит как есть, и отказ приходит от правил, а не от нашей неудачи.
//   • ОТКАЗ ВИДЕН СРАЗУ. Не картинку и слишком большой файл экран отбивает до
//     отправки и говорит ПОЧЕМУ.

import { test } from 'node:test';
import assert from 'node:assert';

// ---------------------------------------------------------------------------
// Фальшивый DOM — тот же, что в patient-create-modal.test.mjs, плюс canvas,
// createImageBitmap и URL.createObjectURL: без них съёмку не проиграть.
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
 focus(){} blur(){} scrollTo(){} scrollIntoView(){} remove(){ if(this.parentNode) this.parentNode.removeChild(this); } select(){}
 querySelector(){return null;} querySelectorAll(){return [];}
 getBoundingClientRect(){return {top:0,left:0,width:0,height:0,bottom:0,right:0};}
 get textContent(){return this._t;} set textContent(v){this._t=String(v);this.children.length=0;}
 get classList(){const s=this;return{contains:c=>String(s.className||'').split(/\s+/).includes(c),add(c){s.className=(s.className?s.className+' ':'')+c;},remove(){},toggle(){}};}
 get isConnected(){return true;}}
class TX extends F{constructor(t){super('#text');this.nodeType=3;this._t=String(t);}}

// Холст. toBlob отдаёт «JPEG» размером в пиксели результата — так же, как
// настоящий: чем меньше картинка, тем меньше файл. Это и позволяет проверить,
// что уменьшение действительно уменьшает, а не просто пересохраняет.
const canvasesMade = [];
function makeCanvas() {
  const el = new F('canvas');
  el.getContext = () => ({ drawImage() { el._drawn = true; } });
  el.toBlob = (cb, type, q) => { el._type = type; el._q = q;
    cb(new Blob([new Uint8Array(Math.max(1, el.width * el.height))], { type: type || 'image/jpeg' })); };
  canvasesMade.push(el);
  return el;
}
function mk(t){
  if (String(t).toLowerCase() === 'canvas') return makeCanvas();
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
fakeLocalStorage.setItem('admin.lang', 'ru');

globalThis.window = {
  location: { hostname: 'localhost', hash: '' }, localStorage: fakeLocalStorage,
  addEventListener(){}, removeEventListener(){}, dispatchEvent(){ return true; },
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  scrollTo(){}, scrollY: 0,
  easymed: { state: { user: { id: 7, full_name: 'Регистратор', company_id: 'c-1', role: 'registrar' } } },
  CLINIC: { id: 'c-1' },
  confirm: () => true, prompt: () => null,
  easymedSetTabSub(){}, easymedSetTabLabel(){},
};
globalThis.location = globalThis.window.location;
globalThis.MutationObserver=class{observe(){}disconnect(){}};
globalThis.requestAnimationFrame=(fn)=>fn();
globalThis.cancelAnimationFrame=()=>{};
globalThis.history = { state: null, replaceState(){}, pushState(){} };
globalThis.URL.createObjectURL = () => 'blob:фото';
globalThis.URL.revokeObjectURL = () => {};

// Камера: настоящая последовательность — getUserMedia отдаёт поток, кнопка
// «Сделать снимок» разблокируется, кадр рисуется на холст.
let cameraWorks = true;
const stopped = [];
Object.defineProperty(globalThis, 'navigator', {
  value: { mediaDevices: { getUserMedia: async () => {
    if (!cameraWorks) throw new Error('Permission denied');
    return { getTracks: () => [{ stop() { stopped.push(1); } }] };
  } } },
  configurable: true, writable: true,
});

// Раскодировщик картинок. Размер картинки берём из ИМЕНИ файла («4000x3000»),
// чтобы каждый случай был виден в самом тесте.
let decodeFails = false;
globalThis.createImageBitmap = async (blob) => {
  if (decodeFails) throw new Error('unsupported image format');
  const m = /(\d+)x(\d+)/.exec((blob && blob.name) || '') || [null, '4000', '3000'];
  return { width: Number(m[1]), height: Number(m[2]), close() {} };
};

// --- транспорт -------------------------------------------------------------
const uploads = [];
let inserted = [];
let uploadStatus = 200;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const ok = (payload) => ({ ok: true, status: 200, json: async () => payload, headers: { get: () => null } });
  if (u.startsWith('/api/storage/')) {
    uploads.push({ url: u, method: opts.method, size: (opts.body && opts.body.size) || 0, type: (opts.headers || {})['Content-Type'] });
    if (uploadStatus !== 200) {
      return { ok: false, status: uploadStatus, json: async () => ({ error: { code: 'file_too_large', message: 'Фотография 9.0 МБ — это больше предела в 8 МБ. Переснимите в меньшем качестве.' } }) };
    }
    return ok({ data: { path: 'x' } });
  }
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  if (u.startsWith('/api/auth/me')) return ok({ user: globalThis.window.easymed.state.user });
  if (u.startsWith('/api/rpc/'))    return ok({ data: null });
  if (u.startsWith('/api/db')) {
    const op = (body && body.op) || 'select';
    if (op === 'insert') {
      inserted.push({ table: body.table, values: body.values });
      const row = { id: 'p-new', mrn: 'MRN-NEW', ...body.values };
      return ok({ data: body.single ? row : [row] });
    }
    return ok({ data: body && body.single ? null : [], count: 0 });
  }
  return ok({ data: null });
};

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

const modal = await import('../views/patient-create-modal.js?v=pph1');
const { setFullAccess } = await import('../permissions.js');
const { downscalePhoto } = await import('../../shared/photo-downscale.js?v=pph1');
const limits = await import('../../shared/patient-file-limits.js?v=pph1');

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const hasClass = (n, c) => String(n.className || '').split(/\s+/).includes(c);
const overlays = () => (document.body.children || []).filter((n) => hasClass(n, 'modal'));

function reset() {
  uploads.length = 0; inserted = []; toasts.length = 0; canvasesMade.length = 0; stopped.length = 0;
  decodeFails = false; cameraWorks = true; uploadStatus = 200;
  document.body.children.length = 0;
  setFullAccess('Admin');
}

// Файл с заданным «весом» и размером картинки в имени.
const photoFile = (name, bytes) => new File([new Uint8Array(bytes)], name, { type: 'image/jpeg' });

// ===========================================================================
// Уменьшение
// ===========================================================================
test('во что уменьшать: длинная сторона 1024, пропорции целы, маленькое не трогаем', () => {
  const { photoTargetSize, PHOTO_MAX_SIDE } = limits;
  assert.equal(PHOTO_MAX_SIDE, 1024);
  assert.deepEqual(photoTargetSize(4000, 3000), { width: 1024, height: 768 });
  assert.deepEqual(photoTargetSize(3000, 4000), { width: 768, height: 1024 });
  assert.deepEqual(photoTargetSize(2048, 1024), { width: 1024, height: 512 });
  // Меньше предела — НЕ увеличиваем: снимок от этого лучше не станет, а весить
  // будет больше.
  assert.equal(photoTargetSize(800, 600), null);
  assert.equal(photoTargetSize(1024, 1024), null);
  assert.equal(photoTargetSize(0, 0), null);
  // 1024 — не меньше самого крупного места, где фотографию показывают (156 px
  // в профиле врача), даже на экране двойной плотности.
  assert.ok(PHOTO_MAX_SIDE >= 156 * 2, 'предел мельче, чем место показа');
});

test('снимок 4000×3000 уезжает уменьшенным — и это видно по весу файла', async () => {
  reset();
  const big = photoFile('IMG_4000x3000.jpg', 9 * 1024 * 1024);
  const out = await downscalePhoto(big);

  assert.notEqual(out, big, 'файл ушёл как был');
  assert.ok(out.size < big.size / 10, 'уменьшение почти ничего не дало: ' + out.size);
  assert.ok(/\.jpg$/.test(out.name), 'имя обязано говорить, что внутри JPEG: ' + out.name);
  assert.equal(out.type, 'image/jpeg');

  const cv = canvasesMade[canvasesMade.length - 1];
  assert.equal(cv.width, 1024);
  assert.equal(cv.height, 768);
  assert.equal(cv._type, 'image/jpeg');
  assert.equal(cv._q, limits.PHOTO_JPEG_QUALITY);
});

test('браузер не раскодировал (HEIC) — файл уходит как есть, а не теряется', async () => {
  reset();
  decodeFails = true;
  const f = photoFile('IMG_0001.heic', 3 * 1024 * 1024);
  assert.equal(await downscalePhoto(f), f, 'неудача уменьшения не должна ничего подменять');
});

test('пережатие, сделавшее тяжелее, отбрасывается — маленький PNG уходит собой', async () => {
  reset();
  // 900×900 меньше предела: уменьшать нечего, и трогать нечего.
  const small = new File([new Uint8Array(4096)], 'skrin_900x900.png', { type: 'image/png' });
  assert.equal(await downscalePhoto(small), small);
  // А здесь уменьшение произошло бы, но JPEG вышел БОЛЬШЕ исходника.
  const tiny = new File([new Uint8Array(64)], 'shum_2000x2000.png', { type: 'image/png' });
  assert.equal(await downscalePhoto(tiny), tiny, 'пережали в сторону увеличения');
});

// ===========================================================================
// Съёмка с веб-камеры — целиком
// ===========================================================================
test('съёмка с веб-камеры доходит до карты пациента: кадр → уменьшение → загрузка → photo_url', async () => {
  reset();
  const dlg = modal.buildPatientCreateDialog({});
  document.body.appendChild(dlg.overlay);

  // 1. «Сфотографировать» открывает окно камеры.
  const camBtn = walk(dlg.card).find((n) => n.attrs['aria-label'] === 'Сфотографировать');
  assert.ok(camBtn, 'кнопки съёмки нет');
  camBtn.click();
  await tick();
  const cam = overlays().find((o) => o !== dlg.overlay);
  assert.ok(cam, 'окно камеры не открылось');

  // 2. Поток пришёл — кнопка снимка разблокировалась.
  const snap = walk(cam).find((n) => n.tagName === 'BUTTON' && hasClass(n, 'btn-primary'));
  assert.ok(snap, 'кнопки «Сделать снимок» нет');
  assert.ok(!snap.hasAttribute('disabled'), 'кнопка снимка так и не разблокировалась');

  // 3. Снимок. Кадр рисуется на холст и уходит в тот же приёмник, что и файл
  //    с диска, — уменьшение и проверки для обоих одни.
  snap.click();
  await tick(40);
  assert.ok(stopped.length, 'камера не выключена после снимка — лампочка осталась гореть');
  assert.ok(dlg.state.photoFile, 'кадр не попал в окно');
  assert.ok(dlg.state.photoFile.size <= 1280 * 960, 'кадр не уменьшен: ' + dlg.state.photoFile.size);

  // 4. Сохранение пациента. Фотография уходит В СВОЮ КОРЗИНУ и по своей форме
  //    пути — той единственной, которую сервер принимает.
  dlg.fields.last_name.value = 'Каримова';
  dlg.fields.first_name.value = 'Азиза';
  dlg.fields.date_of_birth.value = '1990-04-01';
  dlg.setGender('F');
  const patient = await dlg.save();
  assert.ok(patient, 'пациент не сохранился: ' + toasts.join(' | '));

  assert.equal(uploads.length, 1, 'фотография не загружалась');
  const up = uploads[0];
  assert.equal(up.method, 'POST');
  assert.match(up.url, /^\/api\/storage\/patient-photos\/patients\/[^/]+$/,
    'путь не той формы, которую принимает сервер: ' + up.url);

  const row = inserted.find((i) => i.table === 'patients');
  assert.ok(row, 'пациент не вставлялся');
  assert.equal(row.values.photo_url, up.url, 'в карту уехала не та ссылка, по которой лежит файл');
});

test('камера недоступна — окно объясняет причину и снимок сделать нельзя', async () => {
  reset();
  cameraWorks = false;
  const dlg = modal.buildPatientCreateDialog({});
  document.body.appendChild(dlg.overlay);
  walk(dlg.card).find((n) => n.attrs['aria-label'] === 'Сфотографировать').click();
  await tick();
  const cam = overlays().find((o) => o !== dlg.overlay);
  const err = walk(cam).find((n) => hasClass(n, 'cam-err'));
  assert.ok(err && /камере/i.test(err.textContent), 'причина отказа камеры не показана');
  const snap = walk(cam).find((n) => n.tagName === 'BUTTON' && hasClass(n, 'btn-primary'));
  assert.ok(snap.hasAttribute('disabled'), 'снимок предлагается при неработающей камере');
});

// ===========================================================================
// Отказы — до отправки
// ===========================================================================
test('не картинку окно не берёт и говорит почему — ещё до загрузки', async () => {
  reset();
  const dlg = modal.buildPatientCreateDialog({});
  const pdf = new File([new Uint8Array(1024)], 'vypiska.pdf', { type: 'application/pdf' });
  assert.equal(await dlg.photo.acceptPhoto(pdf), null);
  assert.equal(dlg.state.photoFile, null, 'не картинка всё же попала в окно');
  assert.equal(uploads.length, 0, 'файл всё же ушёл на сервер');
  assert.ok(toasts.some((t) => /картинкой/.test(t) && /\.pdf/.test(t)),
    'отказ не назвал причину: ' + toasts.join(' | '));
});

test('HEIC с айфона: отказ говорит, что переключить, а не «формат не подходит»', async () => {
  reset();
  decodeFails = true;   // Chrome на Windows такой файл не раскодирует
  const dlg = modal.buildPatientCreateDialog({});
  assert.equal(await dlg.photo.acceptPhoto(photoFile('IMG_0001.heic', 4 * 1024 * 1024)), null);
  assert.equal(uploads.length, 0);
  assert.ok(toasts.some((t) => /JPEG/.test(t)), 'отказ не подсказал выход: ' + toasts.join(' | '));
});

test('слишком тяжёлое даже после уменьшения — отказ называет размер и предел', async () => {
  reset();
  decodeFails = true;   // уменьшить не вышло, значит уйдёт исходник
  const dlg = modal.buildPatientCreateDialog({});
  const huge = photoFile('ogromnoe.jpg', limits.MAX_PATIENT_PHOTO_BYTES + 1024);
  assert.equal(await dlg.photo.acceptPhoto(huge), null);
  assert.equal(uploads.length, 0, 'восемь мегабайт всё же поехали по сети');
  assert.ok(toasts.some((t) => /8 МБ/.test(t)), 'отказ не назвал предел: ' + toasts.join(' | '));
});

test('огромный кадр НЕ отбивается по размеру исходника — сначала уменьшаем, потом судим', async () => {
  reset();
  const dlg = modal.buildPatientCreateDialog({});
  // 12 МБ с телефона — обычный вторник в регистратуре. После уменьшения это
  // 0.8 МБ, то есть отказывать было бы не за что.
  const ok = await dlg.photo.acceptPhoto(photoFile('IMG_4000x3000.jpg', 12 * 1024 * 1024));
  assert.ok(ok, 'честную фотографию с телефона отбили: ' + toasts.join(' | '));
  assert.ok(ok.size < limits.MAX_PATIENT_PHOTO_BYTES);
  assert.equal(dlg.state.photoFile, ok);
});

test('сервер отказал — человек читает ЕГО объяснение, а не «ошибку загрузки»', async () => {
  reset();
  uploadStatus = 413;
  const dlg = modal.buildPatientCreateDialog({});
  await dlg.photo.acceptPhoto(photoFile('IMG_4000x3000.jpg', 9 * 1024 * 1024));
  dlg.fields.last_name.value = 'Каримова';
  dlg.fields.first_name.value = 'Азиза';
  dlg.fields.date_of_birth.value = '1990-04-01';
  dlg.setGender('F');
  const patient = await dlg.save();

  assert.ok(patient, 'карта не сохранилась из-за аватара — пациент важнее фотографии');
  assert.ok(toasts.some((t) => /предела в 8 МБ/.test(t)), 'текст сервера потерян: ' + toasts.join(' | '));
  const row = inserted.find((i) => i.table === 'patients');
  assert.ok(row && !row.values.photo_url, 'в карту уехала ссылка на файл, который не загрузился');
});

// ===========================================================================
// Уменьшение не должно было тронуть вложения карты пациента.
// ===========================================================================
test('вложения карты пациента уменьшение не трогает — их открывают, чтобы прочитать', async () => {
  const src = await import('node:fs').then((fs) => fs.readFileSync(
    new URL('../views/patient-card.js', import.meta.url), 'utf8'));
  assert.ok(!/photo-downscale/.test(src),
    'скан направления стали ужимать — мелкий текст в нём читать после этого нечем');
  // И правила фотографий к вложениям тоже не применены: у них свой предел.
  assert.ok(!/photoRefusal/.test(src), 'к вложениям применили правила портрета');
  assert.ok(limits.MAX_PATIENT_PHOTO_BYTES < limits.MAX_PATIENT_FILE_BYTES,
    'предел фотографии обязан отличаться от предела вложения — это разные вещи');
});

// ===========================================================================
// Фото врача. Настоящая проверка прав — по HTTP
// (server/routes/photo-storage.test.js): там врач ставит своё фото, не может
// поставить чужое, а администратор может. Здесь — одно звено, которое HTTP
// проверить не может: что БРАУЗЕР строит путь С ID ВРАЧА. Верни сюда прежний
// `doctors/<ключ>` — сервер ответит 400, и «Моё фото» замолчит ровно так, как
// молчало до этой правки.
// ===========================================================================
test('профиль врача кладёт фото под id врача, а не в общую папку', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../views/doctor-profile.js', import.meta.url), 'utf8');
    const m = /const photoPrefix = \(doctorId\) => (.+);/.exec(src);
    assert.ok(m, 'префикс пути фото врача больше не вычисляется из id: путь потеряет владельца');
    // Считаем его тем же выражением, что и модуль, и сверяем с формой,
    // которую принимает сервер: doctors/<id>/<ключ> — ровно три сегмента.
    const prefix = new Function('doctorId', 'return ' + m[1] + ';')(42);
    assert.equal(prefix, 'doctors/42/');
    assert.equal((prefix + '1757000000000-abc-photo.jpg').split('/').length, 3);
    assert.ok(/photoPrefix\(doctorId\)/.test(src), 'префикс объявлен, но при загрузке не используется');
});
