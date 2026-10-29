// SOFTPHONE_V1 (2026-10-29) — задача 8: переключатель у каждого сотрудника,
// вопрос при закрытии страницы во время звонка, телефон выключается при выходе.
//
// Владелец выбрал «Switch per operator»: флаг «принимать звонки» в localStorage
// у каждого сотрудника свой (ключ + номер сотрудника), а гарнитура — у
// компьютера. Закрыть или перезагрузить страницу во время звонка — браузер
// спрашивает (beforeunload). Выход: идёт разговор — спросить; «Отмена» — выхода
// нет; дальше телефон выключается, но выбор сотрудника остаётся до его входа.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── Подставной браузер ───────────────────────────────────────────────────────
const store = new Map([['admin.lang', 'ru']]);
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};
const LOG = [];
const listeners = [];
let CONFIRM = true;
const CONFIRMS = [];
const location = { hostname: 'localhost', reload: () => { LOG.push('reload'); } };
globalThis.location = location;   // auth.js зовёт location.reload() без window.
globalThis.window = {
  isSecureContext: false, location,
  addEventListener: (type, fn) => { listeners.push([type, fn]); },
  dispatchEvent(e) { for (const [t, fn] of [...listeners]) if (t === e.type) fn(e); return true; },
  confirm: (m) => { CONFIRMS.push(String(m)); return CONFIRM; },
  easymed: { state: { user: null } },
};
// BroadcastChannel вкладок: все каналы одного имени в этом процессе — «вкладки».
const CHANNELS = [];
const POSTED = [];
globalThis.BroadcastChannel = class {
  constructor(name) { this.name = name; this.onmessage = null; this.closed = false; CHANNELS.push(this); }
  postMessage(data) {
    POSTED.push({ name: this.name, data });
    for (const c of CHANNELS) if (c !== this && !c.closed && c.name === this.name && c.onmessage) c.onmessage({ data });
  }
  close() { this.closed = true; }
};
globalThis.document = { documentElement: { lang: 'ru' }, body: { appendChild: (el) => el }, createElement: () => ({ style: {}, setAttribute() {} }) };
Object.defineProperty(globalThis, 'navigator', { value: { languages: ['ru'], language: 'ru', mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } }, configurable: true, writable: true });
globalThis.CustomEvent = class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } };
globalThis.fetch = async (url, init = {}) => {
  LOG.push((init.method || 'GET') + ' ' + url);
  return { ok: true, status: 200, json: async () => ({}) };
};

const B = await import('../softphone-browser.js');
const { SP_FLAG } = await import('../softphone.js');
const user = (id) => { window.easymed.state.user = id == null ? null : { id, full_name: 'Сотрудник ' + id }; };

/** Подставной телефон для выхода: busy() по заказу, disable() — в общий журнал. */
function fakePhone(busy) {
  const f = { disables: [], busy: () => busy, disable: (o) => { f.disables.push(o); LOG.push('disable ' + JSON.stringify(o || {})); } };
  return f;
}

// ── Флаг у каждого сотрудника ────────────────────────────────────────────────
test('флаг «принимать звонки» у каждого сотрудника свой: включил первый — у второго на том же компьютере не включён', async () => {
  const sp = B.getSoftphone();
  user(1);
  await sp.enable();   // адрес без защиты — ошибка, но выбор запомнен
  assert.equal(store.get(SP_FLAG + '.1'), '1');
  assert.equal(store.has(SP_FLAG), false, 'общий для компьютера ключ');
  assert.equal(sp.wanted(), true);
  user(2);
  assert.equal(sp.wanted(), false, 'выбор сотрудника 1 включил бы телефон сотруднику 2');
  sp.disable();
  assert.equal(store.get(SP_FLAG + '.1'), '1', 'выключение у второго сняло выбор первого');
  user(1);
  sp.disable({ keepWanted: true });
  assert.equal(store.get(SP_FLAG + '.1'), '1');
  sp.disable();
  assert.equal(store.has(SP_FLAG + '.1'), false);
});

