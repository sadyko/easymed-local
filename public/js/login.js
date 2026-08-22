import { api } from './api.js';

const form = document.getElementById('login-form');
const err = document.getElementById('login-error');

// FIRST_RUN_PASSWORD_V1 — the second card on this page: set a new password.
const npForm = document.getElementById('newpass-form');
const npErr = document.getElementById('newpass-error');

// Where a successful login lands: the clinic system itself — patients, the
// laboratory, the cashier. `/users` is only the bare account-management page
// from the Phase-1 foundation and has no navigation of its own, so sending
// people there after login left them on a dead end with no route into the app.
const APP_HOME = '/admin.html';

// The password the user just signed in with, held only until the forced change
// completes — /auth/change-password re-verifies it (walked-away-PC rule), and
// asking the user to retype the password they typed ten seconds ago is noise.
let currentPassword = null;

function showNewPasswordForm() {
  form.hidden = true;
  npForm.hidden = false;
  npForm.querySelector('input').focus();
}

// Already signed in? Go straight to the app — unless the account still carries
// the first-run default, in which case the server would refuse everything
// anyway, so show the change form instead. currentPassword is unknown on this
// path (the session came from a cookie, not a fresh sign-in); the form falls
// back to asking login first, which is the sign-in flow they should take.
api('/auth/me').then(({ user }) => {
  if (!user.must_change_password) location.href = APP_HOME;
  // Signed in but must change: without the current password in hand the change
  // call cannot succeed — make them sign in again so we have it.
}).catch(() => {});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  err.textContent = '';
  const btn = form.querySelector('button');
  btn.disabled = true;
  try {
    const { user } = await api('/auth/login', {
      method: 'POST',
      body: { username: form.username.value, password: form.password.value },
    });
    if (user.must_change_password) {
      currentPassword = form.password.value;
      showNewPasswordForm();
      return;
    }
    location.href = APP_HOME;
  } catch (ex) {
    err.textContent = ex.message;
  } finally {
    btn.disabled = false;
  }
});

npForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  npErr.textContent = '';
  const pw1 = npForm.new_password.value;
  const pw2 = npForm.new_password2.value;
  if (pw1 !== pw2) {
    npErr.textContent = 'Passwords do not match.';
    return;
  }
  if (currentPassword === null) {
    // Landed here from an old cookie session, not a fresh sign-in — the change
    // endpoint needs the current password, so route through the login form.
    npForm.hidden = true;
    form.hidden = false;
    err.textContent = 'Please sign in first.';
    return;
  }
  const btn = npForm.querySelector('button');
  btn.disabled = true;
  try {
    await api('/auth/change-password', {
      method: 'POST',
      body: { current_password: currentPassword, new_password: pw1 },
    });
    currentPassword = null;
    location.href = APP_HOME;
  } catch (ex) {
    npErr.textContent = ex.message;
  } finally {
    btn.disabled = false;
  }
});
