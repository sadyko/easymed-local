import test from 'node:test';
import assert from 'node:assert/strict';
import { startSite } from '../app.test.js';
import { seedSite, seededSlugs } from '../../test-helpers/site-seed.js';
import { invalidateContentCache } from '../content.js';

test('список врачей: показывает опубликованных, скрывает неопубликованных', async () => {
  const { server, base } = await startSite(seedSite);
  invalidateContentCache();
  try {
    const res = await fetch(base + '/ru/doctors');
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Алиев Шерзод/);
    assert.match(html, /Кардиолог/);
    assert.ok(!html.includes('Скрытый Врач'), 'неопубликованный врач невидим');
  } finally { server.close(); }
});

test('профиль врача: 200, био, ссылка на запись, Physician JSON-LD', async () => {
  const { server, base, db } = await startSite(seedSite);
  invalidateContentCache();
  try {
    const res = await fetch(base + '/ru/doctors/' + seededSlugs(db).doctor);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Опытный кардиолог/);
    assert.match(html, /href="\/ru\/appointment\?doctor=\d+-aliyev-sherzod"/);
    assert.match(html, /"@type":"Physician"/);
  } finally { server.close(); }
});

test('неизвестный слаг — 404', async () => {
  const { server, base } = await startSite(seedSite);
  invalidateContentCache();
  try {
    const res = await fetch(base + '/ru/doctors/nobody');
    assert.equal(res.status, 404);
  } finally { server.close(); }
});

test('снятый с публикации врач — 404 на профиле', async () => {
  const { server, base, db } = await startSite(seedSite);
  invalidateContentCache();
  try {
    // Easy-Med: своей публикации у сайта нет — врача снимают в профиле (is_public)
    const slug = seededSlugs(db).doctor;
    db.prepare("UPDATE users SET is_public = 0 WHERE username = 'doc1'").run();
    invalidateContentCache();
    const res = await fetch(base + '/ru/doctors/' + slug);
    assert.equal(res.status, 404);
  } finally { server.close(); }
});

// DOCTOR_CARD_ACTIONS_V1 — две кнопки на карточке врача.

test('карточка врача: «Подробнее» и «Оставить заявку» с подставленным врачом', async () => {
  const { server, base } = await startSite(seedSite);
  invalidateContentCache();
  try {
    const html = await (await fetch(base + '/ru/doctors')).text();
    assert.match(html, /class="doctor-card"/);
    assert.match(html, /doctor-card__btn"[^>]*href="\/ru\/doctors\/\d+-aliyev-sherzod"[^>]*>Подробнее</);
    assert.match(html,
      /href="\/ru\/appointment\?doctor=(\d+-aliyev-sherzod)"[\s\S]{0,200}data-doctor="\1"/,
      'кнопка заявки несёт врача и остаётся настоящей ссылкой');
    // QR_SUBJECT_DETAIL_V1 — окно заявки называет врача полностью: имя,
    // специальность и стаж, потому что окно перекрывает карточку, где это видно.
    // Между числом и «лет» — неразрывный пробел, как в meta карточки.
    assert.match(html, /data-subject="Алиев Шерзод — Кардиолог · 12 лет опыта"/);

    // Вложенная в <a> ссылка невалидна: браузер закрыл бы внешний тег сам и
    // вытолкнул кнопки ЗА пределы карточки.
    const a = html.indexOf('doctor-card__link');
    const b = html.indexOf('doctor-card__actions');
    assert.ok(a > 0 && b > a && html.slice(a, b).includes('</a>'),
      'кнопки — соседи ссылки, а не её потомки');
  } finally { server.close(); }
});

test('карточка врача одна на все страницы: главная и отделение те же кнопки', async () => {
  const { server, base, db } = await startSite(seedSite);
  // В сидах врач ни к какому отделению не привязан, а страница отделения
  // берёт врачей по users.department_id — без этого проверять там нечего.
  db.prepare("UPDATE users SET department_id = (SELECT department_id FROM website_departments WHERE slug = 'kardiologiya') WHERE username = 'doc1'").run();
  invalidateContentCache();
  try {
    // На главной лежала вторая копия разметки карточки. Тест сторожит, что
    // копий снова не стало две: разойдутся молча, обе продолжат работать.
    const home = await (await fetch(base + '/ru/')).text();
    assert.match(home, /doctor-card__actions/, 'кнопки есть и на главной');
    assert.match(home, /data-qr-open[^>]*data-doctor="\d+-aliyev-sherzod"/);

    const dept = await (await fetch(base + '/ru/departments/kardiologiya')).text();
    assert.match(dept, /doctor-card__actions/, 'кнопки есть и на странице отделения');
  } finally { server.close(); }
});
