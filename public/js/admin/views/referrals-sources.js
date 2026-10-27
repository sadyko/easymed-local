// REFERRALS_CRM_V1 (2026-10-26) — вкладки «Врачи-источники» и «Категории
// источников»: тот же справочник, что жил в «Настройки → Направления», только
// открытый здесь. Редактор — из settings-hub.js (renderLookupEditor: тот же
// LOOKUP_CONFIG, те же права settings.referral_sources / .money), поверх него
// кнопки «Шаблон / Импорт / Экспорт» общего импортёра (section-import-export.js,
// описание referral_sources в sections.js переписано под живые колонки).
//
// Владелец: «Referal external doctors are in setting now and it should be bring
// here without process change in registration and other places» — поэтому
// ни таблица, ни реестр, ни те, кто читает referral_sources, не менялись.
import { clear } from '../ui.js';
import { supabase } from '../../supabase.js';
import { renderLookupEditor, sectionLevel } from './settings-hub.js?v=fold1';   // тот же экземпляр модуля, что у оболочки (admin.js)
import { importExportButtons } from './section-import-export.js';

const SOURCE_COLUMNS = 'id, code, name, phone, workplace, district, specialty, category_id, payment_type, card_number, active, doctor_id';

async function fetchExternalSources() {
    const { data, error } = await supabase.from('referral_sources').select(SOURCE_COLUMNS).order('code');
    if (error) throw new Error(error.message || 'Не удалось загрузить источники.');
    // Внутренние врачи (doctor_id) в этот список не входят: у них своя вкладка.
    return (data || []).filter((r) => r.doctor_id == null);
}

export async function renderReferralsSources(host) {
    const lvl = sectionLevel('referral_sources');
    const canEdit = lvl === 'edit' || lvl === 'delete';
    const mount = async () => {
        clear(host);
        const actions = canEdit
            ? importExportButtons({ sectionKey: 'referral_sources', fetchRows: fetchExternalSources, filenameStem: 'referral_sources', onImported: mount })
            : null;
        await renderLookupEditor(host, 'referral_sources', { embedded: true, extraActions: actions });
    };
    await mount();
}

export async function renderReferralsCategories(host) {
    clear(host);
    await renderLookupEditor(host, 'referral_source_categories', { embedded: true });
}
