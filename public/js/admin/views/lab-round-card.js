// LAB_ROUND_V1 (решение владельца 2026-11-07, п. 6) — карточка «Результаты
// анализаторов» на экране Лаборатория → «Анализаторы»: одна настройка клиники
// «Округлять результаты анализаторов до 2 знаков» (doc_settings.lab_round_analyzer,
// мигр. 279), по умолчанию включена. Включена — значения приборов в бланке и на
// печати до 2 знаков, половиной вверх (4.152122 → 4.15, 4.155 → 4.16); выключена —
// полные значения. Ручной ввод не меняется. Пишет её администратор (сервер требует
// того же: doc_settings — запись «Компания»); остальные видят, как настроено.
import { h, toast, clear } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { supabase } from '../../supabase.js';
import { isAdminActor } from '../admin-actor.js';
import { labRoundOn } from '../../shared/lab-round.js';

// Ключи словаря, а не собранные строки: tr() ищет строку целиком.
const TITLE = 'Результаты анализаторов';
const LABEL = 'Округлять результаты анализаторов до 2 знаков';
const NOTE = 'Например, 4.152122 → 4.15; половина — вверх: 4.155 → 4.16. Снимите галочку, чтобы видеть полные значения прибора. Значения, набранные руками, не меняются.';
const ADMIN_NOTE = 'Изменить может администратор.';

/** Читает настройку клиники; не прочиталась — включено (как по умолчанию). */
export async function loadRoundSetting() {
    try {
        const { data, error } = await supabase.from('doc_settings').select('lab_round_analyzer').eq('id', 1).single();
        return error ? true : labRoundOn(data && data.lab_round_analyzer);
    } catch (e) {
        return true;
    }
}

export async function mountRoundCard(card) {
    const on = await loadRoundSetting();
    clear(card);
    const admin = isAdminActor();
    const box = h('input', { type: 'checkbox', 'data-lab-round': '' });
    box.checked = on;
    if (on) box.setAttribute('checked', '');
    if (!admin) { box.disabled = true; box.setAttribute('disabled', ''); }
    box.addEventListener('change', async () => {
        const want = !!box.checked;
        const { error } = await supabase.from('doc_settings').update({ lab_round_analyzer: want ? 1 : 0 }).eq('id', 1);
        if (error) {
            box.checked = !want;
            toast(trf('Не удалось сохранить настройку: {msg}', { msg: (error && error.message) || error }), 'fail');
            return;
        }
        toast(want ? tr('Результаты анализаторов — до 2 знаков') : tr('Результаты анализаторов — полностью'), 'ok');
    });
    card.appendChild(h('div', { class: 'ld-subhead' }, tr(TITLE)));
    card.appendChild(h('label', { class: 'ld-round', style: { display: 'flex', gap: '8px', alignItems: 'center', cursor: admin ? 'pointer' : 'default' } },
        box, h('span', null, tr(LABEL))));
    card.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '4px' } }, tr(NOTE)));
    if (!admin) card.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px' } }, tr(ADMIN_NOTE)));
    return on;
}
