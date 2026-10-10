// CLINIC_PROFILE_V1 — «Компания»: «Как это увидят пациенты».
//
// Те же данные, что получат сайт клиники, Symptex и партнёры (API, шаги 7–8):
// название и описание на выбранном языке (нет перевода — русское), полный
// адрес из справочника на этом языке, квадратный логотип и кнопки-ссылки.
// Каждый партнёр рисует это в своём стиле — здесь проверяют сами данные.
//
// Подписи кнопок — на языке ПРЕДПРОСМОТРА (так их увидит пациент), а не
// интерфейса: текстовые узлы без tr(), иначе h() перевёл бы их на язык
// программы. Данные клиники — тоже текстовыми узлами: название клиники не
// должно случайно совпасть с ключом словаря и «перевестись».
import { h, Icon } from '../ui.js';
import {
    composeAddress, normalizeProfile, websiteProblem, handleProblem, mapsProblem, routeUrl, telHref,
} from '../../shared/clinic-profile.js';
import { logoSrc } from './company-logos.js';

// Подписи — на языке ПРЕДПРОСМОТРА. Русские литералы — и статьи словаря:
// i18n-coverage требует статью для каждого кириллического литерала.
// channel — «канал @имя» в нижней строке (полировка по макету).
const WORDS = {
    ru: { call: 'Позвонить', route: 'Маршрут', site: 'Сайт', channel: 'канал' },
    uz: { call: 'Qo‘ng‘iroq qilish', route: 'Yo‘nalish', site: 'Sayt', channel: 'kanal' },
    en: { call: 'Call', route: 'Route', site: 'Website', channel: 'channel' },
};
const text = (s) => document.createTextNode(String(s == null ? '' : s));

function linkBtn(href, icon, label, { main = false, external = true } = {}) {
    return h('a', {
        class: 'btn btn-sm ' + (main ? 'btn-primary' : 'btn-outline'),
        href,
        target: external ? '_blank' : null,
        rel: external ? 'noopener noreferrer' : null,
    }, Icon(icon, { size: 14 }), text(' '), text(label));
}

/**
 * Карточка-образец для языка lang. state — объект экрана; parts — выбранные
 * строки справочника { country, region, district } (адрес); logo — src
 * квадратного логотипа (файл, иначе печатная копия) или ''.
 */
export function patientPreview(state, { lang = 'ru', parts = {}, logo = '' } = {}) {
    const v = normalizeProfile(state);
    const w = WORDS[lang] || WORDS.ru;
    const name = (lang === 'ru' ? v.clinic_name : v['name_' + lang]) || v.clinic_name || '';
    const about = v['about_' + lang] || '';
    const address = composeAddress({ ...parts, street: { ru: v.street_ru, uz: v.street_uz, en: v.street_en } }, lang);

    const mark = logo
        ? h('img', { class: 'cpf-pmark', src: logo, alt: '' })
        : h('span', { class: 'cpf-pmark is-empty', 'aria-hidden': 'true' }, Icon('Building', { size: 22 }));

    let aboutNode;
    if (about) aboutNode = h('p', { class: 'cpf-pabout' }, text(about));
    else if (lang !== 'ru' && v.about_ru) aboutNode = h('p', { class: 'cpf-pmiss' }, 'Нет описания на этом языке — партнёры покажут русское.');
    else aboutNode = h('p', { class: 'cpf-pmiss' }, 'Описания пока нет — добавьте его в «Реквизитах».');

    const btns = [];
    const tel = telHref(v.phone);
    if (tel) btns.push(linkBtn(tel, 'Phone', w.call, { main: true, external: false }));
    if (v.maps_url && !mapsProblem(v.maps_url)) btns.push(linkBtn(routeUrl(v.maps_url), 'MapPin', w.route));
    if (v.telegram_bot && !handleProblem('telegram_bot', v.telegram_bot)) btns.push(linkBtn('https://t.me/' + v.telegram_bot.slice(1), 'Bot', v.telegram_bot));
    if (v.telegram_channel && !handleProblem('telegram_channel', v.telegram_channel)) btns.push(linkBtn('https://t.me/' + v.telegram_channel.slice(1), 'Send', v.telegram_channel));
    if (v.instagram && !handleProblem('instagram', v.instagram)) btns.push(linkBtn('https://instagram.com/' + v.instagram.slice(1), 'Camera', v.instagram));
    if (v.website && !websiteProblem(v.website)) btns.push(linkBtn(v.website, 'Globe', w.site));

    // CLINIC_PROFILE_V1 (полировка по макету) — нижняя строка «телефон · канал
    // @имя», как в макете; телефон переехал сюда из-под названия (там — адрес).
    // Канал — только годное имя, как и его кнопка.
    const channel = v.telegram_channel && !handleProblem('telegram_channel', v.telegram_channel) ? v.telegram_channel : '';
    const bottom = [v.phone ? String(v.phone).trim() : '', channel ? w.channel + ' ' + channel : ''].filter(Boolean).join(' · ');

    return h('div', { class: 'cpf-preview', lang },
        h('div', { class: 'cpf-preview-head' }, mark,
            h('div', { class: 'cpf-pname-box' },
                h('b', { class: 'cpf-pname' }, text(name || '—')),
                address ? h('span', { class: 'cpf-psub' }, text(address)) : null)),
        aboutNode,
        btns.length ? h('div', { class: 'cpf-pbtns' }, ...btns) : null,
        bottom ? h('span', { class: 'cpf-psub cpf-pline' }, text(bottom)) : null);
}
