// CRM_HEAD_MERGE_TAGS_V1 (2026-09-25) — «ДУБЛИКАТЫ»: СЛИЯНИЕ КАРТОЧЕК ОДНОГО НОМЕРА.
//
// Владелец: «merge duplicates». Решено (сказано владельцу): список групп
// карточек с одним номером; в каждой группе человек выбирает, какая карточка
// ОСТАНЕТСЯ (заранее выбрана самая продвинутая — дошедшая — или та, у которой
// есть пациент; это предлагает сервер, suggested_id); «Объединить» переносит
// в неё услуги, задачи, заметки и метки, остальные карточки удаляются.
// Отменить слияние нельзя — поэтому кнопка сначала спрашивает, и вопрос стоит
// ПРЯМО В ГРУППЕ, а не отдельным окном: видно, что именно сольётся.
//
// Группа, где карточки привязаны к РАЗНЫМ пациентам (conflict), не сливается:
// один номер на семью — обычное дело. Вместо кнопки — причина.
//
// Открывают администратор и руководитель колл-центра (`crm.all`): кнопку
// рисует доска по canSeeAllLeads(), а сервер (rpc/crm-merge.js) проверяет то
// же право ещё раз.

import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast, Tag, fmtDateTime } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { formatPhone } from '../phone-format.js';
import { tagKind } from '../crm-settings-logic.js?v=crmcfg1';

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
                'Карточки с одним номером телефона. Выберите, какая останется, — остальные вольются в неё.'),
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
        let keep = g.suggested_id != null ? String(g.suggested_id) : String(g.cards[0].id);
        const name = 'dup-keep-' + g.key;

        box.appendChild(h('div', { class: 'row', style: { gap: '8px', marginBottom: '8px', alignItems: 'center' } },
            Icon('Phone', { size: 14 }),
            h('span', { class: 'cell-strong num' }, formatPhone(g.phone) || g.phone || g.key),
            h('span', { class: 'muted', style: { fontSize: '12.5px' } }, trf('Карточек: {n}', { n: g.cards.length }))));

        const list = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } });
        for (const c of g.cards) {
            const radio = h('input', { type: 'radio', name, value: String(c.id), 'aria-label': trf('Оставить заявку №{id}', { id: c.id }), 'data-dup-keep': String(c.id) });
            radio.checked = String(c.id) === keep;
            radio.disabled = !!g.conflict;
            radio.addEventListener('change', () => { if (radio.checked) { keep = String(c.id); resetFoot(); } });
            const facts = [
                Tag(c.stage_label || c.status, { kind: tagKind(c.stage_color), dot: true }),
                c.patient_id != null ? Tag(c.patient_mrn ? trf('Карта {mrn}', { mrn: c.patient_mrn }) : 'Карта заведена', { kind: 'ok' }) : null,
                c.assigned_name ? Tag(trf('Ведёт {name}', { name: c.assigned_name }), { kind: 'teal' }) : null,
                c.lines ? Tag(trf('Услуг: {n}', { n: c.lines }), { kind: '' }) : null,
                c.tasks ? Tag(trf('Задач: {n}', { n: c.tasks }), { kind: '' }) : null,
            ].filter(Boolean);
            list.appendChild(h('label', {
                class: 'row', style: { gap: '10px', alignItems: 'flex-start', padding: '8px 10px', border: '1px solid var(--ink-200)', borderRadius: '10px', cursor: g.conflict ? 'default' : 'pointer' },
            },
                radio,
                h('div', { style: { flex: 1, minWidth: 0 } },
                    h('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap', alignItems: 'baseline' } },
                        h('span', { class: 'cell-strong' }, trf('№{id}', { id: c.id })),
                        h('span', { style: { overflowWrap: 'anywhere' } }, c.patient_name || c.full_name || tr('Без имени')),
                        h('span', { class: 'muted', style: { fontSize: '12.5px' } }, fmtDateTime(c.created_at))),
                    h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap', marginTop: '4px' } }, ...facts))));
        }
        box.appendChild(list);

        const foot = h('div', { class: 'row', style: { gap: '8px', marginTop: '10px', alignItems: 'center', flexWrap: 'wrap' } });
        box.appendChild(foot);

        function resetFoot() {
            clear(foot);
            if (g.conflict) {
                foot.appendChild(h('span', { class: 'muted', 'data-dup-conflict': '', style: { fontSize: '12.5px' } },
                    Icon('Warning', { size: 13 }), ' ',
                    'Карточки привязаны к разным пациентам — объединить их нельзя.'));
                return;
            }
            foot.appendChild(h('span', { class: 'grow' }));
            foot.appendChild(h('button', { class: 'btn btn-primary btn-sm', type: 'button', 'data-dup-merge': '', onclick: askSure },
                Icon('Layers', { size: 13 }), ' ', 'Объединить'));
        }

        // Вопрос — на месте кнопки: что уйдёт, куда, и что вернуть нельзя.
        function askSure() {
            clear(foot);
            const others = g.cards.filter((c) => String(c.id) !== keep).map((c) => c.id);
            foot.appendChild(h('span', { 'data-dup-confirm': '', style: { fontSize: '13.5px', flex: '1 1 260px' } },
                trf('Влить в №{id} остальные карточки ({n})? Услуги, задачи, заметки и метки перейдут в неё, остальные карточки будут удалены. Отменить это нельзя.',
                    { n: others.length, id: keep })));
            foot.appendChild(h('button', { class: 'btn btn-sm', type: 'button', onclick: resetFoot }, 'Отмена'));
            const go = h('button', { class: 'btn btn-primary btn-sm', type: 'button', 'data-dup-merge-yes': '' }, 'Да, объединить');
            go.addEventListener('click', async () => {
                go.disabled = true;
                const { error } = await supabase.rpc('crm_merge_leads', { keep_id: Number(keep), merge_ids: others });
                if (error) { toast(trf('Не удалось объединить: {msg}', { msg: error.message }), 'fail'); resetFoot(); return; }
                toast(trf('Карточки объединены в №{id}', { id: keep }), 'ok');
                box.remove();
                try { if (onMerged) await onMerged(); } catch (e) { /* доска перерисуется при следующем открытии */ }
                if (--left <= 0) await load();   // последняя группа слита — «дубликатов нет»
            });
            foot.appendChild(go);
        }

        resetFoot();
        return box;
    }

    load();
    return overlay;
}