test('сотрудник неизвестен (до входа) — флага нет: не читается и не пишется', async () => {
  const sp = B.getSoftphone();
  user(null);
  await sp.enable();
  assert.equal([...store.keys()].filter((k) => k.startsWith(SP_FLAG)).length, 0, 'флаг записан без сотрудника');
  assert.equal(sp.wanted(), false);
  store.set(SP_FLAG, '1');   // старый общий ключ — не считается ничьим выбором
  assert.equal(sp.wanted(), false);
  store.delete(SP_FLAG);
  sp.disable();
});

test('хранилище телефона: флаг — с номером сотрудника, прочие ключи — как есть; гарнитура общая для компьютера', () => {
  const s = B.softphoneStorage;
  user(7);
  s.setItem(SP_FLAG, '1');
  assert.equal(store.get(SP_FLAG + '.7'), '1');
  assert.equal(s.getItem(SP_FLAG), '1');
  user(8);
  assert.equal(s.getItem(SP_FLAG), null, 'чужой выбор виден');
  s.removeItem(SP_FLAG);
  assert.equal(store.get(SP_FLAG + '.7'), '1', 'чужой выбор снят');
  user(7);
  s.removeItem(SP_FLAG);
  assert.equal(store.has(SP_FLAG + '.7'), false);
  s.setItem('другой.ключ', 'x');
  assert.equal(store.get('другой.ключ'), 'x');
  store.delete('другой.ключ');
  // Гарнитура — у компьютера: выбор сотрудника 7 виден сотруднику 8.
  B.saveDevice('in', 'mic-1');
  user(8);
  assert.equal(B.savedDevice('in'), 'mic-1');
  assert.equal(store.get('easymed.softphone.in'), 'mic-1');
  B.saveDevice('in', '');
});

// ── Закрыть страницу во время звонка ─────────────────────────────────────────
test('закрыть или перезагрузить страницу во время звонка — браузер спрашивает; без звонка — нет; обработчик один', () => {
  B.getSoftphone(); B.getSoftphone();
  const guards = listeners.filter(([t]) => t === 'beforeunload');
  assert.equal(guards.length, 1, 'обработчик beforeunload не один');
  const fire = () => {
    const e = { prevented: false, returnValue: undefined, preventDefault() { this.prevented = true; } };
    guards[0][1](e);
    return e;
  };
  try {
    for (const [busy, want] of [[true, true], [false, false]]) {
      B.setSoftphoneForTests({ busy: () => busy });
      const e = fire();
      assert.equal(e.prevented, want, 'busy=' + busy);
      assert.equal(e.returnValue, want ? '' : undefined);
    }
    B.setSoftphoneForTests(null);
    assert.equal(fire().prevented, false, 'настоящий телефон без звонка');
  } finally {
    B.setSoftphoneForTests(null);
  }
});

// ── Вкладку закрыли или перезагрузили — номер выходит из АТС ─────────────────
// pagehide приходит уже после того, как человек согласился уйти (beforeunload
// выше): телефон выключается, пока соединение с АТС ещё открыто, — JsSIP
// успевает сказать «выхожу» (REGISTER expires=0). Выбор «принимать звонки»
// остаётся: после перезагрузки телефон включится сам, а вторая вкладка
// подхватит его, если первую закрыли.
test('вкладку закрыли или перезагрузили — телефон выключается с выбором сотрудника; выключенный не трогаем; обработчик один', async () => {
  B.getSoftphone(); B.getSoftphone();
  const hides = listeners.filter(([t]) => t === 'pagehide');
  assert.equal(hides.length, 1, 'обработчик pagehide не один');
  const fire = () => hides[0][1]({ type: 'pagehide', persisted: false });
  try {
    for (const state of ['ready', 'ringing', 'in_call', 'connecting', 'error', 'other_tab']) {
      const fake = fakePhone(false);
      fake.get = () => ({ state });
      B.setSoftphoneForTests(fake);
      fire();
      assert.deepEqual(fake.disables, [{ keepWanted: true }], state);
    }
    const off = fakePhone(false);
    off.get = () => ({ state: 'off' });
    B.setSoftphoneForTests(off);
    fire();
    assert.deepEqual(off.disables, [], 'выключенный телефон выключают ещё раз');
  } finally {
    B.setSoftphoneForTests(null);
  }
  // Настоящий телефон страницы: включён (ошибка адреса) → выключен, флаг сотрудника цел.
  const sp = B.getSoftphone();
  user(3);
  await sp.enable();
  assert.notEqual(sp.get().state, 'off');
  fire();
  assert.equal(sp.get().state, 'off');
  assert.equal(store.get(SP_FLAG + '.3'), '1', 'после перезагрузки телефон не включится сам');
  sp.disable();
  user(null);
});

