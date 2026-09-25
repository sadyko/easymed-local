// CRM_HEAD_MERGE_TAGS_V1 (2026-09-25) — «ДУБЛИКАТЫ»: СЛИЯНИЕ КАРТОЧЕК ОДНОГО НОМЕРА.
//
// Владелец: «merge duplicates». Решено (сказано владельцу): список групп
// карточек с одним номером; в каждой группе человек выбирает, какая карточка
// ОСТАНЕТСЯ (заранее выбрана та, что предлагает сервер, suggested_id);
// «Объединить» переносит в неё услуги, задачи, заметки и метки, остальные
// выбранные карточки удаляются. Отменить слияние нельзя — поэтому кнопка
// сначала спрашивает, и вопрос стоит ПРЯМО В ГРУППЕ, а не отдельным окном.
//
// РЕВЬЮ (2026-09-25):
//   • галочки у карточек: сливаются только отмеченные (I2b) — так из группы
//     убирают другого человека на том же номере (I3) или карточку другого
//     пациента (M3: запрет разных пациентов — по отмеченным);
//   • оставить можно только разрешённую карточку: есть среди отмеченных заявка
//     в работе — только заявку в работе (правило общее с сервером,
//     crm-merge-logic.js);
//   • разные имена — предупреждение «Разные имена — возможно, разные люди»;
//   • задачи, которые уедут на карточку другого оператора, — сказано вслух.
//
// Открывают администратор и руководитель колл-центра (`crm.all`): кнопку
// рисует доска по canSeeAllLeads(), а сервер (rpc/crm-merge.js) проверяет то
// же право ещё раз.

import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast, Tag, fmtDateTime } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { formatPhone } from '../phone-format.js';
import { tagKind } from '../crm-settings-logic.js?v=crmcfg1';
import { allowedSurvivors, suggestSurvivor, patientConflict, namesDiffer } from './crm-merge-logic.js';

/**
 * Окно «Дубликаты». onMerged() — после каждого удачного слияния (доска
 * перерисовывается, окно остаётся открытым: групп обычно несколько).
 */
