import test from 'node:test';
import assert from 'node:assert/strict';
import { startSite } from '../app.test.js';
import { seedSite } from '../test-seed.js';
import { invalidateContentCache } from '../content.js';

test('контакты: телефон, форма обращения и мини-форма обратного звонка', async () => {
  const { server, base } = await startSite(seedSite);
  invalidateContentCache();
  try {
    const res = await fetch(base + '/ru/contact');
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /\+998 71 200 00 00/, 'телефон из settings.contact виден на странице');
    assert.match(html, /<form[^>]*>[\s\S]*name="website"/, 'форма содержит honeypot-поле website');
    assert.match(html, /name="type" value="contact"/, 'основная форма помечена type=contact');
    assert.match(html, /name="type" value="callback"/, 'форма обратного звонка помечена type=callback');
    // обе формы шлют JSON на /api/requests (задача 10 подключит обработку)
    assert.match(html, /action="\/api\/requests" method="post"/);
  } finally { server.close(); }
});

test('вопросы-ответы: опубликованный вопрос внутри <details>', async () => {
  const { server, base } = await startSite(seedSite);
  invalidateContentCache();
  try {
    const res = await fetch(base + '/ru/faq');
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /<details[^>]*class="faq-item"[^>]*>[\s\S]*Как записаться\?[\s\S]*<\/details>/);
  } finally { server.close(); }
});

test('privacy/terms: 200, текст-заглушка и noindex при пустых settings.legal', async () => {
  const { server, base } = await startSite(seedSite);
  invalidateContentCache();
  try {
    const privacy = await fetch(base + '/ru/privacy');
    assert.equal(privacy.status, 200);
    const privacyHtml = await privacy.text();
    assert.match(privacyHtml, /будет опубликован/);
    assert.match(privacyHtml, /<meta name="robots" content="noindex, follow">/);

    const terms = await fetch(base + '/ru/terms');
    assert.equal(terms.status, 200);
    const termsHtml = await terms.text();
    assert.match(termsHtml, /будет опубликован/);
    assert.match(termsHtml, /<meta name="robots" content="noindex, follow">/);
  } finally { server.close(); }
});

test('о клинике: 200', async () => {
  const { server, base } = await startSite(seedSite);
  invalidateContentCache();
  try {
    const res = await fetch(base + '/ru/about');
    assert.equal(res.status, 200);
  } finally { server.close(); }
});

test('часы работы: понедельник из branches.working_hours виден на странице контактов', async () => {
  const { server, base, db } = await startSite(seedSite);
  db.prepare(`UPDATE branches SET working_hours='{"mon":{"enabled":true,"from":"09:00","to":"18:00"}}' WHERE id=1`).run();
  invalidateContentCache();
  try {
    const res = await fetch(base + '/ru/contact');
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /09:00/);
    assert.match(html, /Понедельник/);
  } finally { server.close(); }
});

// CONTACT_CARD_V1 — карточка контактов строками с подписями.