// ── Выход ────────────────────────────────────────────────────────────────────
const { signOutAndReload } = await import('../auth.js');

test('выход во время разговора: вопрос; «Отмена» — ни выхода, ни выключения; «ОК» — телефон выключен (выбор остаётся), выход, перезагрузка', async () => {
  const fake = fakePhone(true);
  B.setSoftphoneForTests(fake);
  try {
    LOG.length = 0; CONFIRMS.length = 0;
    CONFIRM = false;
    await signOutAndReload();
    assert.deepEqual(CONFIRMS, ['Идёт разговор. Завершить звонок и выйти?']);
    assert.deepEqual(LOG, [], '«Отмена», а выход или выключение случились');
    CONFIRM = true;
    await signOutAndReload();
    assert.deepEqual(LOG, ['disable {"keepWanted":true}', 'POST /api/auth/logout', 'reload']);
  } finally {
    B.setSoftphoneForTests(null);
    CONFIRM = true;
  }
});

test('выход: то, что оболочка чистит перед выходом (beforeLeave), — только после «ОК»; «Отмена» ничего не теряет', async () => {
  const fake = fakePhone(true);
  B.setSoftphoneForTests(fake);
  const beforeLeave = () => { LOG.push('beforeLeave'); };
  try {
    LOG.length = 0;
    CONFIRM = false;
    assert.equal(await signOutAndReload({ beforeLeave }), false);
    assert.deepEqual(LOG, [], '«Отмена», а выбор просмотра роли уже стёрт');
    CONFIRM = true;
    assert.equal(await signOutAndReload({ beforeLeave }), true);
    assert.deepEqual(LOG, ['disable {"keepWanted":true}', 'beforeLeave', 'POST /api/auth/logout', 'reload']);
  } finally {
    B.setSoftphoneForTests(null);
    CONFIRM = true;
  }
  // Оболочка отдаёт свою чистку (выбор просмотра роли) сюда, а не делает её до вопроса.
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const admin = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'admin.js'), 'utf8');
  const logout = /function logout\(\) \{([\s\S]*?)\n\}/.exec(admin);
  assert.ok(logout, 'logout() в admin.js не найден');
  assert.match(logout[1], /signOutAndReload\(\{\s*beforeLeave/, 'выбор просмотра роли стирается до вопроса о звонке');
});

test('выход без звонка: без вопроса, телефон выключен с выбором сотрудника, выход', async () => {
  const fake = fakePhone(false);
  B.setSoftphoneForTests(fake);
  try {
    LOG.length = 0; CONFIRMS.length = 0;
    await signOutAndReload();
    assert.deepEqual(CONFIRMS, []);
    assert.deepEqual(fake.disables, [{ keepWanted: true }]);
    assert.deepEqual(LOG, ['disable {"keepWanted":true}', 'POST /api/auth/logout', 'reload']);
  } finally {
    B.setSoftphoneForTests(null);
  }
});

