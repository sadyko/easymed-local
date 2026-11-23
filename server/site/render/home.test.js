import test from 'node:test';
import assert from 'node:assert/strict';
import { startSite } from '../app.test.js';
import { seedSite } from '../../test-helpers/site-seed.js';
import { invalidateContentCache } from '../content.js';

// HERO_ELEGANT_V1 — герой главной собирается из settings.hero по частям.
// Тот же приём, что и в settings-wiring.test.js: читаем настройки, дописываем
// свою ветку в JS и сохраняем объект ЦЕЛИКОМ — ровно так это делает вьюха
// админки (см. website-admin-flow.test.js).
function setHero(db, patch) {
  const row = db.prepare('SELECT settings FROM website_settings WHERE id=1').get();
  const settings = JSON.parse(row?.settings || '{}');
  settings.hero = { ...(settings.hero || {}), ...patch };
  db.prepare('UPDATE website_settings SET settings = ? WHERE id=1').run(JSON.stringify(settings));
  invalidateContentCache();
}

// Кнопка «Все услуги» есть и в секции услуг — считать кнопки по всей странице
// нельзя. Вырезаем ровно секцию героя и проверяем уже внутри неё.
function heroHtml(html) {
  const start = html.indexOf('<section class="hero home-hero">');
  assert.ok(start >= 0, 'секция героя есть на странице');
  return html.slice(start, html.indexOf('</section>', start));
}

async function homeHtml(base, lang = 'ru') {
  const res = await fetch(`${base}/${lang}/`);
  assert.equal(res.status, 200);
  return res.text();
}

test('главная: секции из настроек и только опубликованный контент', async () => {
  const { server, base, db } = await startSite(seedSite);
  invalidateContentCache();
  try {
    const res = await fetch(base + '/ru/');
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Здоровье/, 'hero из настроек');
    assert.match(html, /Алиев Шерзод/, 'опубликованный врач на главной');
    assert.match(html, /ЭКГ/, 'featured-услуга на главной');
    assert.match(html, /Отличная клиника/, 'отзыв');
    assert.match(html, /Как записаться\?/, 'FAQ');
    assert.ok(!html.includes('Скрытый Врач'), 'неопубликованный врач невидим');
    assert.ok(!html.includes('Секретная услуга'), 'неопубликованная услуга невидима');
  } finally { server.close(); }
});

test('главная на пустой БД рендерится без ошибок (мягкий «скоро»)', async () => {
  const { server, base } = await startSite();
  invalidateContentCache();
  try {
    const res = await fetch(base + '/uz/');
    assert.equal(res.status, 200);
  } finally { server.close(); }
});

// ---------------------------------------------------------------------------
// HERO_ELEGANT_V1 — новые части героя. Общее правило для всех: часть есть на
// странице ТОЛЬКО когда администратор её заполнил, и герой обязан оставаться
// целым в любой комбинации незаполненного.
// ---------------------------------------------------------------------------