test('карточка контактов: строки с подписями, пустые не рендерятся', async () => {
  const { server, base, db } = await startSite(seedSite);
  // Адрес берётся из doc_settings, если в настройках сайта его не задали —
  // боевая установка живёт именно на этом фолбэке.
  db.prepare("UPDATE doc_settings SET address='Ташкент, ул. Мирабад, 1' WHERE id=1").run();
  invalidateContentCache();
  try {
    const html = await (await fetch(base + '/ru/contact')).text();
    assert.match(html, /class="contact-card"/);
    assert.match(html, /contact-card__label">Телефон</);
    assert.match(html, /contact-card__label">Адрес</);
    assert.match(html, /Ташкент, ул\. Мирабад, 1/, 'адрес дотянулся из doc_settings');
    // Почта, telegram и режим работы в сидах не заданы — карточка обязана быть
    // карточкой из двух строк, а не четырьмя подписями над пустотой.
    assert.ok(!html.includes('contact-card__label">Электронная почта'), 'пустой почты нет');
    assert.ok(!html.includes('contact-card__label">Telegram'), 'пустого telegram нет');
    // Карты в сидах тоже нет — вторая колонка не должна занимать половину
    // ширины ради пустоты.
    assert.match(html, /contact-grid contact-grid--solo/);
    // QUICK_REQUEST_EVERYWHERE_V1 — кнопка открывает окно заявки, но остаётся
    // настоящей ссылкой: без JS должна открыться страница записи.
    assert.match(html, /contact-card__cta"[^>]*href="\/ru\/appointment"[^>]*data-qr-open/);
  } finally { server.close(); }
});

test('карточка контактов: telegram и почта появляются, когда заданы', async () => {
  const { server, base, db } = await startSite(seedSite);
  db.prepare(`UPDATE website_settings SET settings = json_set(settings,
     '$.social.telegram', 'https://t.me/clinic',
     '$.contact.email', 'info@clinic.uz',
     '$.contact.map_embed', '<iframe src="https://maps.example/x"></iframe>') WHERE id=1`).run();
  invalidateContentCache();
  try {
    const html = await (await fetch(base + '/ru/contact')).text();
    assert.match(html, /contact-card__label">Telegram</);
    assert.match(html, /href="https:\/\/t\.me\/clinic"[^>]*>Написать в Telegram</);
    assert.match(html, /href="mailto:info@clinic\.uz"/);
    // Карта задана — колонка появилась, значит режим «во всю ширину» снят.
    assert.match(html, /class="contact-side"/);
    assert.ok(!html.includes('contact-grid--solo'), 'при наличии карты колонки две');
  } finally { server.close(); }
});

test('режим работы: неделя сплошных выходных не показывается вовсе', async () => {
  const { server, base, db } = await startSite(seedSite);
  // Филиал завели, часы не заполнили — это «расписания нет», а не «закрыто
  // семь дней». Сказать пациенту второе хуже, чем не сказать ничего: это
  // выглядит достоверным фактом.
  db.prepare(`UPDATE branches SET is_24_7=0, working_hours='{}' WHERE id=1`).run();
  invalidateContentCache();
  try {
    const html = await (await fetch(base + '/ru/contact')).text();
    assert.ok(!html.includes('contact-hours__list'), 'таблицы часов нет');
    assert.ok(!html.includes('Выходной'), 'ни одного «Выходной» на странице');
    assert.ok(!html.includes('contact-card__label">Режим работы'), 'строки режима в карточке нет');
  } finally { server.close(); }
});

test('режим работы: круглосуточно и склейка одинаковых дней в диапазон', async () => {
  const { server, base, db } = await startSite(seedSite);
  db.prepare(`UPDATE branches SET is_24_7=1 WHERE id=1`).run();
  invalidateContentCache();
  try {
    const html = await (await fetch(base + '/ru/contact')).text();
    assert.match(html, /contact-card__label">Режим работы[\s\S]{0,120}Круглосуточно/);
  } finally { server.close(); }
});

test('режим работы: Пн–Пт одним диапазоном, суббота отдельно', async () => {
  const { server, base, db } = await startSite(seedSite);
  const wd = '{"enabled":true,"from":"09:00","to":"18:00"}';
  const sat = '{"enabled":true,"from":"10:00","to":"14:00"}';
  db.prepare(`UPDATE branches SET is_24_7=0, working_hours=? WHERE id=1`).run(
    `{"mon":${wd},"tue":${wd},"wed":${wd},"thu":${wd},"fri":${wd},"sat":${sat}}`);
  invalidateContentCache();
  try {
    const html = await (await fetch(base + '/ru/contact')).text();
    // Пять одинаковых дней склеиваются, иначе строка режима работы
    // превращается в семь перечислений и перестаёт читаться.
    assert.match(html, /Пн–Пт 09:00–18:00, Сб 10:00–14:00/);
    // Полная таблица ниже остаётся: она отвечает на вопрос «а в воскресенье?».
    assert.match(html, /contact-hours__list/);
  } finally { server.close(); }
});
