import { api } from './api.js';

const form = document.getElementById('login-form');
const err = document.getElementById('login-error');

// Where a successful login lands: the clinic system itself — patients, the
// laboratory, the cashier. `/users` is only the bare account-management page
// from the Phase-1 foundation and has no navigation of its own, so sending
// people there after login left them on a dead end with no route into the app.
const APP_HOME = '/admin.html';

// Already signed in? Go straight to the app.
api('/auth/me').then(() => { location.href = APP_HOME; }).catch(() => {});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  err.textContent = '';
  const btn = form.querySelector('button');
  btn.disabled = true;
  try {
    await api('/auth/login', {
      method: 'POST',
      body: { username: form.username.value, password: form.password.value },
    });
    location.href = APP_HOME;
  } catch (ex) {
    err.textContent = ex.message;
  } finally {
    btn.disabled = false;
  }
});
