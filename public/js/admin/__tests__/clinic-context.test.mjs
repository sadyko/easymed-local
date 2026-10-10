// CLINIC_AFTER_LOGIN_V1 — window.CLINIC must survive a fresh login.
//
// The bug this pins: admin.js boot() resolves the clinic BEFORE it resolves the
// user (initClinicContext at :2219, rehydrateUserFromSession at :2227), but
// /api/rpc sits behind requireAuth. On a first login there is no session cookie
// yet, so get_clinic_by_slug answers 401, loadClinicBySlug swallows it and
// returns null, and window.CLINIC stays null for the WHOLE page lifetime —
// initClinicContext only ever runs once, at boot.
//
// Every screen gated on currentClinicId() then degrades silently. lab-settings
// is the one that says so out loud: «Не удалось загрузить: нет привязки к
// клинике (window.CLINIC пуст)» — which a laborant hits right after saving a
// panel, because savePanel() calls reload() on success.

import { test } from 'node:test';
import assert from 'node:assert';
import { ensureClinicContext, refreshClinicBrand } from '../clinic-context.js';

// Minimal supabase double: .rpc(name, args) resolving to {data, error}.
function mockSupabase(result) {
  const calls = [];
  return {
    calls,
    rpc(name, args) { calls.push([name, args]); return Promise.resolve(result); },
  };
}

const CLINIC = { id: 1, slug: 'local', name: 'Ann Family Clinic', active: true };

test('fills window.CLINIC when boot left it null', async () => {
  globalThis.window = { CLINIC: null, location: { hostname: '192.168.100.10' } };
  const supabase = mockSupabase({ data: CLINIC, error: null });

  const out = await ensureClinicContext(supabase);

  assert.strictEqual(window.CLINIC.id, 1);
  assert.strictEqual(window.CLINIC.name, 'Ann Family Clinic');
  assert.strictEqual(out.id, 1);
  assert.strictEqual(supabase.calls.length, 1, 'must actually ask for the clinic');
});

test('does not re-fetch when boot already resolved the clinic', async () => {
  globalThis.window = { CLINIC: CLINIC, location: { hostname: '192.168.100.10' } };
  const supabase = mockSupabase({ data: CLINIC, error: null });

  await ensureClinicContext(supabase);

  assert.strictEqual(supabase.calls.length, 0, 'a resolved clinic must not be re-fetched on every call');
});

// A clinic that still cannot be resolved must not throw: the app degrades, it
// does not fail to boot. This is what makes the fix safe to call unconditionally.
test('tolerates an RPC that still fails', async () => {
  globalThis.window = { CLINIC: null, location: { hostname: '192.168.100.10' } };
  const supabase = mockSupabase({ data: null, error: { message: 'Login required.' } });

  const out = await ensureClinicContext(supabase);

  assert.strictEqual(out, null);
  assert.strictEqual(window.CLINIC, null);
});

// CLINIC_API_FIX_V1 — «обновить бренд» перечитывает клинику даже когда она уже
// известна (после сохранения «Компании» она устарела), а сбой перечитывания не
// гасит ни window.CLINIC, ни имя под меню.
function brandDom() {
  const sub = { textContent: '' };
  globalThis.document = { querySelector: (sel) => (sel === '.brand-sub' ? sub : null) };
  return sub;
}

test('refreshClinicBrand re-reads a resolved clinic and repaints the line under the menu', async () => {
  const sub = brandDom();
  globalThis.window = { CLINIC: CLINIC, CLINIC_SLUG: null, location: { hostname: '192.168.100.10' } };
  const supabase = mockSupabase({ data: { ...CLINIC, name: 'Ann Family Clinic Plus' }, error: null });

  await refreshClinicBrand(supabase);

  assert.strictEqual(supabase.calls.length, 1, 'a saved «Компания» makes the cached clinic stale — must re-read');
  assert.strictEqual(window.CLINIC.name, 'Ann Family Clinic Plus');
  assert.strictEqual(sub.textContent, 'Ann Family Clinic Plus');
});

test('refreshClinicBrand keeps the old clinic and name when the re-read fails', async () => {
  const sub = brandDom();
  sub.textContent = 'Ann Family Clinic';
  globalThis.window = { CLINIC: CLINIC, CLINIC_SLUG: null, location: { hostname: '192.168.100.10' } };
  const supabase = mockSupabase({ data: null, error: { message: 'offline' } });

  const out = await refreshClinicBrand(supabase);

  assert.strictEqual(out, CLINIC);
  assert.strictEqual(window.CLINIC, CLINIC);
  assert.strictEqual(sub.textContent, 'Ann Family Clinic');
});

