import { api } from './api.js';

const ROLES = ['admin', 'registrar', 'doctor', 'cashier', 'lab', 'nurse', 'inventory'];
let me = null;

async function boot() {
  try { me = (await api('/auth/me')).user; } catch { return; } // api() redirects to login
  document.getElementById('whoami').textContent = `${me.full_name || me.username} (${me.role})`;
  document.getElementById('logout').addEventListener('click', async () => {
    // Best-effort server-side kill; the navigation must happen even if the
    // server is unreachable (shared clinic PC must never look signed-in).
    try { await api('/auth/logout', { method: 'POST' }); } finally { location.href = '/'; }
  });
  if (me.role !== 'admin') {
    document.querySelector('table').remove();
    document.getElementById('add-form').remove();
    const p = document.createElement('p');
    p.textContent = 'Only administrators can manage users.';
    document.querySelector('.page').append(p);
    return;
  }
  const roleSelect = document.getElementById('a-role');
  for (const r of ROLES) roleSelect.append(new Option(r, r));
  roleSelect.value = 'registrar'; // least-privilege default, not 'admin'
  document.getElementById('add-form').addEventListener('submit', onAdd);
  render();
}

async function render() {
  const { users } = await api('/users');
  const tbody = document.getElementById('user-rows');
  tbody.replaceChildren();
  for (const u of users) {
    const tr = document.createElement('tr');
    if (!u.is_active) tr.classList.add('inactive');
    tr.append(cell(u.username), cell(u.full_name), roleCell(u), activeCell(u), actionsCell(u));
    tbody.append(tr);
  }
}

function cell(text) { const td = document.createElement('td'); td.textContent = text ?? ''; return td; }

function roleCell(u) {
  const td = document.createElement('td');
  const sel = document.createElement('select');
  for (const r of ROLES) sel.append(new Option(r, r, false, r === u.role));
  sel.disabled = u.id === me.id;
  sel.addEventListener('change', () => update(u.id, { role: sel.value }));
  td.append(sel);
  return td;
}

function activeCell(u) {
  const td = document.createElement('td');
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = !!u.is_active;
  box.disabled = u.id === me.id;
  box.addEventListener('change', () => update(u.id, { is_active: box.checked }));
  td.append(box);
  return td;
}

function actionsCell(u) {
  const td = document.createElement('td');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ghost';
  btn.textContent = 'Reset password';
  btn.addEventListener('click', async () => {
    const pw = prompt(`New password for ${u.username} (min 8 characters):`);
    if (pw === null) return;
    await update(u.id, { password: pw });
  });
  td.append(btn);
  return td;
}

async function update(id, patch) {
  try { await api(`/users/${id}`, { method: 'PATCH', body: patch }); }
  catch (e) { alert(e.message); }
  render();
}

async function onAdd(e) {
  e.preventDefault();
  const f = e.target;
  document.getElementById('add-error').textContent = '';
  try {
    await api('/users', {
      method: 'POST',
      body: { username: f.username.value, password: f.password.value, full_name: f.full_name.value, role: f.role.value },
    });
    f.reset();
    render();
  } catch (ex) {
    document.getElementById('add-error').textContent = ex.message;
  }
}

boot();