test('вопросы — на трёх языках, в uz/en без кириллицы', async () => {
  const { setLang } = await import('../i18n.js');
  const { STRINGS } = await import('../i18n-strings.js');
  for (const k of ['Идёт разговор. Завершить звонок и выйти?', 'Идёт разговор. Завершить звонок и продолжить?']) {
    const e = STRINGS[k];
    assert.ok(e && e.ru === k && e.uz && e.en, k);
    assert.doesNotMatch(e.uz + e.en, /[Ѐ-ӿ]/, k);
  }
  const fake = fakePhone(true);
  B.setSoftphoneForTests(fake);
  try {
    setLang('en');
    CONFIRMS.length = 0;
    CONFIRM = false;
    await signOutAndReload();
    assert.equal(CONFIRMS[0], STRINGS['Идёт разговор. Завершить звонок и выйти?'].en);
  } finally {
    setLang('ru');
    CONFIRM = true;
    B.setSoftphoneForTests(null);
  }
});

// ── Финальное ревью ──────────────────────────────────────────────────────────
// I3: выход в одной вкладке гасит телефон во всех вкладках этого браузера
// (BroadcastChannel «easymed-softphone», запасной путь — событие storage), а
// сессия, которой больше нет (ответ 401), гасит телефон своей вкладки.
// M6: хранилище недоступно — флаг «не прочитан» (undefined), а не «нет флага».
// I1: «до сервера не дошли» — код unreachable, временный сбой АТС — его код.
test('выход в другой вкладке (BroadcastChannel или storage): телефон этой вкладки выключается, выбор сотрудника остаётся', () => {
  B.getSoftphone();
  const fake = fakePhone(false);
  B.setSoftphoneForTests(fake);
  try {
    const other = new BroadcastChannel('easymed-softphone');   // «другая вкладка»
    other.postMessage({ type: 'logout' });
    assert.deepEqual(fake.disables, [{ keepWanted: true }], 'сообщение о выходе не выключило телефон');
    other.postMessage({ type: 'что-то другое' });
    assert.equal(fake.disables.length, 1);
    const storageL = listeners.filter(([t]) => t === 'storage');
    assert.equal(storageL.length, 1, 'запасного пути через storage нет');
    storageL[0][1]({ type: 'storage', key: 'easymed.softphone.logout', newValue: '123' });
    assert.equal(fake.disables.length, 2, 'storage-событие о выходе не выключило телефон');
    storageL[0][1]({ type: 'storage', key: 'другой.ключ', newValue: '1' });
    assert.equal(fake.disables.length, 2);
    other.close();
  } finally {
    B.setSoftphoneForTests(null);
  }
});

test('выход объявляется другим вкладкам — после вопроса о звонке; «Отмена» — не объявляется; ключ storage не остаётся', async () => {
  const fake = fakePhone(true);
  B.setSoftphoneForTests(fake);
  // Ревью 09094415 (D): запасной путь — записать ключ и сразу стереть: событие
  // storage в других вкладках уже ушло, а в хранилище ключ не копится.
  const KEY = 'easymed.softphone.logout';
  const OPS = [];
  const keepLS = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: keepLS.getItem,
    setItem: (k, v) => { if (k === KEY) OPS.push('set'); keepLS.setItem(k, v); },
    removeItem: (k) => { if (k === KEY) OPS.push('remove'); keepLS.removeItem(k); },
  };
  try {
    POSTED.length = 0;
    store.delete(KEY);
    CONFIRM = false;
    await signOutAndReload();
    assert.deepEqual(POSTED, [], '«Отмена», а другие вкладки уже выключили телефон');
    assert.deepEqual(OPS, []);
    CONFIRM = true;
    await signOutAndReload();
    assert.deepEqual(POSTED.map((p) => [p.name, p.data]), [['easymed-softphone', { type: 'logout' }]]);
    assert.deepEqual(OPS, ['set', 'remove'], 'запасной путь (storage) не записан или ключ не стёрт');
    assert.equal(store.has(KEY), false, 'ключ выхода остался в хранилище');
  } finally {
    globalThis.localStorage = keepLS;
    B.setSoftphoneForTests(null);
    CONFIRM = true;
  }
});

