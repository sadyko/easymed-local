// ROLES_SAVE_TRUTH_V1 (2026-09-29) — «ПРОВЕРЬТЕ ПРАВА ЭТОЙ РОЛИ»: ПРАВА ВЫШЕ ОБЫЧНЫХ ДЛЯ ОСНОВЫ.
//
// До этого выпуска экран «Роли» писал в роль СВОЮ ДОГАДКУ о ключах, которые
// роль не настраивала, и первое же «Сохранить роль» давало права выше тех, что
// дают ворота основы: оператору колл-центра — чужие заявки, регистратуре —
// измерения стационара. Миграция 230 нашла такие ключи (role_grant_reviews) и
// прав не меняла: отличить догадку экрана от права, выданного нарочно, нельзя.
// Решает администратор (ревью M3: «Роли: Изменение» ключ выше собственных прав
// не снимет — откажет защита ролей; строки проверки читает только он, реестр):
//   «Убрать эти права» — названные ключи снимаются из grants, решает основа;
//   «Оставить как есть» — права не трогаются, вопрос больше не задаётся.
// Ключ, который с тех пор поменяли руками, не показывается и не снимается:
// решение уже принято на самом экране (тот же приём, что у roles-review.js).
import { supabase } from '../../supabase.js';
import { h, Icon, toast } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { CATALOG } from '../../shared/permission-catalog.js';

function parse(p) {
    if (typeof p === 'string') { try { return JSON.parse(p); } catch { return null; } }
    return p && typeof p === 'object' ? p : null;
}
const grantsOf = (perms) => { const p = parse(perms) || {}; return (p.grants && typeof p.grants === 'object') ? p.grants : {}; };

/** Строка справочника словами экрана: «Стационар → Измерения»; раздел — «Закупки». */
export function grantKeyLabel(key) {
    for (const s of CATALOG) {
        // Ревью M4 — на проверке бывает и раздел: «Закупки» (ворота-функция).
        if (s.key === key) return tr(s.label);
        for (const r of [...(s.windows || []), ...(s.actions || [])]) {
            if (r.key === key) return tr(s.label) + ' → ' + tr(r.label);
        }
    }
    return key;
}

/** Нерешённые строки проверки по роли — только те, чей ключ стоит, как его нашла миграция. */
export async function openGrantReviews(role, perms) {
    try {
        const { data, error } = await supabase.from('role_grant_reviews')
            .select('id, role, key, level, standard, resolution').eq('role', role).is('resolution', null);
        if (error || !Array.isArray(data)) return [];
        const g = grantsOf(perms);
        return data.filter((r) => g[r.key] === r.level);
    } catch (e) { return []; }
}

async function resolve(items, resolution) {
    const { error } = await supabase.from('role_grant_reviews')
        .update({ resolution, resolved_at: new Date().toISOString() })
        .in('id', items.map((i) => i.id)).select();
    if (error) throw new Error(error.message || String(error));
}

/** «Убрать эти права»: строка роли перечитывается, снимаются только ключи, стоящие как найдено. */
export async function removeReviewedGrants(role, items) {
    const { data, error } = await supabase.from('role_permissions').select('permissions').eq('role', role).maybeSingle();
    if (error) throw new Error(error.message || String(error));
    const p = parse(data && data.permissions) || {};
    const grants = { ...grantsOf(p) };
    let changed = false;
    for (const it of items) {
        if (grants[it.key] === it.level) { delete grants[it.key]; changed = true; }
    }
    if (changed) {
        const up = await supabase.from('role_permissions').update({ permissions: JSON.stringify({ ...p, grants }) }).eq('role', role).select().single();
        if (up.error) throw new Error(up.error.message || String(up.error));
    }
    await resolve(items, 'restored');
}

/**
 * Врезка в карточку роли. `onDone` зовётся после решения (экран перечитывает роль).
 * Возвращает узел сразу; строки подгружаются следом — нет строк, нет и врезки.
 */
export function roleGrantReviewNotice(role, perms, { onDone } = {}) {
    const box = h('div', { class: 'roles-review' });
    openGrantReviews(role, perms).then((items) => {
        if (!items.length) return;
        const removeBtn = h('button', { class: 'btn btn-primary btn-sm', type: 'button' }, 'Убрать эти права');
        const keepBtn = h('button', { class: 'btn btn-outline btn-sm', type: 'button' }, 'Оставить как есть');
        const act = async (fn, okText) => {
            removeBtn.disabled = true; keepBtn.disabled = true;
            try { await fn(); toast(tr(okText), 'ok'); if (onDone) onDone(); }
            catch (e) { toast(tr('Не удалось сохранить решение.') + ' ' + ((e && e.message) || ''), 'fail'); removeBtn.disabled = false; keepBtn.disabled = false; }
        };
        removeBtn.addEventListener('click', () => act(() => removeReviewedGrants(role, items), 'Права убраны — решает основа роли.'));
        keepBtn.addEventListener('click', () => act(() => resolve(items, 'kept'), 'Права оставлены как есть.'));
        const list = items.map((i) => '«' + grantKeyLabel(i.key) + '»').join(', ');
        box.appendChild(h('div', { class: 'card roles-note', role: 'status', dataset: { grantReview: role } },
            h('span', { class: 'roles-note-ico' }, Icon('Warning', { size: 15 })),
            h('div', { class: 'roles-note-txt' },
                h('strong', null, 'Проверьте права этой роли'),
                h('div', { class: 'muted' }, trf('У роли есть права выше обычных для её основы: {list}. До этого обновления экран «Роли» мог выдать их сам — при любом сохранении роли. Если вы выдали их нарочно, оставьте как есть.', { list })),
                h('div', { class: 'roles-review-acts' }, removeBtn, ' ', keepBtn)),
        ));
    });
    return box;
}
