import test from 'node:test';
import assert from 'node:assert/strict';
import { startSite } from '../app.test.js';
import { seedSite, seededSlugs } from '../../test-helpers/site-seed.js';
import { invalidateContentCache } from '../content.js';

// seedSite (site-seed.js) не привязывает врача doc1 к отделению —
// departmentDoctors() ищет по users.department_id, которого в общем
// фикстуре нет (он не нужен другим сьютам). Здесь это единственный тест,
// которому нужна такая связь, поэтому она добавляется прямо в подготовке.
function seedWithDepartmentDoctor(db) {
  const ids = seedSite(db);
  db.prepare("UPDATE users SET department_id = (SELECT department_id FROM website_departments WHERE slug = 'kardiologiya') WHERE username = 'doc1'").run();
  return ids;
}

test('список услуг: группировка по отделению, скрывает неопубликованное', async () => {
  const { server, base } = await startSite(seedWithDepartmentDoctor);
  invalidateContentCache();
  try {
    const res = await fetch(base + '/ru/services');
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /ЭКГ/);
    assert.match(html, /50\u00A0000/, 'цена сгруппирована по разрядам');
    assert.ok(!html.includes('Секретная услуга'), 'неопубликованная услуга невидима');
  } finally { server.close(); }
});

test('карточка услуги: 200, длительность, ссылка записи, MedicalProcedure JSON-LD', async () => {
  const { server, base, db } = await startSite(seedWithDepartmentDoctor);
  invalidateContentCache();
  try {
    const res = await fetch(base + '/ru/services/' + seededSlugs(db).service);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Электрокардиограмма/);
    assert.match(html, /15/);
    assert.match(html, /href="\/ru\/appointment\?service=\d+-ekg"/);
    assert.match(html, /"@type":"MedicalProcedure"/);
  } finally { server.close(); }
});

test('неизвестный слаг услуги — 404; снятая с публикации услуга — тоже 404', async () => {
  const { server, base, db } = await startSite(seedWithDepartmentDoctor);
  invalidateContentCache();
  try {
    const missing = await fetch(base + '/ru/services/missing');
    assert.equal(missing.status, 404);

    // Easy-Med: услугу снимают с сайта в «Услугах для сайта и партнёров» (online_booking)
    const slug = seededSlugs(db).service;
    db.prepare("UPDATE services SET online_booking = 0 WHERE name = 'ЭКГ'").run();
    invalidateContentCache();
    const gone = await fetch(base + '/ru/services/' + slug);
    assert.equal(gone.status, 404);
  } finally { server.close(); }
});

test('список отделений: показывает опубликованное отделение', async () => {
  const { server, base } = await startSite(seedWithDepartmentDoctor);
  invalidateContentCache();
  try {
    const res = await fetch(base + '/ru/departments');
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Кардиология/);
  } finally { server.close(); }
});

test('карточка отделения: 200, врач и услуга отделения; неизвестный слаг — 404', async () => {
  const { server, base } = await startSite(seedWithDepartmentDoctor);
  invalidateContentCache();
  try {
    const res = await fetch(base + '/ru/departments/kardiologiya');
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Алиев Шерзод/);
    assert.match(html, /ЭКГ/);

    const missing = await fetch(base + '/ru/departments/missing');
    assert.equal(missing.status, 404);
  } finally { server.close(); }
});

// WEBSITE_SERVICES_LIST_V1 — каталог строками и кнопка заявки в конце.
// Тест держит три обещания: строчная вёрстка вместо сетки плиток, кнопка
// ПОСЛЕ списка (а не где-то в начале), и то, что страница отделения свою
// витрину плиток сохранила — там услуг несколько, и сетка уместна.
test('список услуг: строки и заявка в каждой, так же и у отделения', async () => {
  const { server, base, db } = await startSite(seedSite);
  // В сидах врач ни к какому отделению не привязан — без этого на странице
  // отделения нечего сравнивать с услугами.
  db.prepare("UPDATE users SET department_id = (SELECT department_id FROM website_departments WHERE slug = 'kardiologiya') WHERE username = 'doc1'").run();
  invalidateContentCache();
  try {
    const html = await (await fetch(base + '/ru/services')).text();
    assert.match(html, /class="svc-rows"/, 'строки, а не сетка');
    assert.ok(!/svc-group[\s\S]{0,300}grid-3/.test(html), 'старой сетки в группах нет');
    assert.match(html, /class="svc-row__price"/, 'цена вынесена в отдельный столбец');
    assert.ok(!html.includes('svc-row__dur'), 'длительности в списке нет');
    assert.match(html, /class="btn btn-primary svc-row__cta"[^>]*href="\/ru\/appointment\?service=/,
      'у каждой услуги своя кнопка заявки с подставленной услугой');
    // Вложенная в <a> ссылка — невалидный HTML: браузер закроет внешний
    // <a> сам и вытолкнет кнопку из строки. Проверяем, что между началом
    // ссылки-названия и кнопкой есть закрывающий тег.
    const a = html.indexOf('svc-row__link');
    const b = html.indexOf('svc-row__cta');
    assert.ok(a > 0 && b > a && html.slice(a, b).includes('</a>'),
      'кнопка — сосед ссылки, а не её потомок');
    assert.ok(!html.includes('section-cta'),
      'общей кнопки внизу нет — она вела бы на пустую форму');
    assert.match(html, /Оставить заявку/);

    // SERVICES_ROWS_EVERYWHERE_V1 — услуга выглядит ОДИНАКОВО везде. Раньше
    // страница отделения держала свою плитку — две вёрстки одного объекта
    // расходятся при первой же правке, причём молча: обе продолжают работать.
    const dept = await (await fetch(base + '/ru/departments/kardiologiya')).text();
    assert.match(dept, /class="svc-rows"/, 'у отделения услуги тоже строками');
    assert.match(dept, /svc-row__cta/, 'и с той же кнопкой заявки');
    assert.ok(!dept.includes('card card--link'), 'плиток услуг не осталось');
    // Врачи — наоборот, плитками: так просил владелец, и это разные
    // сущности: у врача есть лицо, у услуги — цена.
    assert.match(dept, /class="doctor-card"/, 'врачи остались плитками');
  } finally { server.close(); }
});