export function openCrmDuplicates({ onMerged } = {}) {
    const overlay = h('div', { class: 'modal', 'data-crm-duplicates': '' });
    const close = () => overlay.remove();
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));
    const bodyEl = h('div', { class: 'modal-body', style: { overflowY: 'auto' } },
        h('div', { class: 'muted' }, 'Загрузка…'));

    overlay.appendChild(h('div', { class: 'modal-card', style: { width: '780px', maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100vh - 60px)', display: 'flex', flexDirection: 'column' } },
        h('header', { class: 'modal-head' },
            h('h2', null, Icon('Copy', { size: 16 }), ' ', 'Дубликаты'),
            h('button', { class: 'modal-close', type: 'button', 'aria-label': 'Закрыть', onclick: close }, '×')),
        bodyEl,
        h('footer', { class: 'modal-foot' },
            h('span', { class: 'muted', style: { fontSize: '12.5px' } },
                'Отметьте карточки одного человека и выберите, какая останется, — остальные отмеченные вольются в неё.'),
            h('span', { class: 'grow' }),
            h('button', { class: 'btn', type: 'button', onclick: close }, 'Закрыть'))));
    document.body.appendChild(overlay);

    let left = 0;   // сколько групп ещё на экране
    async function load() {
        const { data, error } = await supabase.rpc('crm_duplicate_groups', {});
        clear(bodyEl);
        if (error) {
            bodyEl.appendChild(h('div', { class: 'empty' }, trf('Не удалось загрузить дубликаты: {msg}', { msg: error.message })));
            return;
        }
        const groups = (data && Array.isArray(data.groups)) ? data.groups : [];
        if (!groups.length) {
            bodyEl.appendChild(h('div', { class: 'empty', 'data-dup-empty': '' }, 'Дубликатов нет — у каждого номера одна карточка.'));
            return;
        }
        bodyEl.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px', marginBottom: '10px' } },
            trf('Групп: {n}', { n: data.total != null ? data.total : groups.length })));
        left = groups.length;
        for (const g of groups) bodyEl.appendChild(groupCard(g));
    }

    function groupCard(g) {
        const box = h('div', { class: 'card', 'data-dup-group': g.key, style: { padding: '12px 14px', marginBottom: '12px' } });
        const cards = Array.isArray(g.cards) ? g.cards : [];
        const byId = new Map(cards.map((c) => [String(c.id), c]));
        const ticked = new Set(cards.map((c) => String(c.id)));
        let keep = g.suggested_id != null ? String(g.suggested_id) : (cards[0] ? String(cards[0].id) : '');
        const name = 'dup-keep-' + g.key;

        const tickedCards = () => cards.filter((c) => ticked.has(String(c.id)));
        const allowedIds = () => new Set(allowedSurvivors(tickedCards()).map((c) => String(c.id)));
        // Оставшаяся обязана быть отмеченной и разрешённой; иначе — предложение
        // по отмеченным (то же правило, что у сервера).
        function settleKeep() {
            if (!allowedIds().has(keep)) {
                const s = suggestSurvivor(tickedCards());
                keep = s == null ? '' : String(s);
            }
        }

        box.appendChild(h('div', { class: 'row', style: { gap: '8px', marginBottom: '8px', alignItems: 'center' } },
            Icon('Phone', { size: 14 }),
            h('span', { class: 'cell-strong num' }, formatPhone(g.phone) || g.phone || g.key),
            h('span', { class: 'muted', style: { fontSize: '12.5px' } }, trf('Карточек: {n}', { n: cards.length }))));

        const list = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } });
        const notes = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '8px' } });
        const foot = h('div', { class: 'row', style: { gap: '8px', marginTop: '10px', alignItems: 'center', flexWrap: 'wrap' } });
        box.appendChild(list);
        box.appendChild(notes);
        box.appendChild(foot);

        function paintList() {
            clear(list);
            const allowed = allowedIds();
            for (const c of cards) {
                const id = String(c.id);
                const on = ticked.has(id);
                const tick = h('input', { type: 'checkbox', 'aria-label': trf('Объединять заявку №{id}', { id: c.id }), 'data-dup-tick': id });
                tick.checked = on;
                tick.addEventListener('change', () => {
                    if (tick.checked) ticked.add(id); else ticked.delete(id);
                    settleKeep(); repaint();
                });
                const radio = h('input', { type: 'radio', name, value: id, 'aria-label': trf('Оставить заявку №{id}', { id: c.id }), 'data-dup-keep': id });
                radio.checked = id === keep;
                radio.disabled = !on || !allowed.has(id);
                radio.addEventListener('change', () => { if (radio.checked) { keep = id; repaint(); } });
                const facts = [
                    Tag(c.stage_label || c.status, { kind: tagKind(c.stage_color), dot: true }),
                    c.stage_kind === 'open' ? Tag('в работе', { kind: 'info' }) : null,
                    c.patient_id != null ? Tag(c.patient_mrn ? trf('Карта {mrn}', { mrn: c.patient_mrn }) : 'Карта заведена', { kind: 'ok' }) : null,
                    c.assigned_name ? Tag(trf('Ведёт {name}', { name: c.assigned_name }), { kind: 'teal' }) : null,
                    c.lines ? Tag(trf('Услуг: {n}', { n: c.lines }), { kind: '' }) : null,
                    c.tasks ? Tag(trf('Задач: {n}', { n: c.tasks }), { kind: '' }) : null,
                ].filter(Boolean);
                list.appendChild(h('div', {
                    class: 'row', 'data-dup-card': id,
                    style: { gap: '10px', alignItems: 'flex-start', padding: '8px 10px', border: '1px solid var(--ink-200)', borderRadius: '10px', opacity: on ? '1' : '0.55' },
                },
                    tick,
                    radio,
                    h('div', { style: { flex: 1, minWidth: 0 } },
                        h('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap', alignItems: 'baseline' } },
                            h('span', { class: 'cell-strong' }, trf('№{id}', { id: c.id })),
                            h('span', { style: { overflowWrap: 'anywhere' } }, c.full_name || c.patient_name || tr('Без имени')),
                            c.patient_name && c.patient_name !== c.full_name ? h('span', { class: 'muted', style: { fontSize: '12.5px' } }, c.patient_name) : null,
                            h('span', { class: 'muted', style: { fontSize: '12.5px' } }, fmtDateTime(c.created_at))),
                        h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap', marginTop: '4px' } }, ...facts))));
            }
        }

        const warn = (attr, text) => h('div', { class: 'muted', [attr]: '', style: { fontSize: '12.5px' } }, Icon('Warning', { size: 13 }), ' ', text);

        function paintNotes() {
            clear(notes);
            const sel = tickedCards();
            if (namesDiffer(sel)) notes.appendChild(warn('data-dup-names', 'Разные имена — возможно, разные люди. Снимите галочку с карточки другого человека.'));
            if (sel.some((c) => c.stage_kind === 'open') && sel.some((c) => c.stage_kind !== 'open')) {
                notes.appendChild(warn('data-dup-open', 'Среди отмеченных есть заявка в работе — остаться может только она.'));
            }
            // M1 — задачи уедут на карточку, которую ведёт другой оператор.
            const k = byId.get(keep);
            if (k) {
                const others = sel.filter((c) => String(c.id) !== keep);
                const ownerId = k.assigned_to != null ? k.assigned_to : (others.find((c) => c.assigned_to != null) || {}).assigned_to;
                const owner = ownerId != null ? ([k, ...others].find((c) => c.assigned_to === ownerId) || {}).assigned_name : '';
                if (ownerId != null && others.some((c) => c.tasks && c.assigned_to !== ownerId)) {
                    notes.appendChild(warn('data-dup-tasks',
                        trf('Задачи из вливаемых карточек перейдут в карточку, которую ведёт {name}. Исполнители задач по-прежнему их видят.', { name: owner || tr('другой оператор') })));
                }
            }
        }

        function paintFoot() {
            clear(foot);
            const sel = tickedCards();
            if (patientConflict(sel)) {
                foot.appendChild(warn('data-dup-conflict', 'Отмеченные карточки привязаны к разным пациентам — объединить их нельзя. Снимите галочку с чужой карточки.'));
                return;
            }
            if (sel.length < 2 || !keep) {
                foot.appendChild(h('span', { class: 'muted', 'data-dup-few': '', style: { fontSize: '12.5px' } }, 'Отметьте хотя бы две карточки.'));
                return;
            }
            foot.appendChild(h('span', { class: 'grow' }));
            foot.appendChild(h('button', { class: 'btn btn-primary btn-sm', type: 'button', 'data-dup-merge': '', onclick: askSure },
                Icon('Layers', { size: 13 }), ' ', 'Объединить'));
        }

        function repaint() { paintList(); paintNotes(); paintFoot(); }

        // Вопрос — на месте кнопки: что уйдёт, куда, и что вернуть нельзя.
        function askSure() {
            clear(foot);
            const others = tickedCards().filter((c) => String(c.id) !== keep).map((c) => c.id);
            foot.appendChild(h('span', { 'data-dup-confirm': '', style: { fontSize: '13.5px', flex: '1 1 260px' } },
                trf('Влить в №{id} остальные карточки ({n})? Услуги, задачи, заметки и метки перейдут в неё, остальные карточки будут удалены. Отменить это нельзя.',
                    { n: others.length, id: keep })));
            foot.appendChild(h('button', { class: 'btn btn-sm', type: 'button', onclick: paintFoot }, 'Отмена'));
            const go = h('button', { class: 'btn btn-primary btn-sm', type: 'button', 'data-dup-merge-yes': '' }, 'Да, объединить');
            go.addEventListener('click', async () => {
                go.disabled = true;
                const { error } = await supabase.rpc('crm_merge_leads', { keep_id: Number(keep), merge_ids: others });
                if (error) { toast(trf('Не удалось объединить: {msg}', { msg: error.message }), 'fail'); paintFoot(); return; }
                toast(trf('Карточки объединены в №{id}', { id: keep }), 'ok');
                box.remove();
                try { if (onMerged) await onMerged(); } catch (e) { /* доска перерисуется при следующем открытии */ }
                if (--left <= 0) await load();   // последняя группа слита — «дубликатов нет»
            });
            foot.appendChild(go);
        }

        settleKeep();
        repaint();
        return box;
    }

    load();
    return overlay;
}
