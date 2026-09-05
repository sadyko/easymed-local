// CONTROL_PLANE_V2 — the clinics board. Replaces the old flat table with cards
// grouped into three bands — Needs attention / Live / Retired — so the clinics
// that need a decision surface at the top instead of being buried
// alphabetically among healthy ones. Every rule that decides band membership,
// dot tone, the version chip, and every formatted figure lives in
// panel-logic.js (see its own tests, "CONTROL_PLANE_V2: the board's bands") —
// this file only calls those pure functions and paints the result; no band or
// severity logic is re-implemented inline here.
//
// Search / Compact / Show retired all operate over the ALREADY-fetched `rows`
// array — no re-fetch per keystroke or per toggle, same rule the table
// version followed. Resolving a filial's parent name is a single .find() over
// that same in-memory array per card: with clinic counts in the low hundreds
// that stays O(n) per render (not per keystroke, and not a network round
// trip), which is the same complexity budget the table's per-row rendering
// already spent — it just now also carries a name lookup instead of a bare id.

import { cp, ApiError } from './panel-api.js';
import { esc } from './panel-dom.js';
import {
  attentionReasons, clinicBand, versionChip, formatStat, formatRetiredAt,
  formatLastSeen, subscriptionBadge,
} from './panel-logic.js';
import { openNewClinicModal } from './panel-new-clinic.js';
// panel-card-menu.js does not exist yet (a later task adds it) — importing it
// now is deliberate: the kebab menu is this file's only way to act on a card,
// and until that module lands the board simply won't load, which is the
// correct, visible failure mode rather than a silently stubbed-out kebab.
import { openCardMenu } from './panel-card-menu.js';

const BANDS = [
  { key: 'attention', label: 'Needs attention' },
  { key: 'live', label: 'Live' },
  { key: 'retired', label: 'Retired' },
];

// The four attentionReasons() strings serious enough to paint the dot red
// instead of amber — kept here (not in panel-logic.js) because it is purely a
// *display* mapping from reason text to dot colour, not a decision about what
// counts as a problem in the first place; that decision is attentionReasons()
// itself.
const BAD_DOT_REASONS = new Set(['never installed', 'unpaid', 'subscription lapsed', 'far behind on updates']);

