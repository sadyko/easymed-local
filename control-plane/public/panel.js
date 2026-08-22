// CONTROL_PLANE_PANEL_V1 — the panel's own bootstrap: login, app shell, and
// hash-based routing between the two sections (Clinics, Requests). This file
// is deliberately thin — the actual screens live in panel-clinics-list.js /
// panel-clinic-detail.js / panel-requests.js, and every decision they make
// is delegated to panel-logic.js's pure functions (see that file's tests).

import { cp, ApiError, setUnauthorizedHandler } from './panel-api.js';
import { esc } from './panel-dom.js';
import { renderClinicsList } from './panel-clinics-list.js';
import { renderClinicDetail } from './panel-clinic-detail.js';
import { renderRequests } from './panel-requests.js';

const root = document.getElementById('panel-root');

let me = null;
let hashListenerBound = false;

const LOGO_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="28" height="28"><path d="M4 12 L8 12 L10 6 L12 18 L14 9 L16 12 L20 12"/></svg>';

// SESSION_EXPIRED_HOOK_V1 — every /cp/v1 call goes through panel-api.js's
// api(); a 401 from ANY of them (not just this file's own calls) fires this
// exact hook, which is the one place that decides what "logged out" looks
// like. Deliberately does NOT touch location.hash: the whole point is that
// re-logging in resumes wherever the owner was (see router() below), rather
// than bouncing them back to the clinics list after an expired session cut
// them off mid-task.
setUnauthorizedHandler(() => showLogin());

async function boot() {
  try {
    const data = await cp.me();
    me = data.user;
    showShell();
  } catch (e) {
    // A 401 here already triggered showLogin() via the hook above. Anything
    // else (network down, the process not running) must still say so rather
    // than leaving the boot spinner running forever.
    if (!(e instanceof ApiError) || e.status !== 401) {
      root.classList.remove('loading');
      root.innerHTML = `<div class="gate"><div class="gate-card"><div class="boot-logo">${LOGO_SVG}</div><h1>Could not start</h1><p>${esc(e.message || 'Unknown error.')}</p></div></div>`;
    }
  }
}

// ---------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------
function showLogin() {
  root.classList.remove('loading');
  root.innerHTML = `
    <div class="gate">
      <div class="gate-card">
        <div class="boot-logo">${LOGO_SVG}</div>
        <h1>Control Plane</h1>
        <p>Sign in with your vendor account.</p>
        <input id="lg-user" class="gate-input" placeholder="Username" autocomplete="username" autofocus>
        <input id="lg-pass" class="gate-input" placeholder="Password" type="password" autocomplete="current-password">
        <button id="lg-btn" class="gate-btn">Sign in</button>
        <div id="lg-err" class="gate-err"></div>
      </div>
    </div>
  `;
  const userI = document.getElementById('lg-user');
  const passI = document.getElementById('lg-pass');
  const btn = document.getElementById('lg-btn');
  const err = document.getElementById('lg-err');

  const doLogin = async () => {
    err.textContent = '';
    const username = userI.value.trim();
    const password = passI.value;
    if (!username || !password) { err.textContent = 'Enter your username and password.'; return; }
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    try {
      const data = await cp.login(username, password);
      me = data.user;
      showShell();
    } catch (e) {
      err.textContent = e.message || 'Sign-in failed.';
      btn.disabled = false;
      btn.textContent = 'Sign in';
    }
  };
  btn.addEventListener('click', doLogin);
  passI.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  userI.addEventListener('keydown', (e) => { if (e.key === 'Enter') passI.focus(); });
}

// ---------------------------------------------------------------------
// Shell + routing
// ---------------------------------------------------------------------
const SECTIONS = ['clinics', 'requests'];

function showShell() {
  root.classList.remove('loading');
  root.innerHTML = `
    <nav class="navbar">
      <div class="navbar-brand"><span class="brand-mark">${LOGO_SVG}</span>Easy-Med · Control Plane</div>
      <div class="navbar-links">
        <a class="nav-link" data-nav="clinics" href="#clinics">Clinics</a>
        <a class="nav-link" data-nav="requests" href="#requests">Requests</a>
      </div>
      <div class="navbar-user">
        <span class="who">${esc(me?.full_name || me?.username || '')}</span>
        <button class="signout" id="signout-btn" type="button">Sign out</button>
      </div>
    </nav>
    <div class="content" id="cp-content"></div>
  `;
  document.getElementById('signout-btn').addEventListener('click', async () => {
    try { await cp.logout(); } catch { /* best-effort — show the login screen regardless */ }
    showLogin();
  });

  if (!hashListenerBound) {
    window.addEventListener('hashchange', router);
    hashListenerBound = true;
  }
  router();
}

function currentSection() {
  const raw = (location.hash || '').replace(/^#\/?/, '');
  const [section, id] = raw.split('/');
  return { section: SECTIONS.includes(section) ? section : 'clinics', id: id ? decodeURIComponent(id) : null };
}

function router() {
  const content = document.getElementById('cp-content');
  if (!content) return; // the shell isn't mounted (e.g. we're on the login screen) — nothing to route into

  const { section, id } = currentSection();
  document.querySelectorAll('.nav-link[data-nav]').forEach((a) => {
    a.classList.toggle('on', a.dataset.nav === section);
  });

  // Fire-and-forget with a catch, matching platform-console's own navigate():
  // a thrown error inside a view must never become an unhandled rejection
  // that silently leaves the previous screen's stale content on display.
  const render = section === 'requests'
    ? renderRequests(content)
    : (id ? renderClinicDetail(content, id) : renderClinicsList(content));

  Promise.resolve(render).catch((e) => {
    content.innerHTML = `<div class="card"><div class="load-err">Something went wrong: ${esc(e?.message || String(e))}</div></div>`;
  });
}

boot();