// Ревью 09094415 (A): выход в другой вкладке или конец сессии (401) во время
// разговора его не обрывают — звонок идёт напрямую с АТС, и человек его
// договорит. Телефон выключится один раз, когда разговор кончится. Пока звонит
// (не ответили) или звонка нет — выключается сразу. Своя вкладка — по-прежнему
// вопрос и выключение (тесты выхода выше).
function livePhone(state) {
  const f = fakePhone(false);
  const subs = new Set();
  let cur = { state };
  f.subs = subs;
  f.busy = () => cur.state === 'calling' || cur.state === 'in_call';
  f.get = () => cur;
  f.subscribe = (fn) => { subs.add(fn); return () => { subs.delete(fn); }; };
  f.push = (st) => { cur = { state: st }; for (const fn of [...subs]) fn(cur); };
  return f;
}
const otherTabLogout = () => { const o = new BroadcastChannel('easymed-softphone'); o.postMessage({ type: 'logout' }); o.close(); };
const otherTabStorage = () => { for (const [t, fn] of listeners) if (t === 'storage') fn({ type: 'storage', key: 'easymed.softphone.logout', newValue: '1' }); };
const sessionGone = () => window.dispatchEvent(new CustomEvent('easymed:session-gone'));

test('выход в другой вкладке и конец сессии во время разговора: разговор не обрывается, телефон выключается один раз — когда разговор кончился', () => {
  B.getSoftphone();
  for (const [st, path] of [['in_call', ['in_call', 'ready']], ['calling', ['in_call', 'ready']], ['calling', ['ready']], ['in_call', ['error']]]) {
    for (const fire of [otherTabLogout, otherTabStorage, sessionGone, () => { otherTabLogout(); otherTabStorage(); sessionGone(); }]) {
      const fake = livePhone(st);
      B.setSoftphoneForTests(fake);
      try {
        fire();
        assert.deepEqual(fake.disables, [], st + ': разговор оборван');
        for (const next of path.slice(0, -1)) { fake.push(next); assert.deepEqual(fake.disables, [], st + ' → ' + next); }
        fake.push(path[path.length - 1]);
        assert.deepEqual(fake.disables, [{ keepWanted: true }], st + ': разговор кончился, а телефон не выключился');
        fake.push('ready'); fake.push('ringing');
        assert.equal(fake.disables.length, 1, st + ': выключился больше одного раза');
        assert.equal(fake.subs.size, 0, st + ': подписка на телефон осталась');
      } finally {
        B.setSoftphoneForTests(null);
      }
    }
  }
});

test('ждём конца разговора, а телефон выключили иначе (свой выход, закрыли вкладку) — второго выключения нет', () => {
  B.getSoftphone();
  // Свой выход (releasePhone) во время ожидания — одно выключение, ожидание снято.
  const a = livePhone('in_call');
  B.setSoftphoneForTests(a);
  try {
    otherTabLogout();
    assert.deepEqual(a.disables, []);
    B.releasePhone();
    assert.deepEqual(a.disables, [{ keepWanted: true }]);
    assert.equal(a.subs.size, 0, 'ожидание конца разговора осталось');
    a.push('ready');
    assert.equal(a.disables.length, 1, 'выключился второй раз');
  } finally {
    B.setSoftphoneForTests(null);
  }
  // Разговор кончился выключением (pagehide, переключатель) — выходить уже не из чего.
  const b = livePhone('in_call');
  B.setSoftphoneForTests(b);
  try {
    sessionGone();
    b.push('off');
    assert.deepEqual(b.disables, [], 'выключенный телефон выключают ещё раз');
    assert.equal(b.subs.size, 0);
  } finally {
    B.setSoftphoneForTests(null);
  }
});

test('выход в другой вкладке и конец сессии, пока звонит или без звонка — телефон выключается сразу', () => {
  B.getSoftphone();
  for (const st of ['ringing', 'ready', 'connecting', 'error', 'other_tab']) {
    for (const fire of [otherTabLogout, otherTabStorage, sessionGone]) {
      const fake = livePhone(st);
      B.setSoftphoneForTests(fake);
      try {
        fire();
        assert.deepEqual(fake.disables, [{ keepWanted: true }], st);
        assert.equal(fake.subs.size, 0, st + ': подписка не нужна');
      } finally {
        B.setSoftphoneForTests(null);
      }
    }
  }
});

