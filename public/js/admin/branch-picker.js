// js/admin/branch-picker.js — topbar branch multi-select. Single-owner.
import {
  getAvailableBranches, getSelectedBranchIds, setSelectedBranchIds,
  selectAllBranches, clearBranches, onBranchChange, isAllSelected,
} from './branch-context.js?v=bc3';
import { t } from './i18n.js';

export function renderBranchPicker(mount) {
  if (!mount) return;
  let open = false;

  const summary = () => {
    const all = getAvailableBranches();
    const sel = new Set(getSelectedBranchIds());
    if (sel.size === 0) return t('branch.none', 'No branch');
    if (isAllSelected()) return t('branch.all', 'All branches');
    if (sel.size === 1) { const b = all.find((x) => sel.has(x.id)); return b ? b.name : '1'; }
    return (t('branch.nSelected', '{n} branches')).replace('{n}', String(sel.size));
  };

  function paint() {
    mount.innerHTML = '';
    const all = getAvailableBranches();
    if (all.length === 0) return; // no branches available: show nothing
    if (all.length === 1) {       // single branch: show only its name (no picker)
      const single = document.createElement('span');
      single.className = 'branch-picker-single';
      single.style.cssText = 'font-size:12.5px;font-weight:600;color:var(--ink-600,#324049);white-space:nowrap;padding:0 4px;';
      single.textContent = all[0].name;
      mount.appendChild(single);
      return;
    }

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'branch-picker-btn';
    btn.innerHTML = `<span class="bp-label">${t('branch.label', 'Branch')}:</span> <span class="bp-summary"></span> <span class="bp-caret">▾</span>`;
    btn.querySelector('.bp-summary').textContent = summary();
    btn.addEventListener('click', (e) => { e.stopPropagation(); open = !open; pop.style.display = open ? 'block' : 'none'; });

    const pop = document.createElement('div');
    pop.className = 'branch-picker-pop';
    pop.style.display = 'none';
    pop.addEventListener('click', (e) => e.stopPropagation());

    const list = document.createElement('div');
    list.className = 'bp-list';
    const sel = new Set(getSelectedBranchIds());
    for (const b of all) {
      const row = document.createElement('label');
      row.className = 'bp-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = sel.has(b.id);
      cb.addEventListener('change', () => {
        const next = new Set(getSelectedBranchIds());
        if (cb.checked) next.add(b.id); else next.delete(b.id);
        setSelectedBranchIds([...next]); // triggers branch:change -> repaint via listener
      });
      row.appendChild(cb);
      const span = document.createElement('span'); span.textContent = b.name; row.appendChild(span);
      list.appendChild(row);
    }

    const actions = document.createElement('div');
    actions.className = 'bp-actions';
    const allBtn = document.createElement('button');
    allBtn.type = 'button'; allBtn.textContent = t('branch.selectAll', 'Select all');
    allBtn.addEventListener('click', () => selectAllBranches());
    const clrBtn = document.createElement('button');
    clrBtn.type = 'button'; clrBtn.textContent = t('branch.clear', 'Clear');
    clrBtn.addEventListener('click', () => clearBranches());
    actions.appendChild(allBtn); actions.appendChild(clrBtn);

    pop.appendChild(actions); pop.appendChild(list);
    mount.appendChild(btn); mount.appendChild(pop);
  }

  // close on outside click
  document.addEventListener('click', () => {
    const pop = mount.querySelector('.branch-picker-pop');
    if (pop) { pop.style.display = 'none'; open = false; }
  });

  onBranchChange(() => paint());
  paint();
}
