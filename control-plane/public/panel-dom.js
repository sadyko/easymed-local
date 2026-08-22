// CONTROL_PLANE_PANEL_V1 — small DOM helpers shared by every view.
//
// XSS: clinic names and contact details are VENDOR-entered but render
// everywhere in this panel (list rows, modal titles, tab labels). Every
// dynamic value that goes into an innerHTML template MUST pass through esc()
// first — same convention platform-console/js/setting.js uses (see its own
// esc()). This file has exactly one such helper, used everywhere, rather
// than each view re-typing the escape map.
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// One toast at a time — a second call replaces the first rather than
// stacking, matching platform-console's own toast().
export function toast(msg, kind = 'ok') {
  document.querySelectorAll('.toast').forEach((el) => el.remove());
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; }, 2500);
  setTimeout(() => t.remove(), 3000);
}

// Clinic-facing dates are day-only ('YYYY-MM-DD'); check-in timestamps are
// full ISO instants. Both render in the vendor's local time zone — this is
// the owner's own back office, not a clinic-facing screen with a fixed
// locale requirement.
export function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

// Renders a code (enrollment or unlock) as separately-spaced groups, matching
// the "large, monospaced, letter-spaced" requirement — grouping comes from
// panel-logic.js's codeGroups() so display always matches how the server
// formatted the code, never a re-flow invented here.
export function renderCodeGroups(container, groups) {
  container.textContent = '';
  container.classList.add('code-display');
  groups.forEach((g, i) => {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'code-sep';
      sep.textContent = '–'; // en dash, purely visual — never part of the copied value
      container.appendChild(sep);
    }
    const span = document.createElement('span');
    span.className = 'code-group';
    span.textContent = g;
    container.appendChild(span);
  });
}

// Copies to the clipboard with a graceful fallback: some environments (older
// browsers, non-HTTPS-but-not-localhost, denied permission) don't have
// navigator.clipboard — the button must never throw and leave the owner
// stuck relying on this UI.
export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the legacy path below */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    return true;
  } catch {
    return false;
  }
}