// CLINIC_PROFILE_V1 — шапка программы: название под меню — на языке
// интерфейса (UZ / EN из «Компании», иначе прежнее), квадратный логотип —
// в знаке меню #sidebar-logo (тот же элемент сворачивает меню).
function shellDom(lang) {
  const sub = { textContent: '' };
  const mkNode = (tag) => {
    const n = {
      tagName: String(tag).toUpperCase(), className: '', attrs: {}, children: [], parent: null,
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
      appendChild(c) { c.parent = this; this.children.push(c); return c; },
      remove() { if (this.parent) { this.parent.children = this.parent.children.filter((x) => x !== this); this.parent = null; } },
      querySelector(sel) { return sel === 'img.brand-logo' ? (this.children.find((c) => c.tagName === 'IMG' && c.className === 'brand-logo') || null) : null; },
    };
    n.classList = {
      add: (c) => { const l = n.className.split(/\s+/).filter(Boolean); if (!l.includes(c)) l.push(c); n.className = l.join(' '); },
      remove: (c) => { n.className = n.className.split(/\s+/).filter((x) => x && x !== c).join(' '); },
      contains: (c) => n.className.split(/\s+/).includes(c),
    };
    return n;
  };
  const mark = mkNode('div');
  mark.className = 'brand-mark';
  mark.appendChild(mkNode('svg'));   // «+» — остаётся, его прячет CSS
  globalThis.document = {
    documentElement: { lang },
    createElement: mkNode,
    querySelector: (sel) => (sel === '.brand-sub' ? sub : null),
    getElementById: (id) => (id === 'sidebar-logo' ? mark : null),
  };
  return { sub, mark };
}

test('название под меню — на языке интерфейса: UZ из «Компании»; EN без перевода — прежнее', async () => {
  const { paintClinicBrand, clinicNameFor } = await import('../clinic-context.js');
  let dom = shellDom('uz');
  globalThis.window = { CLINIC: { id: 1, name: 'Шифо', name_uz: 'Shifo' }, location: { hostname: 'localhost' } };
  paintClinicBrand();
  assert.strictEqual(dom.sub.textContent, 'Shifo');

  dom = shellDom('en');
  paintClinicBrand();
  assert.strictEqual(dom.sub.textContent, 'Шифо', 'name_en пуст — прежнее название');

  dom = shellDom('ru');
  globalThis.window.CLINIC = { id: 1, name: 'Шифо', name_uz: 'Shifo', name_en: 'Shifo Clinic' };
  paintClinicBrand();
  assert.strictEqual(dom.sub.textContent, 'Шифо', 'на русском — то, что печатается');
  assert.strictEqual(clinicNameFor(globalThis.window.CLINIC, 'en'), 'Shifo Clinic');
  assert.strictEqual(clinicNameFor(null, 'uz'), '');
});

test('квадратный логотип в знаке меню: есть — картинка и has-logo; нет — «+» как был', async () => {
  const { paintClinicBrand } = await import('../clinic-context.js');
  const { mark } = shellDom('ru');
  const LOGO = 'data:image/png;base64,iVBORw0KGgo=';
  globalThis.window = { CLINIC: { id: 1, name: 'Шифо', logo_mark_url: LOGO }, location: { hostname: 'localhost' } };
  paintClinicBrand();
  assert.ok(mark.classList.contains('has-logo'));
  const img = mark.querySelector('img.brand-logo');
  assert.ok(img, 'нет картинки логотипа в знаке меню');
  assert.strictEqual(img.attrs.src, LOGO);
  assert.strictEqual(img.attrs.alt, '', 'знак — украшение: название стоит рядом');
  assert.ok(mark.children.some((c) => c.tagName === 'SVG'), '«+» не удаляется — его прячет CSS');

  paintClinicBrand();   // повтор — та же одна картинка
  assert.strictEqual(mark.children.filter((c) => c.tagName === 'IMG').length, 1);

  globalThis.window.CLINIC = { id: 1, name: 'Шифо', logo_mark_url: null };
  paintClinicBrand();
  assert.strictEqual(mark.querySelector('img.brand-logo'), null);
  assert.ok(!mark.classList.contains('has-logo'));
});
