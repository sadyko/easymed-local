// CLINIC_API_FIX_V1 — одно правило «реквизиты клиники поверх оформления» для
// печати в браузере и PDF в Telegram. Здесь — само правило; что оба пути
// идут через него, держит server/services/telegram/render-branding.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    LEGACY_DEFAULTS, LEGACY_TAGLINE, clearLegacyDocSettings, overlayCompanyBranding, resolveDocSettings,
} from './company-branding.js';

const LOGO_OLD = 'data:image/png;base64,T0xE';
const LOGO_NEW = 'data:image/png;base64,TkVX';
const LOGO_DESIGNER = 'data:image/png;base64,REVT';

const CLINIC = {
    id: 1, name: 'Новая', address: 'Новый адрес', phone: '+998 71 111 11 11', email: 'new@clinic.uz',
    license_number: 'NEW-2', accent_color: '#2255aa', logo_url: LOGO_NEW,
};
// Копия, сохранённая «Документами», когда клиника называлась «Старая».
const COPY = () => ({
    clinicName: 'Старая', address: 'Старый адрес', phone: '+998 71 000 00 00', email: 'old@clinic.uz',
    license: 'OLD-1', accent: '#111111', logoUrl: LOGO_OLD, useCompanyIdentity: true,
    fontPair: 'serif', density: 'airy', footerNote: 'Подвал дизайнера', variant: { lab: 'compact' },
});

test('реквизиты и логотип клиники перекрывают сохранённую копию, оформление остаётся дизайнера', () => {
    const s = overlayCompanyBranding(COPY(), CLINIC);
    assert.equal(s.clinicName, 'Новая');
    assert.equal(s.address, 'Новый адрес');
    assert.equal(s.phone, '+998 71 111 11 11');
    assert.equal(s.email, 'new@clinic.uz');
    assert.equal(s.license, 'NEW-2');
    assert.equal(s.accent, '#2255aa');
    assert.equal(s.logoUrl, LOGO_NEW, 'остался логотип из старой копии');
    assert.equal(s.fontPair, 'serif');
    assert.equal(s.density, 'airy');
    assert.equal(s.footerNote, 'Подвал дизайнера');
    assert.deepEqual(s.variant, { lab: 'compact' });
});

test('name_ru главнее name; сайт, ИНН и юр. название — в свои поля', () => {
    const s = overlayCompanyBranding({}, { name: 'Clinic', name_ru: 'Клиника', website: 'shifo.uz', tax_id: '301', legal_name: 'ООО «Шифо»' });
    assert.equal(s.clinicName, 'Клиника');
    assert.equal(s.web, 'shifo.uz');
    assert.equal(s.taxId, '301');
    assert.equal(s.legalName, 'ООО «Шифо»');
});

test('пустые поля клиники копию не стирают; логотипа у клиники нет — logoUrl снимается, свой логотип дизайнера остаётся', () => {
    const s = overlayCompanyBranding({ ...COPY(), logoDataUrl: LOGO_DESIGNER },
        { id: 1, name: 'Новая', address: null, phone: '', email: null, license_number: null, accent_color: null, logo_url: null });
    assert.equal(s.address, 'Старый адрес');
    assert.equal(s.phone, '+998 71 000 00 00');
    assert.equal(s.accent, '#111111');
    assert.equal(s.logoUrl, null, 'копия логотипа «Компании» напечаталась бы вместо логотипа дизайнера');
    assert.equal(s.logoDataUrl, LOGO_DESIGNER);
});

test('у клиники логотип есть — логотип дизайнера не затирается (вернётся, если логотип клиники убрать)', () => {
    const s = overlayCompanyBranding({ ...COPY(), logoDataUrl: LOGO_DESIGNER }, CLINIC);
    assert.equal(s.logoUrl, LOGO_NEW);
    assert.equal(s.logoDataUrl, LOGO_DESIGNER);
});

test('ручной режим «Документов»: реквизиты дизайнера главнее, логотип клиники снят', () => {
    const s = overlayCompanyBranding({ ...COPY(), useCompanyIdentity: false, logoDataUrl: LOGO_DESIGNER }, CLINIC);
    assert.equal(s.clinicName, 'Старая');
    assert.equal(s.address, 'Старый адрес');
    assert.equal(s.accent, '#111111');
    assert.equal(s.logoUrl, null);
    assert.equal(s.logoDataUrl, LOGO_DESIGNER);
});

test('клиника не определилась — копия как есть', () => {
    const s = overlayCompanyBranding(COPY(), null);
    assert.equal(s.clinicName, 'Старая');
    assert.equal(s.logoUrl, LOGO_OLD);
});

test('старые заготовки поставщика и подзаголовок вычищаются только при точном совпадении; en → ru; variant — объект', () => {
    const s = clearLegacyDocSettings({ ...LEGACY_DEFAULTS, tagline: LEGACY_TAGLINE, language: 'en', variant: null });
    for (const k of Object.keys(LEGACY_DEFAULTS)) assert.equal(s[k], '', k);
    assert.equal(s.tagline, '');
    assert.equal(s.language, 'ru');
    assert.deepEqual(s.variant, {});

    const own = clearLegacyDocSettings({ phone: '+998 71 200 12 01', footerNote: 'Спасибо!', tagline: 'Забота', language: 'uz', variant: { lab: 'compact' } });
    assert.equal(own.phone, '+998 71 200 12 01');
    assert.equal(own.footerNote, 'Спасибо!');
    assert.equal(own.tagline, 'Забота');
    assert.equal(own.language, 'uz');
    assert.deepEqual(own.variant, { lab: 'compact' });
});

test('resolveDocSettings: сначала чистка, потом клиника — телефон поставщика не печатается, если у клиники телефона нет', () => {
    const s = resolveDocSettings({ ...COPY(), phone: LEGACY_DEFAULTS.phone, address: LEGACY_DEFAULTS.address },
        { id: 1, name: 'Новая', address: 'Новый адрес', phone: null });
    assert.equal(s.phone, '', 'на бланке остался телефон поставщика');
    assert.equal(s.address, 'Новый адрес');
    assert.equal(s.clinicName, 'Новая');
});
