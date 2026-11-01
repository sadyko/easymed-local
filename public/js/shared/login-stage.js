// LOGIN_STAGE_V1 (2026-10-31) — витрина входа: ОДНА на все окна до входа.
//
// Владелец: «make login place super attractive and backside should have the
// same design like heart beating», и следом: «there might be several links to
// login place, so all of them should have the same design».
//
// Входов в продукте два, и раньше они выглядели по-разному:
//   • страница «/» (index.html + js/login.js) — сюда ведёт выход и каждый 401
//     (api.js: location.href = '/');
//   • окна внутри admin.html (admin.js) — вход при открытии без сессии, заявка
//     на доступ, своя клиника, клиника на проверке.
// Оба теперь строят левую половину ЭТИМ модулем, а стили берут из одного
// css/login-stage.css. Разойтись они могут, только если кто-то перестанет его
// звать, — поэтому разметка витрины живёт здесь, а не в каждом файле копией.
//
// Модуль без зависимостей от оболочки (ни h(), ни i18n): index.html не грузит
// admin.js. Перевод передаётся снаружи (admin.js — tr, страница «/» — по-русски).

import { iconHtml } from '../admin/icons.js';

// Знак Easy-Med — тот же пульс, что в favicon.svg и в шапке меню.
export const PULSE_SVG = '<svg viewBox="2 2 28 28" fill="none" stroke="currentColor" stroke-width="2.6"'
    + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'
    + '<path d="M5 17 L10 17 L12 10 L14.5 24 L17 13 L19 17 L27 17"/></svg>';

const FEATURES = [
    ['Patients', 'Электронная карта пациента'],
    ['Flask', 'Лаборатория и готовые результаты'],
    ['Chart', 'Касса и отчёты в реальном времени'],
];

// Кардиограмма на 1200×220: четыре удара по 300 по базовой линии 110 —
// зубец P, комплекс QRS (провал, пик, глубокий провал), зубец T. Растягивается
// на любую ширину (preserveAspectRatio="none"), толщину держит
// vector-effect: non-scaling-stroke в css.
export function ecgPath() {
    let d = 'M0 110';
    for (let i = 0; i < 4; i++) {
        const x = 60 + i * 300;
        d += ` L${x + 30} 110 Q${x + 42} 94 ${x + 54} 110 L${x + 70} 110`
           + ` L${x + 76} 122 L${x + 86} 18 L${x + 96} 172 L${x + 104} 110`
           + ` L${x + 130} 110 Q${x + 150} 80 ${x + 170} 110`;
    }
    return d + ' L1200 110';
}

function el(tag, cls, html) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
}

/** Левая половина: бренд, кардиограмма, обещание и три пункта. */
export function buildLoginHero(t = (s) => s) {
    const hero = el('section', 'lg-hero');
    const d = ecgPath();
    // Линия — украшение: читалке экрана она не нужна.
    hero.appendChild(el('div', null,
        `<svg class="lg-ecg" viewBox="0 0 1200 220" preserveAspectRatio="none" aria-hidden="true" focusable="false">`
        + `<path class="lg-ecg-base" d="${d}"/>`
        + `<path class="lg-ecg-glow" pathLength="100" d="${d}"/>`
        + `<path class="lg-ecg-pulse" pathLength="100" d="${d}"/></svg>`));

    const brand = el('div', 'lg-brand');
    brand.appendChild(el('span', 'lg-brand-tile', PULSE_SVG));
    brand.appendChild(el('span', null, 'Easy<span class="dot">·</span>Med'));
    hero.appendChild(brand);

    const copy = el('div', 'lg-copy');
    const title = el('h1', 'lg-title'); title.textContent = t('Вся клиника в одном окне');
    const lead = el('p', 'lg-lead');
    lead.textContent = t('Пациенты, запись, касса, лаборатория и стационар. Данные остаются в клинике и работают даже без интернета.');
    const list = el('ul', 'lg-feats');
    for (const [ic, text] of FEATURES) {
        const li = el('li', 'lg-feat');
        li.appendChild(el('span', 'lg-feat-ic', iconHtml(ic, { size: 16 })));
        li.appendChild(document.createTextNode(t(text)));
        list.appendChild(li);
    }
    copy.appendChild(title); copy.appendChild(lead); copy.appendChild(list);
    hero.appendChild(copy);

    const foot = el('div', 'lg-foot');
    foot.textContent = '© ' + new Date().getFullYear() + ' Easy-Med';
    hero.appendChild(foot);
    return hero;
}

/** Вся сцена вокруг готовой карточки — для окон admin.js. */
export function loginStage(card, { t, id = 'login-overlay' } = {}) {
    const stage = el('div', 'lg-stage');
    stage.setAttribute('id', id);   // не .id = — у фейкового DOM тестов (clinic-brand) это не атрибут
    stage.appendChild(buildLoginHero(t));
    const side = el('main', 'lg-side');
    side.appendChild(card);
    stage.appendChild(side);
    return stage;
}

/** Страница «/»: сцена уже в разметке, добавляем ей витрину первой. */
export function mountLoginHero(stage, t) {
    if (!stage || stage.querySelector('.lg-hero')) return;
    stage.insertBefore(buildLoginHero(t), stage.firstChild);
}