test('сессии больше нет (сервер ответил 401 «unauthorized») — телефон этой вкладки выключается с выбором сотрудника', async () => {
  B.getSoftphone();
  const fake = fakePhone(false);
  B.setSoftphoneForTests(fake);
  const keepFetch = globalThis.fetch;
  const flush = () => new Promise((r) => setTimeout(r, 0));
  // Ответ 401 с кодом; clone() — как у настоящего Response: тело читают дважды.
  const resp401 = (code) => {
    const body = code ? { error: { code, message: 'Нужно войти в систему.' } } : null;
    return { ok: false, status: 401, json: async () => { if (!body) throw new SyntaxError('пустое тело'); return body; }, clone: () => resp401(code) };
  };
  try {
    window.dispatchEvent(new CustomEvent('easymed:session-gone'));
    assert.deepEqual(fake.disables, [{ keepWanted: true }]);
    // Ответ 401 «unauthorized» на любой запрос программы (опрос, RPC) — то самое событие.
    globalThis.fetch = async () => resp401('unauthorized');
    const { supabase } = await import('../../supabase.js');
    await supabase.rpc('telephony_live', {});
    assert.equal(fake.disables.length, 2, '401 от RPC не выключил телефон');
    await supabase.from('patients').select('id');
    await flush();
    assert.equal(fake.disables.length, 3, '401 от /api/db не выключил телефон');
    // Ревью 09094415 (B): 401 не о сессии — неверный пароль при входе, при
    // смене пароля, — или без кода: сессия жива, телефон не трогаем.
    for (const code of ['invalid_credentials', '']) {
      globalThis.fetch = async () => resp401(code);
      await supabase.rpc('telephony_live', {});
      await supabase.from('patients').select('id');
      await supabase.auth.signInWithPassword({ username: 'u', password: 'p' });
      await flush();
      assert.equal(fake.disables.length, 3, '401 «' + code + '» выключил телефон');
    }
    // Ответ без clone() (старые стенды) — без падения и без события.
    globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: { code: 'unauthorized' } }) });
    const r = await supabase.from('patients').select('id');
    assert.ok(r && r.error, 'запрос упал вместо ошибки');
    await flush();
  } finally {
    globalThis.fetch = keepFetch;
    B.setSoftphoneForTests(null);
  }
});

test('хранилище телефона: localStorage бросает — флаг «не прочитан» (undefined), а не «нет флага» (null)', () => {
  user(5);
  const keep = globalThis.localStorage;
  globalThis.localStorage = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('x'); }, removeItem() { throw new Error('x'); } };
  try {
    assert.equal(B.softphoneStorage.getItem(SP_FLAG), undefined);
  } finally {
    globalThis.localStorage = keep;
  }
  store.delete(SP_FLAG + '.5');
  assert.equal(B.softphoneStorage.getItem(SP_FLAG), null, 'флага нет');
  user(null);
  assert.equal(B.softphoneStorage.getItem(SP_FLAG), null, 'сотрудник неизвестен — флага нет');
});

test('вход телефона: сервер не ответил (сеть) — код unreachable; временный сбой АТС — station_unavailable', async () => {
  const sp = B.getSoftphone();
  const keepFetch = globalThis.fetch;
  user(9);
  window.isSecureContext = true;
  try {
    globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
    await sp.enable();
    assert.deepEqual([sp.get().state, sp.get().reason, sp.get().code], ['error', 'server', 'unreachable']);
    globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: { code: 'station_unavailable', message: 'Нет связи с телефонией. Проверьте интернет на этом компьютере.' } }) });
    await sp.enable();
    assert.deepEqual([sp.get().state, sp.get().code], ['error', 'station_unavailable']);
    globalThis.fetch = async () => ({ ok: false, status: 403, json: async () => ({ error: { code: 'forbidden', message: 'Номер не назначен.' } }) });
    await sp.enable();
    assert.deepEqual([sp.get().state, sp.get().code], ['error', 'forbidden']);
  } finally {
    globalThis.fetch = keepFetch;
    window.isSecureContext = false;
    sp.disable();
    user(null);
  }
});