export async function renderClinicsList(root) {
  root.innerHTML = `
    <div class="board-bar">
      <input class="search" id="cl-search" placeholder="Search by name or clinic id…">
      <button class="btn small" id="cl-compact" type="button">Compact</button>
      <button class="btn small" id="cl-retired" type="button">Show retired</button>
      <button class="btn primary" id="cl-new" type="button">New clinic</button>
    </div>
    <div id="cl-board"><div class="row-loading"><div class="spinner"></div>Loading clinics…</div></div>
  `;

  let rows = [];
  let search = '';
  let compact = false;
  let showRetired = false;

  const compactBtn = root.querySelector('#cl-compact');
  const retiredBtn = root.querySelector('#cl-retired');

  root.querySelector('#cl-new').addEventListener('click', () => {
    openNewClinicModal({ onCreated: load });
  });
  root.querySelector('#cl-search').addEventListener('input', (e) => {
    search = e.target.value.trim().toLowerCase();
    renderBoard();
  });
  compactBtn.addEventListener('click', () => {
    compact = !compact;
    compactBtn.classList.toggle('on', compact);
    renderBoard();
  });
  retiredBtn.addEventListener('click', () => {
    showRetired = !showRetired;
    retiredBtn.classList.toggle('on', showRetired);
    renderBoard();
  });

  // Resolves against the FULL fetched array, not the currently-filtered/
  // visible one — a filial whose parent got filtered out by search must still
  // show its parent's name, not fall back to the id as if the parent were
  // unknown.
  function parentName(id) {
    const parent = rows.find((r) => r.id === id);
    return parent ? parent.name : id;
  }

  // mute (retired) | ok (nothing wrong) | bad (one of the four serious
  // reasons) | warn (anything else attentionReasons() surfaces). Delegates
  // entirely to attentionReasons() — this only maps its output to a colour.
  function dotTone(c) {
    if (!c.active) return 'mute';
    const reasons = attentionReasons(c);
    if (reasons.length === 0) return 'ok';
    return reasons.some((r) => BAD_DOT_REASONS.has(r)) ? 'bad' : 'warn';
  }

  function versionFactValue(c) {
    const version = esc(c.last_version || '—');
    const chip = versionChip(c.versions_behind);
    return chip ? `${version} <span class="chip ${esc(chip.tone)}">${esc(chip.label)}</span>` : version;
  }

  function factRowsHtml(c) {
    const versionFact = `<div class="cc-fact"><span>Version</span><b>${versionFactValue(c)}</b></div>`;
    const lastSeenFact = `<div class="cc-fact"><span>Last seen</span><b>${esc(formatLastSeen(c.last_seen_at))}</b></div>`;

    if (!c.active) {
      return `${versionFact}<div class="cc-fact"><span>Retired</span><b>${esc(formatRetiredAt(c.retired_at))}</b></div>${lastSeenFact}`;
    }
    const sub = subscriptionBadge(c.subscription, c.subscription_until);
    return `${versionFact}<div class="cc-fact"><span>Subscription</span><b><span class="badge ${esc(sub.tone)}">${esc(sub.label)}</span></b></div>${lastSeenFact}`;
  }

  function statsHtml(c) {
    const stats = (c.latest_stats && typeof c.latest_stats === 'object') ? c.latest_stats : {};
    return `
      <div class="cc-stats">
        <div><b>${esc(formatStat(stats.patients_total))}</b>patients</div>
        <div><b>${esc(formatStat(stats.visits_today))}</b>visits today</div>
        <div><b>${esc(formatStat(stats.billed_today))}</b>billed today</div>
      </div>
    `;
  }

  function modsHtml(c) {
    const mods = Array.isArray(c.modules) ? c.modules : [];
    return mods.length
      ? `<div class="cc-mods">${mods.map((m) => `<span class="mod-chip">${esc(m)}</span>`).join('')}</div>`
      : '<div class="cc-mods"><span class="none">no modules</span></div>';
  }

  function cardHtml(c) {
    const band = clinicBand(c);
    const classes = ['cc'];
    if (band === 'attention') classes.push('attention');
    if (band === 'retired') classes.push('retired');

    const family = c.parent_clinic_id
      ? `filial of ${parentName(c.parent_clinic_id)}`
      : (c.filial_count > 0 ? `${c.filial_count} filial${c.filial_count === 1 ? '' : 's'}` : '');
    const subLine = family ? `${esc(c.id)} · ${esc(family)}` : esc(c.id);

    return `
      <div class="${classes.join(' ')}" data-card data-id="${esc(c.id)}">
        <div class="cc-head">
          <span class="cc-dot ${esc(dotTone(c))}"></span>
          <div>
            <div class="cc-name">${esc(c.name)}</div>
            <div class="cc-sub">${subLine}</div>
          </div>
          <button class="cc-kebab" type="button" data-kebab aria-label="Clinic actions">&bull;&bull;&bull;</button>
        </div>
        ${factRowsHtml(c)}
        ${statsHtml(c)}
        ${modsHtml(c)}
      </div>
    `;
  }

  function newTileHtml() {
    return `<div class="cc new" id="cl-new-tile" role="button" tabindex="0">+ New clinic</div>`;
  }

  function bindCardEvents(boardEl) {
    boardEl.querySelectorAll('[data-card]').forEach((card) => {
      const id = card.dataset.id;
      card.addEventListener('click', () => { location.hash = `#clinics/${encodeURIComponent(id)}`; });
      const kebab = card.querySelector('[data-kebab]');
      if (kebab) {
        kebab.addEventListener('click', (e) => {
          e.stopPropagation(); // the kebab must never also trigger the card's own navigate-on-click
          const clinic = rows.find((r) => r.id === id);
          if (clinic) openCardMenu({ anchor: kebab, clinic, onChanged: load });
        });
      }
    });
    const newTile = boardEl.querySelector('#cl-new-tile');
    if (newTile) {
      const open = () => openNewClinicModal({ onCreated: load });
      newTile.addEventListener('click', open);
      newTile.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      });
    }
  }

  function renderBoard() {
    const boardEl = root.querySelector('#cl-board');
    if (!boardEl) return; // navigated away while a fetch was in flight

    if (rows.length === 0) {
      boardEl.innerHTML = `<div class="card"><div class="empty">No clinics yet.</div></div>`;
      return;
    }

    let visible = rows;
    if (search) {
      visible = rows.filter((c) => c.name.toLowerCase().includes(search) || c.id.toLowerCase().includes(search));
    }
    if (visible.length === 0) {
      boardEl.innerHTML = `<div class="card"><div class="empty">No clinics match this search.</div></div>`;
      return;
    }

    const grouped = { attention: [], live: [], retired: [] };
    visible.forEach((c) => { grouped[clinicBand(c)].push(c); });

    let placedNewTile = false;
    const sections = [];
    for (const band of BANDS) {
      if (band.key === 'retired' && !showRetired) continue; // hidden unless the toggle is on
      const list = grouped[band.key];
      if (list.length === 0) continue; // a band with no cards is not drawn

      const cardsHtml = list.map(cardHtml).join('') + (placedNewTile ? '' : newTileHtml());
      placedNewTile = true;

      sections.push(`
        <div class="band"><span>${esc(band.label)}</span><span class="rule"></span><span class="count">${list.length}</span></div>
        <div class="deck${compact ? ' compact' : ''}">${cardsHtml}</div>
      `);
    }

    boardEl.innerHTML = sections.join('');
    bindCardEvents(boardEl);
  }

  async function load() {
    const boardEl = root.querySelector('#cl-board');
    try {
      const data = await cp.clinics();
      rows = data.clinics.slice().sort((a, b) => a.name.localeCompare(b.name));
      renderBoard();
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) {
        // A 401 is already handled by the panel-wide session-expired hook
        // (login screen takes over); anything else must show a real message
        // here instead of leaving the "Loading…" spinner running forever.
        if (boardEl) {
          boardEl.innerHTML = `<div class="card"><div class="load-err">Failed to load clinics: ${esc(e.message)}<br><button class="btn small" id="cl-retry">Retry</button></div></div>`;
          const retry = root.querySelector('#cl-retry');
          if (retry) retry.addEventListener('click', load);
        }
      }
    }
  }

  await load();
}