// SERVICES_FILTER_V1 — фильтр по группе и поиск.
//
// Всё проверяется через СЕРВЕРНУЮ выдачу: живой поиск в site.js — надстройка,
// и если она отвалится, страница обязана остаться рабочей. Тест на это и
// смотрит: ?q= и ?group= должны фильтровать сами по себе.

test('фильтр услуг: панель с чипсами групп и полем поиска', async () => {
  const { server, base } = await startSite(seedSite);
  invalidateContentCache();
  try {
    const html = await (await fetch(base + '/ru/services')).text();
    assert.match(html, /<form class="svc-filter"[^>]*method="get"/, 'настоящая GET-форма, а не только JS');
    assert.match(html, /name="q"/);
    assert.match(html, /svc-filter__go[^>]*>Найти</, 'кнопка поиска есть');
    assert.match(html, /class="svc-chip is-current"[^>]*>Все/, 'чипс «Все» выбран по умолчанию');
    assert.match(html, /href="\/ru\/services\?group=kardiologiya"[^>]*>Кардиология/);
    assert.match(html, /svc-row" data-search="/, 'строки несут поле для живого поиска');
    assert.ok(/data-search="[^"]*экг/.test(html), 'data-search в нижнем регистре');
  } finally { server.close(); }
});

test('поиск услуг: ищет и по описанию, не только по названию', async () => {
  const { server, base } = await startSite(seedSite);
  invalidateContentCache();
  try {
    // «электрокард» есть только в short_desc услуги ЭКГ — если поиск смотрит
    // лишь на название, здесь будет пусто.
    const hit = await (await fetch(base + '/ru/services?q=' + encodeURIComponent('электрокард'))).text();
    assert.match(hit, /svc-row__name">ЭКГ</);
    assert.ok(!/data-svc-none(?![^>]*hidden)/.test(hit), 'блок «ничего не найдено» скрыт');

    const miss = await (await fetch(base + '/ru/services?q=' + encodeURIComponent('зубы'))).text();
    assert.ok(!miss.includes('svc-row__name'), 'ни одной строки');
    assert.match(miss, /data-svc-none(?![^>]*hidden)/, 'блок «ничего не найдено» показан');
    assert.match(miss, /По вашему запросу ничего не найдено/);
    assert.match(miss, /href="\/ru\/services"[^>]*>Сбросить/, 'есть выход из пустого результата');
    assert.match(miss, /class="svc-filter"/, 'панель осталась — иначе искать заново нечем');
  } finally { server.close(); }
});

test('фильтр по группе: показывает свою, чипсы остаются все', async () => {
  const { server, base } = await startSite(seedSite);
  invalidateContentCache();
  try {
    const html = await (await fetch(base + '/ru/services?group=kardiologiya')).text();
    assert.match(html, /svc-row__name">ЭКГ</);
    assert.match(html, /class="svc-chip is-current"[^>]*aria-current="true"[^>]*>Кардиология/);

    // Чипсы строятся по ПОЛНОМУ списку: выбрав группу, человек обязан
    // видеть остальные, иначе переключиться не на что.
    const nobody = await (await fetch(base + '/ru/services?group=net-takoy')).text();
    assert.ok(!nobody.includes('svc-row__name'), 'чужая группа — пусто');
    assert.match(nobody, /href="\/ru\/services\?group=kardiologiya"/, 'чипсы на месте');
  } finally { server.close(); }
});

test('поиск и группа не сбрасывают друг друга', async () => {
  const { server, base } = await startSite(seedSite);
  invalidateContentCache();
  try {
    const q = encodeURIComponent('экг');
    const html = await (await fetch(base + '/ru/services?group=kardiologiya&q=' + q)).text();
    assert.match(html, /svc-row__name">ЭКГ</);
    // Группа едет скрытым полем — иначе «Найти» потеряло бы выбранную группу.
    assert.match(html, /<input type="hidden" name="group" value="kardiologiya">/);
    // А чипсы несут текущий запрос с собой.
    assert.ok(html.includes('q=' + q), 'ссылки чипсов сохраняют запрос');
  } finally { server.close(); }
});