test('герой: минимальные настройки — заголовок, абзац и ОДНА кнопка, без кикера/цены/фото', async () => {
  const { server, base } = await startSite(seedSite);
  invalidateContentCache();
  try {
    const hero = heroHtml(await homeHtml(base));
    assert.match(hero, /<h1>Здоровье<\/h1>/, 'заголовок на месте');
    assert.ok(!hero.includes('hero__kicker'), 'кикер не задан — элемента нет вовсе');
    assert.ok(!hero.includes('hero__price'), 'цена не задана — строки цены нет вовсе');
    assert.ok(!hero.includes('hero__cta3'), 'третья кнопка не задана — её нет');
    assert.ok(!hero.includes('hero__collage'), 'фото не загружены — коллажа нет');
    assert.match(hero, /hero__inner--solo/, 'без фото вторая колонка не резервируется');
    assert.equal((hero.match(/<a class="btn /g) || []).length, 1,
      'осталась только основная кнопка записи');
    assert.equal((hero.match(/<img /g) || []).length, 0, 'картинок в герое нет');
  } finally { server.close(); }
});

test('герой: кикер — per-lang строка, рендерится заполненным и исчезает пустым', async () => {
  const { server, base, db } = await startSite(seedSite);
  invalidateContentCache();
  try {
    setHero(db, { kicker: { ru: 'Клиника полного цикла', uz: "To'liq tsikl klinikasi", en: 'Full-cycle clinic' } });
    const ru = heroHtml(await homeHtml(base, 'ru'));
    assert.match(ru, /<p class="hero__kicker">Клиника полного цикла<\/p>/);
    const uz = heroHtml(await homeHtml(base, 'uz'));
    assert.match(uz, /hero__kicker">To&#39;liq tsikl klinikasi</, 'кикер на своём языке и экранирован');

    setHero(db, { kicker: { ru: '', uz: '', en: '' } });
    assert.ok(!heroHtml(await homeHtml(base)).includes('hero__kicker'), 'пустой кикер — элемента нет');
  } finally { server.close(); }
});

test('герой: цена — крупное число отдельно от «от» и валюты, разряды неразрывным пробелом', async () => {
  const { server, base, db } = await startSite(seedSite);
  invalidateContentCache();
  try {
    setHero(db, { price: { from: true, amount: 19999000 } });

    const ru = heroHtml(await homeHtml(base, 'ru'));
    assert.match(ru, /<p class="hero__price">/, 'цена — абзац, а не заголовок');
    assert.ok(!/<h[1-6][^>]*class="hero__price"/.test(ru), 'цена не заголовок ни в каком виде');
    assert.match(ru, /<span class="hero__price-from">от<\/span>/, '«от» из словаря сайта, мелкой строкой');
    assert.match(ru, /<span class="hero__price-amount">19\u00A0999\u00A0000<\/span>/,
      'число отдельным элементом, разряды НЕразрывным пробелом');
    assert.match(ru, /<span class="hero__price-currency">сум<\/span>/, 'валюта отдельным элементом');

    // uz — то же число, своё слово «от» и своя валюта (price.from/price.currency).
    const uz = heroHtml(await homeHtml(base, 'uz'));
    assert.match(uz, /hero__price-amount">19\u00A0999\u00A0000</);
    assert.match(uz, /hero__price-currency">so&#39;m</);

    // Галочка «от» снята — остаётся число с валютой.
    setHero(db, { price: { from: false, amount: 19999000 } });
    const noFrom = heroHtml(await homeHtml(base));
    assert.match(noFrom, /hero__price-amount">19\u00A0999\u00A0000</);
    assert.ok(!noFrom.includes('hero__price-from'), 'без галочки слова «от» нет');
  } finally { server.close(); }
});

test('герой: цена исчезает на пустой/нулевой/мусорной сумме', async () => {
  const { server, base, db } = await startSite(seedSite);
  invalidateContentCache();
  try {
    for (const price of [{ from: true }, { from: true, amount: 0 }, { from: true, amount: 'дорого' },
      { from: true, amount: -5 }, 'не объект', null]) {
      setHero(db, { price });
      assert.ok(!heroHtml(await homeHtml(base)).includes('hero__price'),
        `цена не рендерится при price=${JSON.stringify(price)}`);
    }
  } finally { server.close(); }
});

test('герой: три кнопки разного веса, когда заданы обе дополнительные', async () => {
  const { server, base, db } = await startSite(seedSite);
  invalidateContentCache();
  try {
    setHero(db, {
      cta2: { label: { ru: 'Все услуги', uz: 'Barcha xizmatlar', en: 'All services' }, href: '/ru/services' },
      cta3: { label: { ru: 'Программы здоровья', uz: 'Salomatlik dasturlari', en: 'Health programs' }, href: '/ru/departments' },
    });
    const hero = heroHtml(await homeHtml(base));
    assert.equal((hero.match(/<a class="btn /g) || []).length, 2, 'залитая + обводка');
    assert.match(hero, /<a class="btn btn-ghost btn-lg" href="\/ru\/services">Все услуги<\/a>/);
    assert.match(hero, /<a class="hero__cta3" href="\/ru\/departments">/, 'третья кнопка — мягкая, не .btn');
    assert.match(hero, /<svg class="hero__cta3-ico"[^>]*aria-hidden="true"/, 'иконка спрятана от читалки');
    assert.match(hero, /<span>Программы здоровья<\/span>/, 'текст ссылки — сама подпись');

    // Подпись без адреса (и наоборот) — кнопки нет: ссылка в никуда хуже, чем
    // её отсутствие. Чужая схема вроде javascript: тоже не проходит.
    setHero(db, {
      cta2: { label: { ru: 'Без адреса' }, href: '' },
      cta3: { label: { ru: 'Опасная' }, href: 'javascript:alert(1)' },
    });
    const one = heroHtml(await homeHtml(base));
    assert.equal((one.match(/<a class="btn /g) || []).length, 1, 'осталась одна основная кнопка');
    assert.ok(!one.includes('Без адреса'), 'кнопка без href не рендерится');
    assert.ok(!one.includes('hero__cta3'), 'кнопка с чужой схемой не рендерится');
    assert.ok(!one.includes('javascript:'), 'javascript: не попадает в разметку');
  } finally { server.close(); }
});

test('герой: коллаж из двух фото — width/height у обоих, lazy только у второго', async () => {
  const { server, base, db } = await startSite(seedSite);
  invalidateContentCache();
  try {
    setHero(db, { img1: 'hero/front.jpg', img2: 'hero/back.jpg' });
    const hero = heroHtml(await homeHtml(base));
    // HERO_SLIDESHOW_V1 — коллаж остался, но его содержимое меняется, поэтому
    // разметка изменилась НАМЕРЕННО: у обёртки появился признак для скрипта, а
    // в каждой позиции лежат ВСЕ кадры сразу (лишние скрыты hidden). Все кадры
    // в документе нужны для смены через opacity: подмена src давала бы белую
    // вспышку во весь заголовок, пока грузится следующий файл.
    assert.match(hero, /<div class="hero__collage" data-hero-slideshow>/);
    const imgs = hero.match(/<img [^>]*>/g) || [];
    assert.equal(imgs.length, 4, 'два кадра в каждой из двух позиций');
    assert.equal((hero.match(/hidden>/g) || []).length, 2, 'в каждой позиции виден ровно один кадр');
    for (const img of imgs) {
      assert.match(img, /\bwidth="\d+"/, `<img> без width — ${img}`);
      assert.match(img, /\bheight="\d+"/, `<img> без height — ${img}`);
    }
    const front = imgs.find((i) => i.includes('front.jpg') && !i.includes('hidden'));
    const back = imgs.find((i) => i.includes('back.jpg') && !i.includes('hidden'));
    assert.match(front, /src="\/media\/hero\/front\.jpg"/, 'путь отдаётся через /media/');
    assert.match(front, /alt="Здоровье"/, 'alt переднего фото — заголовок героя');
    assert.ok(!front.includes('loading='), 'переднее фото — LCP, грузится сразу');
    assert.match(back, /loading="lazy"/, 'второе фото откладывается');
    assert.match(back, /alt=""/, 'второе фото декоративное — заголовок не дублируется');
    assert.ok(!hero.includes('hero__inner--solo'), 'с фото вторая колонка нужна');

    // Одно фото — одиночная арка без смещённого партнёра.
    setHero(db, { img1: 'hero/front.jpg', img2: '' });
    const single = heroHtml(await homeHtml(base));
    assert.match(single, /hero__collage hero__collage--single/);
    assert.equal((single.match(/<img /g) || []).length, 1);

    // Путь-обход (mediaUrl его выбрасывает) — коллажа нет вовсе.
    setHero(db, { img1: '../../etc/passwd', img2: '' });
    assert.ok(!heroHtml(await homeHtml(base)).includes('hero__collage'),
      'путь с «..» не превращается в картинку');
  } finally { server.close(); }
});
