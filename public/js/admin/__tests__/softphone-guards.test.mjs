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
  dispatchEvent() { return true; },
  confirm: (m) => { CONFIRMS.push(String(m)); return CONFIRM; },
  easymed: { state: { user: null } },
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
