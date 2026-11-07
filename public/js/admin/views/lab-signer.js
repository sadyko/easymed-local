// PRINT_PERFORMER_V1 (решение владельца 2026-11-07, п. 9) — КТО ПОДПИСЫВАЕТ БЛАНК АНАЛИЗОВ.
//
// Бланк результатов печатался с подписью «Заведующий лабораторией» и именем:
// в лаборатории — только в момент «Проверить и выдать» (перепечатка — «—»), в
// разделе «Документы» — ЛЕЧАЩЕГО ВРАЧА визита («Лечащий врач»), то есть чужим
// именем под лабораторным бланком. Теперь везде — тот, кто ПОДТВЕРДИЛ анализы
// («Проверить и выдать» / «Подтвердить»: verified_by строки заказа или
// показателя), с ролью «Врач-лаборант». Несколько подтвердивших — через запятую.
// Не подтверждено — подписи нет («—»), чужого имени тоже нет.
import { supabase } from '../../supabase.js';

/* i18n-exempt-start: подпись печатного бланка — двуязычная (ru · uz), не текст экрана */
export const LAB_SIGNER_ROLE = 'Врач-лаборант';
export const LAB_SIGNER_ROLE_UZ = 'Laborant shifokor';
export const LAB_SIGNER_SPEC = 'Проверил и выдал';
/* i18n-exempt-end */

/** Номера подтвердивших — по порядку первого появления, без пустых и повторов. */
export function signerIds(list) {
    const out = [];
    for (const v of list || []) {
        if (v == null || v === '') continue;
        const k = String(v);
        if (!out.includes(k)) out.push(k);
    }
    return out;
}

/** Данные подписи бланка: имена подтвердивших; пусто — подписи нет. */
export function labSignerData(names) {
    const list = (names || []).map((n) => String(n || '').trim()).filter(Boolean);
    if (!list.length) return { labChief: '', labChiefSpec: '', labChiefRole: LAB_SIGNER_ROLE, labChiefRoleUz: LAB_SIGNER_ROLE_UZ };
    return { labChief: list.join(', '), labChiefSpec: LAB_SIGNER_SPEC, labChiefRole: LAB_SIGNER_ROLE, labChiefRoleUz: LAB_SIGNER_ROLE_UZ };
}

/** Имена подтвердивших по их номерам (users.full_name). Не прочиталось — без имён. */
export async function labSignerNames(ids) {
    const want = signerIds(ids);
    if (!want.length) return [];
    try {
        const { data, error } = await supabase.from('users').select('id, full_name').in('id', want);
        if (error) return [];
        const byId = new Map((data || []).map((u) => [String(u.id), u.full_name || '']));
        return want.map((id) => byId.get(id) || '').filter(Boolean);
    } catch (e) {
        return [];
    }
}
