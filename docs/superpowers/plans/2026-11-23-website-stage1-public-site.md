# Модуль «Веб-сайт», этап 1 — основа и публичный сайт: план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Публичный сайт клиники на порту 8001 (все страницы, три языка, форма записи в CRM), перенесённый из Chilla и поднимаемый только при модуле лицензии `website` и включённом «Сайт включён».

**Architecture:** Код `server/site/**` и `public/site/**` переносится из Chilla
(`C:\Users\Desinger\Desktop\easymed.uz (Chilla)`, дальше — `$CHILLA`) почти
дословно. Меняются три места: `content.js` берёт врачей и услуги из
СУЩЕСТВУЮЩИХ публичных профилей (`doctorPublicState`, `servicePublicState` —
решение владельца 2026-11-23: «Reuse existing profiles»), `requests.js` заводит
карточку CRM так, как это делает этот проект сегодня, а новый
`server/site/controller.js` поднимает и закрывает слушатель по лицензии и
настройке.

**Tech Stack:** Node 24 ESM, Express 5, better-sqlite3, `node:test`. Без сборки, без CDN.

**Spec:** `docs/superpowers/specs/2026-11-23-website-module-design.md`.

**Рабочая папка:** `C:\Users\Desinger\Desktop\Easymed Original\em-website`
(ветка `feat/website-module`, от `origin/main` 3.27.0). Все пути ниже — от неё.
**Ничего не пушить, не менять версию, не ставить тег.**

**Правила этого репозитория, которые здесь важны:**
- Комментарии — по-русски, с меткой `WEBSITE_V1`, объясняют ПОЧЕМУ (стиль файлов вокруг).
- Тесты лежат рядом с кодом (`*.test.js`), `npm test` гоняет всё.
- Под Windows ~9 тестов, разбирающих исходники, падают из-за CRLF — это не регрессия (память `crlf-source-parsing-test-failures`). Сетевые «bad port» в тестах с портами — известный флейк, перезапустить.
- `npm test` не запускать, пока другой агент пишет файлы.

---

## Карта файлов

| Файл | Что | Откуда |
|---|---|---|
| `server/db/migrations/298_website.sql` (+`298.test.js`) | таблицы сайта | 083+087 Chilla, переделаны (§ Задача 1) |
| `server/site/i18n.js`, `rate-limit.js`, `seo.js`, `notify.js`, `analytics.js` (+ тесты) | как в Chilla | дословно |
| `server/site/render/*.js` (+ тесты) | страницы | дословно, тесты — новые засевы |
| `public/site/**` | стили, скрипты, шрифты, лого | дословно |
| `server/site/content.js` (+`content.test.js`) | чтение контента | **переписан**: врачи/услуги из профилей |
| `server/site/test-seed.js` | засев для тестов сайта | **новый** |
| `server/site/media.js` (+тест) | `/media/*` | Chilla + фото врачей из профиля |
| `server/site/requests.js` (+тест) | приём заявки | Chilla + карточка CRM по-здешнему |
| `server/site/app.js` (+`app.test.js`, `security.test.js`) | Express-приложение сайта | дословно, правка импортов при надобности |
| `server/site/controller.js` (+тест) | поднять/закрыть слушатель | **новый** |
| `server/index.js` | подключение контроллера и чистки аналитики | правка |
| `server/routes/storage.js` | корзина `website` | правка |
| `scripts/site-preview.mjs` | просмотр сайта владельцем на копии базы | **новый** |

---

### Task 1: Миграция 298 — таблицы сайта

**Files:**
- Create: `server/db/migrations/298_website.sql`
- Test: `server/db/migrations/298.test.js`

- [ ] **Step 1: Проверить, что 298 свободен на `origin/main`**

Run: `git fetch origin main --quiet; git ls-tree --name-only origin/main server/db/migrations/ | Select-String '\.sql$' | Select-Object -Last 2`
Expected: последний — `297_doctor_bot_message_template.sql`. Если на main уже есть 298+ — взять следующий свободный номер и заменить «298» во всех шагах плана.

- [ ] **Step 2: Написать падающий тест**

```js
// WEBSITE_V1 — миграция 298: таблицы сайта клиники (перенос 083+087 Chilla).
// Врачи и услуги публикуются ПРОФИЛЕМ (users.is_public, services.online_booking),
// поэтому у website_doctors / website_services нет ни published, ни slug.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

const cols = (db, t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);

test('298 WEBSITE_V1: таблицы сайта есть, строка настроек одна и пустая', () => {
  const db = openDb(':memory:');
  migrate(db);
  for (const t of ['website_settings', 'website_doctors', 'website_services', 'website_departments',
    'website_testimonials', 'website_faq', 'website_posts', 'website_requests',
    'website_sessions', 'website_pageviews', 'website_stats_daily']) {
    assert.ok(cols(db, t).length > 0, 'нет таблицы ' + t);
  }
  assert.deepEqual(db.prepare('SELECT id, settings FROM website_settings').all(), [{ id: 1, settings: '{}' }]);
  db.close();
});

test('298 WEBSITE_V1: у врачей и услуг сайта нет своего «published» и слага — показ решает профиль', () => {
  const db = openDb(':memory:');
  migrate(db);
  for (const t of ['website_doctors', 'website_services']) {
    assert.ok(!cols(db, t).includes('published'), t + '.published не должно быть');
    assert.ok(!cols(db, t).includes('slug'), t + '.slug не должно быть');
  }
  assert.ok(cols(db, 'website_requests').includes('session_id'), 'session_id из 087 Chilla');
  db.close();
});

test('298 WEBSITE_V1: источник CRM «Сайт» есть в справочнике источников', () => {
  const db = openDb(':memory:');
  migrate(db);
  const row = db.prepare("SELECT key, is_active FROM crm_sources WHERE key = 'website'").get();
  assert.ok(row, 'crm_sources.website');
  db.close();
});
```

- [ ] **Step 3: Убедиться, что падает**

Run: `node --test server/db/migrations/298.test.js`
Expected: FAIL — `no such table: website_settings`.

- [ ] **Step 4: Написать миграцию**

`server/db/migrations/298_website.sql`:

```sql
-- WEBSITE_V1 — публичный сайт клиники (перенос модуля из Chilla: его 083 + 087).
--
-- Сайт — второй слушатель того же процесса (server/site/), поднимается только
-- при модуле лицензии website и включённом «Сайт включён» (server/site/controller.js).
--
-- ОТЛИЧИЕ ОТ CHILLA (решение владельца 2026-11-23, «Reuse existing profiles»):
-- врачей и услуги на сайт выводит ТОТ ЖЕ показ, что для Symptex и партнёров —
-- users.is_public (shared/doctor-public.js) и services.online_booking
-- (shared/service-public.js). Поэтому website_doctors и website_services — не
-- «вторая публикация», а только добавки сайта: порядок, «на главной», описание
-- услуги. Ни published, ни slug у них нет — слаг строится из id и имени
-- (server/site/content.js).
--
-- website_settings, website_requests и таблицы аналитики НЕ регистрируются в
-- server/db/schema-registry.js (прецедент — telegram_settings): заявки — это
-- персональные данные, путь к ним только через серверные обработчики.

CREATE TABLE website_settings (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  -- JSON: { enabled, default_lang, langs, hero, stats, why_us, contact,
  --         social, seo, legal, analytics, notify }
  settings   TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
INSERT INTO website_settings (id) VALUES (1);

CREATE TABLE website_doctors (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id),
  sort_order INTEGER NOT NULL DEFAULT 0,
  featured   INTEGER NOT NULL DEFAULT 0 CHECK (featured IN (0,1)),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE website_services (
  service_id INTEGER PRIMARY KEY REFERENCES services(id),
  sort_order INTEGER NOT NULL DEFAULT 0,
  featured   INTEGER NOT NULL DEFAULT 0 CHECK (featured IN (0,1)),
  image_path TEXT NOT NULL DEFAULT '',
  -- по языкам: { short_desc, body, preparation } — название берётся из services
  content    TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE website_departments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  department_id INTEGER NOT NULL UNIQUE REFERENCES departments(id),
  published     INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0,1)),
  slug          TEXT NOT NULL UNIQUE,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  image_path    TEXT NOT NULL DEFAULT '',
  content       TEXT NOT NULL DEFAULT '{}',
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE website_testimonials (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  published   INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0,1)),
  sort_order  INTEGER NOT NULL DEFAULT 0,
  author_name TEXT NOT NULL DEFAULT '',
  rating      INTEGER CHECK (rating BETWEEN 1 AND 5),
  content     TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE website_faq (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  published  INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0,1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  content    TEXT NOT NULL DEFAULT '{}',   -- по языкам: { q, a }
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE website_posts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  published    INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0,1)),
  slug         TEXT NOT NULL UNIQUE,
  cover_path   TEXT NOT NULL DEFAULT '',
  content      TEXT NOT NULL DEFAULT '{}',   -- по языкам: { title, excerpt, body }
  published_at TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- Входящие с сайта — неизменяемая запись того, что отправил пациент. Заявка на
-- приём дополнительно заводит карточку CRM (источник 'website'); статус здесь —
-- только разбор входящих.
CREATE TABLE website_requests (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  type           TEXT NOT NULL CHECK (type IN ('appointment','contact','callback')),
  status         TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','in_progress','done','spam')),
  full_name      TEXT NOT NULL,
  phone          TEXT NOT NULL DEFAULT '',
  email          TEXT NOT NULL DEFAULT '',
  message        TEXT NOT NULL DEFAULT '',
  service_id     INTEGER REFERENCES services(id),
  doctor_id      INTEGER REFERENCES users(id),
  department_id  INTEGER REFERENCES departments(id),
  preferred_date TEXT,
  preferred_time TEXT NOT NULL DEFAULT '' CHECK (preferred_time IN ('','morning','afternoon','evening')),
  locale         TEXT NOT NULL DEFAULT '',
  page           TEXT NOT NULL DEFAULT '',
  crm_request_id INTEGER REFERENCES crm_requests(id),
  assigned_to    INTEGER REFERENCES users(id),
  staff_notes    TEXT NOT NULL DEFAULT '',
  ip_hash        TEXT NOT NULL DEFAULT '',   -- сырые IP не храним
  user_agent     TEXT NOT NULL DEFAULT '',
  -- Без FK: сессии вычищаются по сроку хранения, заявка обязана пережить чистку.
  session_id     TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_website_requests_status ON website_requests(status, created_at);
CREATE INDEX idx_website_requests_created ON website_requests(created_at);

-- Аналитика — без персональных данных вообще.
CREATE TABLE website_sessions (
  id            TEXT PRIMARY KEY,
  day           TEXT NOT NULL,
  first_seen    TEXT NOT NULL,
  last_seen     TEXT NOT NULL,
  pageviews     INTEGER NOT NULL DEFAULT 0,
  entry_path    TEXT NOT NULL DEFAULT '',
  referrer_host TEXT NOT NULL DEFAULT '',
  utm_source    TEXT NOT NULL DEFAULT '',
  utm_medium    TEXT NOT NULL DEFAULT '',
  utm_campaign  TEXT NOT NULL DEFAULT '',
  device        TEXT NOT NULL DEFAULT '',
  lang          TEXT NOT NULL DEFAULT '',
  is_returning  INTEGER NOT NULL DEFAULT 0 CHECK (is_returning IN (0,1))
);
CREATE INDEX idx_website_sessions_day ON website_sessions(day);

CREATE TABLE website_pageviews (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES website_sessions(id),
  path       TEXT NOT NULL,
  page_type  TEXT NOT NULL DEFAULT '',
  entity_id  INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_website_pageviews_session ON website_pageviews(session_id);
CREATE INDEX idx_website_pageviews_created ON website_pageviews(created_at);

CREATE TABLE website_stats_daily (
  day    TEXT NOT NULL,
  metric TEXT NOT NULL,
  key    TEXT NOT NULL DEFAULT '',
  value  REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (day, metric, key)
);
```

- [ ] **Step 5: Тест проходит**

Run: `node --test server/db/migrations/298.test.js`
Expected: PASS, 3 теста. Если третий падает (источника `website` нет в `crm_sources`), дописать в миграцию
`INSERT OR IGNORE INTO crm_sources (key, label, position, is_active) VALUES ('website', 'Сайт', (SELECT COALESCE(MAX(position),0)+1 FROM crm_sources), 1);`
(столбцы сверить с `077_crm_config.sql`).

- [ ] **Step 6: Проверка порядка миграций и коммит**

Run: `node --test server/db/migration-order.test.js server/db/migrate.test.js`
Expected: PASS.

```powershell
git add server/db/migrations/298_website.sql server/db/migrations/298.test.js
git commit -m "Сайт (WEBSITE_V1), этап 1: миграция 298 — таблицы сайта; врачи и услуги — по профилю, без своей публикации"
```

---

### Task 2: Дословный перенос модулей без базы и статики

**Files:**
- Create (копии из `$CHILLA`): `server/site/i18n.js`, `i18n.test.js`, `rate-limit.js`, `public/site/**` (все файлы, включая `fonts/*.woff2`, `logo.webp`)

- [ ] **Step 1: Скопировать**

```powershell
$CHILLA = "C:\Users\Desinger\Desktop\easymed.uz (Chilla)"
New-Item -ItemType Directory -Force server\site\render, public\site | Out-Null
foreach ($f in 'i18n.js','i18n.test.js','rate-limit.js') { Copy-Item "$CHILLA\server\site\$f" "server\site\$f" }
Copy-Item "$CHILLA\public\site\*" "public\site\" -Recurse
Get-ChildItem public\site -Recurse -File | Select-Object FullName, Length
```
Expected: `site.css`, `site.js`, `hero.js`, `doctors.js`, `services.js`, `logo.webp`, `fonts\manrope-*.woff2` (4 шт.).

- [ ] **Step 2: Проверить, что в статике нет сетевых адресов**

Run: `Select-String -Path public\site\*.css,public\site\*.js -Pattern 'https?://' | Select-Object Filename, LineNumber, Line`
Expected: пусто (или только комментарии). Любой внешний URL в рабочем коде — убрать: проект без CDN (CLAUDE.md).

- [ ] **Step 3: Тест i18n**

Run: `node --test server/site/i18n.test.js`
Expected: PASS.

- [ ] **Step 4: Проверка «офлайн» теста проекта**

Run: `node --test public/js/admin/__tests__/offline-cloud-calls.test.mjs` (если файла нет — `Get-ChildItem -Recurse -Filter *offline*.test.* server,public | % FullName` и запустить найденный).
Expected: PASS или тот же результат, что до копирования (этот тест в списке CRLF-падений — сравнить с `git stash`-свободным способом: запустить его на `origin/main` в другой папке не нужно, достаточно увидеть, что сообщение об ошибке не упоминает `public/site`).

- [ ] **Step 5: Коммит**

```powershell
git add server/site/i18n.js server/site/i18n.test.js server/site/rate-limit.js public/site
git commit -m "Сайт (WEBSITE_V1), этап 1: словари сайта, ограничитель запросов и статика (стили, скрипты, шрифты Manrope) из Chilla"
```

---

### Task 3: Засев для тестов сайта

Тесты Chilla засевают врачей и услуги строками `website_doctors`/`website_services`
с `published=1` и `slug`. Здесь показ решает профиль, поэтому нужен один помощник,
который делает врача и услугу «показанными» по правилам `doctorPublicState` и
`servicePublicState`.

**Files:**
- Create: `server/site/test-seed.js`
- Test: `server/site/test-seed.test.js`

- [ ] **Step 1: Прочитать правила показа**

Прочитать `public/js/shared/doctor-public.js` (функции `publicationProblem`, `doctorPublicState`)
и `public/js/shared/service-public.js` (`servicePublicState`, `serviceNames`), а также
`public/js/shared/branch-profile.js` (`branchAllowsDoctor`) — какие столбцы `users`,
`branches`, `user_specialties`, `services` должны быть заполнены, чтобы состояние было `'shown'`.

- [ ] **Step 2: Написать падающий тест**

```js
// WEBSITE_V1 — засев тестов сайта: показанный врач и показанная услуга по
// ПРАВИЛАМ ПРОФИЛЯ (те же функции, что у Symptex), а не строкой website_*.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { seedDoctor, seedService } from './test-seed.js';
import { publicDoctors } from '../services/api/snapshot.js';
import { servicePublicState } from '../../public/js/shared/service-public.js';

test('seedDoctor({shown:true}) — врач показан по правилам профиля; shown:false — скрыт', () => {
  const db = openDb(':memory:'); migrate(db);
  const a = seedDoctor(db, { ru: 'Иванов Иван', uz: 'Ivanov Ivan', specialty: 'Кардиолог', shown: true });
  const b = seedDoctor(db, { ru: 'Петров Пётр', specialty: 'Терапевт', shown: false });
  const ids = publicDoctors(db).map((u) => u.id);
  assert.ok(ids.includes(a)); assert.ok(!ids.includes(b));
  db.close();
});

test('seedService({shown:true}) — услуга показана; shown:false — нет', () => {
  const db = openDb(':memory:'); migrate(db);
  const a = seedService(db, { ru: 'УЗИ', uz: 'UZI', price: 100000, shown: true });
  const b = seedService(db, { ru: 'Анализ', uz: 'Tahlil', price: 5000, shown: false });
  const row = (id) => db.prepare('SELECT * FROM services WHERE id = ?').get(id);
  assert.equal(servicePublicState(row(a)), 'shown');
  assert.notEqual(servicePublicState(row(b)), 'shown');
  db.close();
});
```

- [ ] **Step 3: Убедиться, что падает**

Run: `node --test server/site/test-seed.test.js`
Expected: FAIL — `Cannot find module './test-seed.js'`.

- [ ] **Step 4: Написать помощник**

Столбцы `INSERT` сверить со схемой (`PRAGMA table_info(users)` / `services` в тесте или в
`server/db/migrations/*`): обязательные NOT NULL без умолчания (например, `username`,
`password_hash`, `role` у `users`; `name`, `price` у `services`) должны быть заполнены.

```js
// WEBSITE_V1 — засев для тестов сайта (не для рабочего кода).
// Делает врача и услугу показанными ТАК ЖЕ, как это делает администратор в
// «Публичном профиле» и «Услугах для сайта и партнёров»: тесты сайта не должны
// знать про внутренности правил показа — только про этот помощник.
let seq = 0;

export function seedDoctor(db, { ru, uz = '', en = '', specialty = 'Терапевт', shown = true, active = 1, departmentId = null, bio = {} } = {}) {
  seq += 1;
  const id = Number(db.prepare(`INSERT INTO users (username, password_hash, full_name, role, is_doctor, is_active,
      is_public, full_name_ru, full_name_uz, full_name_en, bio_ru, bio_uz, bio_en, languages, department_id)
    VALUES (?, 'x', ?, 'doctor', 1, ?, ?, ?, ?, ?, ?, ?, ?, '["ru","uz"]', ?)`)
    .run('site-doc-' + seq, ru, active, shown ? 1 : 0, ru, uz, en, bio.ru || '', bio.uz || '', bio.en || '', departmentId).lastInsertRowid);
  db.prepare('INSERT INTO user_specialties (user_id, specialty_slug, name_ru, name_uz, is_primary) VALUES (?, ?, ?, ?, 1)')
    .run(id, 'spec-' + seq, specialty, specialty);
  return id;
}

export function seedService(db, { ru, uz = '', en = '', price = 0, shown = true, departmentId = null, minutes = null } = {}) {
  return Number(db.prepare(`INSERT INTO services (name, name_uz, name_en, price, active, online_booking, department_id, duration_minutes)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?)`).run(ru, uz, en, price, shown ? 1 : 0, departmentId, minutes).lastInsertRowid);
}
```

- [ ] **Step 5: Тест проходит**

Run: `node --test server/site/test-seed.test.js`
Expected: PASS. Если первый тест падает — `publicationProblem` требует ещё поле (например,
филиал): дописать его в `seedDoctor` и повторить; правила показа НЕ трогать.

- [ ] **Step 6: Коммит**

```powershell
git add server/site/test-seed.js server/site/test-seed.test.js
git commit -m "Сайт (WEBSITE_V1), этап 1: засев тестов сайта — врач и услуга показаны по правилам профиля"
```

---

### Task 4: `content.js` — врачи и услуги из профилей

Рендеры Chilla читают у врача поля `slug, photo_path, experience_years, langs_spoken,
sort_order, content` (JSON по языкам `{name, specialty, bio, education, focus}`), а у
услуги — `slug, featured, image_path, sort_order, content` (`{name, short_desc, body,
preparation}`), `price, duration_minutes, department_id, type, type_name`. Новый
`content.js` отдаёт строки ТОЙ ЖЕ формы, собирая их из профиля, — тогда рендеры
переносятся без правок.

**Files:**
- Create: `server/site/content.js` (на основе `$CHILLA\server\site\content.js`)
- Test: `server/site/content.test.js` (новый; тест Chilla не переносится — он засевает `website_doctors.published`)

- [ ] **Step 1: Скопировать файл Chilla как основу**

```powershell
Copy-Item "$CHILLA\server\site\content.js" server\site\content.js
```
Функции `invalidateContentCache, cached, getSettings, enabledLangsFromSettings,
defaultLangFromSettings, enabledLangs, defaultLang, publishedDepartments,
departmentBySlug, publishedTestimonials, publishedFaq, publishedPosts, postBySlug,
clinicHours` остаются как есть.

- [ ] **Step 2: Написать падающий тест**

```js
// WEBSITE_V1 — content.js: врачи и услуги сайта — это показанные в профиле.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { seedDoctor, seedService } from './test-seed.js';
import { publishedDoctors, doctorBySlug, publishedServices, serviceBySlug, departmentDoctors,
  departmentServices, invalidateContentCache } from './content.js';

function fresh() { invalidateContentCache(); const db = openDb(':memory:'); migrate(db); return db; }
const names = (rows, lang = 'ru') => rows.map((r) => JSON.parse(r.content)[lang]?.name);

test('на сайте — только врачи, показанные в профиле, и только активные', () => {
  const db = fresh();
  seedDoctor(db, { ru: 'Показан Врач', specialty: 'Кардиолог' });
  seedDoctor(db, { ru: 'Скрыт Врач', shown: false });
  seedDoctor(db, { ru: 'Уволен Врач', active: 0 });
  assert.deepEqual(names(publishedDoctors(db)), ['Показан Врач']);
  db.close();
});

test('врач — имя и специальность по языкам из профиля, слаг из id, по слагу находится', () => {
  const db = fresh();
  const id = seedDoctor(db, { ru: 'Иванов Иван', uz: 'Ivanov Ivan', en: 'Ivan Ivanov', specialty: 'Кардиолог', bio: { ru: 'Опыт', uz: 'Tajriba' } });
  const [d] = publishedDoctors(db);
  const c = JSON.parse(d.content);
  assert.equal(c.ru.name, 'Иванов Иван'); assert.equal(c.uz.name, 'Ivanov Ivan'); assert.equal(c.en.name, 'Ivan Ivanov');
  assert.equal(c.ru.specialty, 'Кардиолог'); assert.equal(c.ru.bio, 'Опыт');
  assert.match(d.slug, new RegExp('^' + id + '(-|$)'));
  assert.equal(doctorBySlug(db, d.slug).user_id, id);
  assert.equal(doctorBySlug(db, String(id)).user_id, id, 'по одному id тоже находится — слаг переживает смену имени');
  assert.equal(doctorBySlug(db, '999999'), undefined);
  db.close();
});

test('скрытого врача по слагу не найти', () => {
  const db = fresh();
  const id = seedDoctor(db, { ru: 'Скрыт', shown: false });
  assert.equal(doctorBySlug(db, String(id)), undefined);
  db.close();
});

test('наружу у врача — только перечисленные поля, без пароля, роли, телефона', () => {
  const db = fresh();
  seedDoctor(db, { ru: 'Иванов' });
  const [d] = publishedDoctors(db);
  assert.deepEqual(Object.keys(d).sort(), ['content', 'experience_years', 'featured', 'id', 'langs_spoken', 'photo_path', 'slug', 'sort_order']);
  db.close();
});

test('услуги — только показанные; название из services, описание — из website_services', () => {
  const db = fresh();
  const a = seedService(db, { ru: 'УЗИ', uz: 'UZI', price: 120000, minutes: 30 });
  seedService(db, { ru: 'Скрытая', uz: 'Yashirin', shown: false });
  db.prepare("INSERT INTO website_services (service_id, featured, content) VALUES (?, 1, ?)").run(a, JSON.stringify({ ru: { short_desc: 'Кратко' } }));
  invalidateContentCache();
  const rows = publishedServices(db);
  assert.deepEqual(names(rows), ['УЗИ']);
  const s = rows[0];
  assert.equal(JSON.parse(s.content).uz.name, 'UZI');
  assert.equal(JSON.parse(s.content).ru.short_desc, 'Кратко');
  assert.equal(s.price, 120000); assert.equal(s.duration_minutes, 30); assert.equal(s.featured, 1);
  assert.equal(serviceBySlug(db, s.slug).service_id, a);
  assert.ok(!('service_id' in s), 'service_id наружу только через serviceBySlug');
  db.close();
});

test('врачи и услуги отделения', () => {
  const db = fresh();
  const dep = Number(db.prepare("INSERT INTO departments (name) VALUES ('Кардиология')").run().lastInsertRowid);
  seedDoctor(db, { ru: 'В отделении', departmentId: dep });
  seedDoctor(db, { ru: 'Вне отделения' });
  seedService(db, { ru: 'ЭКГ', uz: 'EKG', departmentId: dep });
  assert.deepEqual(names(departmentDoctors(db, dep)), ['В отделении']);
  assert.deepEqual(names(departmentServices(db, dep)), ['ЭКГ']);
  db.close();
});
```

- [ ] **Step 3: Убедиться, что падает**

Run: `node --test server/site/content.test.js`
Expected: FAIL — запросы Chilla ссылаются на `wd.published` / `wd.slug`, которых нет.

- [ ] **Step 4: Заменить в `server/site/content.js` функции врачей и услуг**

Заменить шапку-комментарий файла и функции `publishedDoctors, doctorBySlug,
publishedServices, serviceBySlug, departmentDoctors, departmentServices` на код ниже.
Остальное (Step 1) не трогать. `SELECT` в `getSettings` проверить по схеме
`doc_settings` этого проекта (`PRAGMA table_info(doc_settings)`): если столбцов
`clinic_name`/`address`/`phone`/`email` нет под этими именами — взять те, что читает
`server/services/api/snapshot.js` (функция с `SELECT * FROM doc_settings`), и
поправить только этот `SELECT`.

```js
// WEBSITE_V1 — читающие модели сайта. ЕДИНСТВЕННОЕ место, где сайт трогает
// базу ради содержимого.
//
// ВРАЧИ И УСЛУГИ (решение владельца 2026-11-23, «Reuse existing profiles»):
// показ — тот же, что у Symptex и партнёров: publicDoctors() (doctorPublicState)
// и servicePublicState(). Своей «публикации» у сайта нет, чтобы врач не мог
// оказаться скрытым у партнёров и показанным на сайте. Таблицы website_doctors /
// website_services — только добавки сайта (порядок, «на главной», описание).
//
// ГРАНИЦА БЕЗОПАСНОСТИ: строки собираются здесь ЯВНО, поле за полем (toDoctor,
// toService). Из users наружу идут только публичные поля профиля — те же, что
// уходят партнёрам; пароль, роль, телефон, логин сюда не попадают никогда.
// Форма строк — та же, что у Chilla, поэтому рендеры перенесены без правок.
import { LANGS, DEFAULT_LANG } from './i18n.js';
import { publicDoctors, profileEntries } from '../services/api/snapshot.js';
import { readLanguages, shownPracticeSince, experienceYears } from '../../public/js/shared/doctor-public.js';
import { servicePublicState, serviceNames } from '../../public/js/shared/service-public.js';

const text = (v) => String(v == null ? '' : v).trim();
const jsonObj = (s) => { try { const v = JSON.parse(s || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; } };

/** Латинская часть слага: только [a-z0-9-]; пусто — слаг из одного id. */
export function slugTail(name) {
  return text(name).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[ʻʼ‘’'`]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}
const slugOf = (id, latinName) => { const t = slugTail(latinName); return t ? `${id}-${t}` : String(id); };
/** Слаг → id: решает ведущее число, хвост — для людей и поисковиков. Смена имени ссылку не ломает. */
const idOfSlug = (slug) => { const m = /^(\d{1,9})(?:-[a-z0-9-]*)?$/.exec(String(slug || '')); return m ? Number(m[1]) : null; };

function educationText(raw, lang) {
  return profileEntries(raw, { range: true }).map((e) => {
    const name = e.name[lang] || e.name.ru || e.name.uz || e.name.en;
    const years = [e.year_from, e.year_to].filter((y) => y != null).join('–');
    return [years, name].filter(Boolean).join(' ');
  }).filter(Boolean).join('\n');
}

function toDoctor(u, specs, extra, now) {
  const content = {};
  for (const lang of LANGS) {
    const name = text(u['full_name_' + lang]) || (lang === 'ru' ? text(u.full_name) : '');
    if (!name) continue;
    const sp = specs.map((s) => text(lang === 'uz' ? s.name_uz : s.name_ru) || text(s.name_ru)).find(Boolean) || '';
    content[lang] = {
      name, specialty: sp, bio: text(u['bio_' + lang]),
      education: educationText(u.education_entries, lang), focus: text(u['academic_title_' + lang]),
    };
  }
  const since = shownPracticeSince(u, now);
  return {
    id: u.id,
    slug: slugOf(u.id, u.full_name_en || u.full_name_uz),
    photo_path: u.photo_url ? `doctor/${u.id}` : '',   // раздаёт media.js только для показанного врача
    experience_years: since == null ? null : experienceYears(since, now),
    langs_spoken: readLanguages(u.languages).join(','),
    sort_order: extra ? Number(extra.sort_order) || 0 : 0,
    featured: extra ? Number(extra.featured) || 0 : 0,
    content: JSON.stringify(content),
  };
}

function shownDoctors(db) {
  return cached('doctors:all', () => {
    const now = new Date();
    const specs = db.prepare('SELECT user_id, name_ru, name_uz FROM user_specialties ORDER BY is_primary DESC, id').all();
    const extras = new Map(db.prepare('SELECT user_id, sort_order, featured FROM website_doctors').all().map((r) => [r.user_id, r]));
    return publicDoctors(db).filter((u) => Number(u.is_active) === 1).map((u) => ({
      row: toDoctor(u, specs.filter((s) => s.user_id === u.id), extras.get(u.id), now),
      user_id: u.id, department_id: u.department_id == null ? null : Number(u.department_id),
    })).sort((a, b) => a.row.sort_order - b.row.sort_order || a.row.id - b.row.id);
  });
}

export function publishedDoctors(db) { return shownDoctors(db).map((d) => d.row); }

export function doctorBySlug(db, slug) {
  const id = idOfSlug(slug);
  if (id == null) return undefined;
  const d = shownDoctors(db).find((x) => x.user_id === id);
  return d ? { ...d.row, user_id: d.user_id } : undefined;
}

export function departmentDoctors(db, department_id) {
  return shownDoctors(db).filter((d) => d.department_id === Number(department_id)).map((d) => d.row);
}

function shownServices(db) {
  return cached('services:all', () => {
    const extras = new Map(db.prepare('SELECT service_id, sort_order, featured, image_path, content FROM website_services').all().map((r) => [r.service_id, r]));
    const types = new Map(db.prepare('SELECT id, name FROM service_types').all().map((t) => [t.id, t.name]));
    return db.prepare('SELECT * FROM services WHERE active = 1 ORDER BY id').all()
      .filter((s) => servicePublicState(s) === 'shown')
      .map((s) => {
        const x = extras.get(s.id);
        const extra = jsonObj(x && x.content);
        const nm = serviceNames(s);
        const content = {};
        for (const lang of LANGS) {
          const name = text(nm[lang]);
          const e = extra[lang] || {};
          if (!name && !e.short_desc && !e.body) continue;
          content[lang] = { name, short_desc: text(e.short_desc), body: text(e.body), preparation: text(e.preparation) };
        }
        return {
          service_id: s.id,
          row: {
            id: s.id, slug: slugOf(s.id, nm.en || nm.uz),
            featured: x ? Number(x.featured) || 0 : 0, image_path: x ? text(x.image_path) : '',
            sort_order: x ? Number(x.sort_order) || 0 : 0, content: JSON.stringify(content),
            price: s.price, duration_minutes: s.duration_minutes, department_id: s.department_id,
            type: s.type, type_name: s.type_id != null ? types.get(s.type_id) || null : null,
          },
        };
      })
      .sort((a, b) => a.row.sort_order - b.row.sort_order || a.row.id - b.row.id);
  });
}

export function publishedServices(db) { return shownServices(db).map((s) => s.row); }

// service_id выходит наружу ТОЛЬКО здесь — requests.js по слагу узнаёт
// настоящую услугу для карточки CRM.
export function serviceBySlug(db, slug) {
  const id = idOfSlug(slug);
  if (id == null) return undefined;
  const s = shownServices(db).find((x) => x.service_id === id);
  return s ? { ...s.row, service_id: s.service_id } : undefined;
}

export function departmentServices(db, department_id) {
  return publishedServices(db).filter((s) => Number(s.department_id) === Number(department_id));
}
```

Если `serviceNames(s)` возвращает не `{ru, uz, en}` — посмотреть его код в
`public/js/shared/service-public.js` и привести к объекту по языкам в одном месте (`nm`).
Если таблицы `service_types` нет — заменить `types` на `new Map()`.

- [ ] **Step 5: Тест проходит**

Run: `node --test server/site/content.test.js`
Expected: PASS, 6 тестов.

- [ ] **Step 6: Коммит**

```powershell
git add server/site/content.js server/site/content.test.js
git commit -m "Сайт (WEBSITE_V1), этап 1: содержимое сайта — врачи и услуги из публичных профилей (тот же показ, что у Symptex и партнёров)"
```

---

### Task 5: `/media` — картинки сайта и фото врачей

**Files:**
- Create: `server/site/media.js`, `server/site/media.test.js` (из `$CHILLA`, с правкой)
- Modify: `server/routes/storage.js` — `BUCKETS` + `'website'`

- [ ] **Step 1: Скопировать и прочитать**

```powershell
Copy-Item "$CHILLA\server\site\media.js" server\site\media.js
Copy-Item "$CHILLA\server\site\media.test.js" server\site\media.test.js
```
Прочитать оба. Прочитать в `server/services/api/snapshot.js` функцию `photoFile` —
как из `users.photo_url` получается путь к файлу фото врача.

- [ ] **Step 2: Дописать падающие тесты в `server/site/media.test.js`**

```js
// WEBSITE_V1 (Easy-Med) — фото врача берётся из профиля, но ТОЛЬКО у показанного врача.
test('GET /media/doctor/<id> — фото показанного врача; скрытого — 404', async () => {
  // засеять двух врачей seedDoctor (показан / скрыт), каждому — photo_url и файл
  // в корзине doctor-photos внутри временной папки хранилища (как photoFile его ищет);
  // поднять обработчик mediaRoute(mediaDir, db, { storageDir }) на express-приложении;
  // ожидать 200 и байты файла у показанного, 404 у скрытого и у несуществующего id.
});
```
Тело теста написать по образцу соседних тестов файла (они уже поднимают приложение и
временную папку) — те же помощники, новый засев через `seedDoctor` из `./test-seed.js`
и `UPDATE users SET photo_url = ? WHERE id = ?`.

- [ ] **Step 3: Убедиться, что падает**

Run: `node --test server/site/media.test.js`
Expected: новый тест FAIL (404 у показанного врача), тесты Chilla — PASS.

- [ ] **Step 4: Реализовать**

В `mediaRoute` ДО общей ветки обработать путь `doctor/<id>`:

```js
// WEBSITE_V1 (Easy-Med) — фото врача живёт в профиле (корзина doctor-photos),
// а не в корзине сайта. Отдаём его только врачу, которого показывает сайт
// (doctorBySlug — тот же показ, что у партнёров): скрытый врач по прямой
// ссылке /media/doctor/<id> не находится.
const m = /^doctor\/(\d{1,9})$/.exec(rel);
if (m) {
  const d = doctorBySlug(db, m[1]);
  const file = d && d.photo_path ? photoFile(storageDir, userPhotoUrl(db, d.user_id), d.user_id) : null;
  if (!file) return notFound(req, res);
  res.setHeader('Cache-Control', 'public, max-age=3600');
  return res.sendFile(file);
}
```
где `rel` — уже очищенный относительный путь в обработчике Chilla, `notFound` — его же
ответ 404, `photoFile` — экспортировать из `snapshot.js` (сейчас локальная функция;
добавить `export` без изменения тела), `userPhotoUrl` — `db.prepare('SELECT photo_url
FROM users WHERE id = ?').get(id)?.photo_url`. `storageDir` передать третьим
аргументом `mediaRoute` (в `app.js` — тот же каталог хранилища, что у `/api/storage`).
`mediaDir` сайта — `<storageDir>/website`.

В `server/routes/storage.js`:
```js
const BUCKETS = new Set(['clinic-docs', 'telegram-media', 'patient-photos', 'doctor-photos', LOGO_BUCKET, 'website']);   // WEBSITE_V1 — картинки сайта
```

- [ ] **Step 5: Тесты проходят**

Run: `node --test server/site/media.test.js server/routes/storage.test.js server/services/api/snapshot.test.js`
Expected: PASS (файлы тестов, которых нет, `node --test` пропустит с ошибкой «not found» — тогда запускать только существующие).

- [ ] **Step 6: Коммит**

```powershell
git add server/site/media.js server/site/media.test.js server/routes/storage.js server/services/api/snapshot.js
git commit -m "Сайт (WEBSITE_V1), этап 1: /media — картинки сайта из корзины website и фото показанного врача из профиля"
```

---

### Task 6: Заявка с сайта → карточка CRM по-здешнему

**Files:**
- Create: `server/site/requests.js`, `requests.test.js`, `analytics.js`, `analytics.test.js`, `notify.js`, `notify.test.js` (из `$CHILLA`)

- [ ] **Step 1: Скопировать**

```powershell
foreach ($f in 'requests.js','requests.test.js','analytics.js','analytics.test.js','notify.js','notify.test.js') { Copy-Item "$CHILLA\server\site\$f" "server\site\$f" }
```

- [ ] **Step 2: Перевести засевы тестов на профиль**

В `requests.test.js` и `analytics.test.js` каждое
`INSERT INTO website_doctors (...)` / `INSERT INTO website_services (...)` с
`published`/`slug` заменить на `seedDoctor(db, {...})` / `seedService(db, {...})`
из `./test-seed.js`, а слаги в теле запроса — на слаг из `publishedDoctors(db)` /
`publishedServices(db)` (`content.js`). Ожидаемые `service_id`/`doctor_id` — id из засева.

- [ ] **Step 3: Дописать падающий тест в `requests.test.js`**

```js
// WEBSITE_V1 (Easy-Med) — карточка CRM от сайта выглядит как заведённая обычным путём:
// источник website в source И в sources, первая стадия воронки, номер в формате
// +998…, пациент найден по номеру тем же правилом, что у звонка.
test('заявка на приём → карточка CRM: source/sources = website, первая стадия, номер E.164, пациент по номеру', () => {
  const db = freshDb();   // помощник файла: openDb(':memory:') + migrate
  const pid = Number(db.prepare("INSERT INTO patients (full_name, phone) VALUES ('Пациент', '+998901234567')").run().lastInsertRowid);
  const out = handleRequest(db, { type: 'appointment', full_name: 'Пациент', phone: '90 123 45 67', ts: Date.now() - 10000 }, { ip: '1.2.3.4', ua: 't' });
  const wr = db.prepare('SELECT crm_request_id FROM website_requests WHERE id = ?').get(out.id);
  const crm = db.prepare('SELECT source, sources, status, phone, patient_id FROM crm_requests WHERE id = ?').get(wr.crm_request_id);
  assert.equal(crm.source, 'website');
  assert.deepEqual(JSON.parse(crm.sources), ['website']);
  assert.equal(crm.status, firstStageKey(db) || 'in_process');
  assert.equal(crm.phone, '+998901234567');
  assert.equal(crm.patient_id, pid);
});
```
Импорты в начало файла: `import { firstStageKey } from '../services/crm/contact-window.js';`.
Столбцы `patients` в засеве сверить со схемой (NOT NULL без умолчания).

- [ ] **Step 4: Убедиться, что падает**

Run: `node --test server/site/requests.test.js`
Expected: новый тест FAIL (`sources` null / `phone` не в E.164 / `patient_id` null).

- [ ] **Step 5: Реализовать в `server/site/requests.js`**

Импорты:
```js
import { uzE164 } from '../../public/js/admin/views/crm-phone-match.js';
import { firstStageKey } from '../services/crm/contact-window.js';
import { patientIdForPhone } from '../services/crm/patient-by-phone.js';
```
Вставку карточки заменить на (образец — `server/services/telegram/deeplinks.js:475`):
```js
// WEBSITE_V1 (Easy-Med) — карточка так же, как у Telegram-ссылок и Meta: источник
// в source И в sources (по sources строят фильтры и отчёты), первая стадия
// воронки этой клиники, номер в +998…, пациент по номеру правилом звонка.
const SOURCE_KEY = 'website';
const phoneNorm = uzE164(phoneRaw) || phoneRaw;
const info = db.prepare(`INSERT INTO crm_requests (full_name, phone, source, sources, status, note, patient_id, service_id, scheduled_date)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(fullName, phoneNorm.slice(0, 40), SOURCE_KEY, JSON.stringify([SOURCE_KEY]),
  firstStageKey(db) || 'in_process', (message ? message + ' ' : '') + '[сайт' + (lang ? ', ' + lang : '') + ']',
  patientIdForPhone(db, phoneNorm), svc ? svc.service_id : null, date);
```
Строку `crm_request_services` оставить как в Chilla, сверив столбцы с текущей схемой
(`PRAGMA table_info(crm_request_services)`); если у строки появились обязательные
столбцы — заполнить их так же, как `server/services/api/bookings.js` заполняет свою.

- [ ] **Step 6: Тесты проходят**

Run: `node --test server/site/requests.test.js server/site/analytics.test.js server/site/notify.test.js`
Expected: PASS.

- [ ] **Step 7: Коммит**

```powershell
git add server/site/requests.js server/site/requests.test.js server/site/analytics.js server/site/analytics.test.js server/site/notify.js server/site/notify.test.js
git commit -m "Сайт (WEBSITE_V1), этап 1: заявка с сайта — карточка CRM как у Telegram и Meta (source и sources, первая стадия, +998, пациент по номеру); аналитика и уведомление из Chilla"
```

---

### Task 7: Страницы, SEO и приложение сайта

**Files:**
- Create (из `$CHILLA`): `server/site/seo.js`, `seo.test.js`, `app.js`, `app.test.js`, `security.test.js`, `settings-wiring.test.js`, `server/site/render/*` (все `.js` и `.test.js`)

- [ ] **Step 1: Скопировать**

```powershell
foreach ($f in 'seo.js','seo.test.js','app.js','app.test.js','security.test.js','settings-wiring.test.js') { Copy-Item "$CHILLA\server\site\$f" "server\site\$f" }
Copy-Item "$CHILLA\server\site\render\*" server\site\render\
```

- [ ] **Step 2: Перевести засевы тестов на профиль**

Во всех скопированных `*.test.js` (`Select-String -Path server\site\*.test.js,server\site\render\*.test.js -Pattern 'website_doctors|website_services'`):
врачей и услуги засевать `seedDoctor` / `seedService`; добавки (`featured`, порядок,
описание услуги) — строкой в `website_doctors (user_id, sort_order, featured)` /
`website_services (service_id, featured, content)`; слаги брать из `publishedDoctors` /
`publishedServices`. Ожидания на поля `published`/`slug` этих двух таблиц — удалить
(показ теперь — профиль; это покрыто `content.test.js`).

- [ ] **Step 3: Привязать `mediaRoute` к хранилищу**

В `server/site/app.js` найти `createSiteApp(db, ...)` и место, где вычисляется `mediaDir`.
Сделать: `createSiteApp(db, { storageDir } = {})`, где `storageDir` по умолчанию — тот же
каталог, что использует `server/routes/storage.js` (прочитать там, как он получается от
`DATA_DIR`), `mediaDir = path.join(storageDir, 'website')`, и
`app.get('/media/*rest', mediaRoute(mediaDir, db, { storageDir }))`.

- [ ] **Step 4: Прогнать тесты сайта**

Run: `node --test server/site/ server/site/render/`
Expected: PASS. Разбирать каждое падение: если причина — разница схем (столбец
`doc_settings`, `branches.working_hours`, `departments`), править ПЕРЕНЕСЁННЫЙ код сайта,
не схему проекта. Если `security.test.js` падает на проверке полей — это граница
безопасности: найти, какое поле утекло, и убрать его из `toDoctor`/`toService`, а не из теста.

- [ ] **Step 5: Коммит**

```powershell
git add server/site
git commit -m "Сайт (WEBSITE_V1), этап 1: страницы, SEO и приложение сайта из Chilla; тесты засевают врачей и услуги профилем"
```

---

### Task 8: Контроллер — сайт поднят только при лицензии и «Сайт включён»

**Files:**
- Create: `server/site/controller.js`, `server/site/controller.test.js`
- Modify: `server/index.js`

- [ ] **Step 1: Написать падающий тест**

```js
// WEBSITE_V1 — слушатель сайта: только при модуле лицензии website, при
// settings.enabled === true и SITE_PORT > 0. Включение и выключение — без
// перезапуска сервера (refresh раз в минуту из index.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { siteWanted, createSiteController } from './controller.js';
import { invalidateContentCache } from './content.js';

function fresh(enabled) {
  invalidateContentCache();
  const db = openDb(':memory:'); migrate(db);
  db.prepare('UPDATE website_settings SET settings = ? WHERE id = 1').run(JSON.stringify({ enabled }));
  return db;
}
const yes = () => true, no = () => false;

test('siteWanted: нужен и модуль, и «Сайт включён», и порт', () => {
  assert.equal(siteWanted(fresh(true), { env: {}, hasModule: yes }), 8001);
  assert.equal(siteWanted(fresh(true), { env: { SITE_PORT: '8123' }, hasModule: yes }), 8123);
  assert.equal(siteWanted(fresh(true), { env: {}, hasModule: no }), 0, 'без модуля лицензии');
  assert.equal(siteWanted(fresh(false), { env: {}, hasModule: yes }), 0, 'выключен в настройках');
  assert.equal(siteWanted(fresh(true), { env: { SITE_PORT: '0' }, hasModule: yes }), 0, 'аварийный выключатель');
});

test('контроллер поднимает, закрывает и снова поднимает слушатель без перезапуска', () => {
  const db = fresh(true);
  let licensed = true;
  const opened = [];
  const fake = () => { const s = { closed: false, close() { s.closed = true; }, on() { return s; } }; opened.push(s); return s; };
  const c = createSiteController(db, { env: {}, hasModule: () => licensed, listen: fake });
  assert.equal(c.refresh(), 8001); assert.equal(opened.length, 1);
  assert.equal(c.refresh(), 8001); assert.equal(opened.length, 1, 'повторный refresh не открывает второй');
  licensed = false;
  assert.equal(c.refresh(), 0); assert.equal(opened[0].closed, true, 'лицензия ушла — сайт закрыт');
  licensed = true;
  assert.equal(c.refresh(), 8001); assert.equal(opened.length, 2);
  db.prepare('UPDATE website_settings SET settings = ? WHERE id = 1').run(JSON.stringify({ enabled: false }));
  assert.equal(c.refresh(), 0); assert.equal(opened[1].closed, true, '«Сайт включён» снят — закрыт');
});
```

- [ ] **Step 2: Убедиться, что падает**

Run: `node --test server/site/controller.test.js`
Expected: FAIL — `Cannot find module './controller.js'`.

- [ ] **Step 3: Реализовать `server/site/controller.js`**

```js
// WEBSITE_V1 — когда работает публичный сайт.
//
// В Chilla сайт поднимался при каждом старте (выключался только SITE_PORT=0).
// Здесь (спека 2026-11-23, §3) — только при ВСЕХ трёх условиях:
//   1) в лицензии есть модуль website (новый платный модуль);
//   2) администратор включил «Сайт включён» (website_settings.enabled);
//   3) SITE_PORT не 0 (аварийный выключатель остался).
// Иначе обновление клиники само открывало бы новый порт в её сети.
//
// refresh() сравнивает желаемый порт с текущим и открывает или закрывает
// слушатель; index.js зовёт его раз в минуту — так и выдача модуля через
// check-in, и сохранение настроек действуют без перезапуска сервера.
import { createSiteApp } from './app.js';
import { getSettings, invalidateContentCache } from './content.js';
import { controlState } from '../services/control/state.js';
import { getDataDir } from '../services/control/config.js';

const licensedWebsite = (db) => { try { return controlState(db, getDataDir()).has('website'); } catch { return false; } };

export function siteWanted(db, { env = process.env, hasModule } = {}) {
  const port = Number(env.SITE_PORT ?? 8001);
  if (!(Number.isInteger(port) && port > 0)) return 0;
  if (!(hasModule ? hasModule() : licensedWebsite(db))) return 0;
  invalidateContentCache();   // настройку читаем свежей, а не из 30-секундного кэша
  return getSettings(db).enabled === true ? port : 0;
}

export function createSiteController(db, { env = process.env, hasModule, listen, appOptions = {}, log = console } = {}) {
  const open = listen || ((app, p) => app.listen(p, '0.0.0.0'));
  let server = null;
  let port = 0;
  const stop = () => { if (server) { try { server.close(); } catch { /* уже закрыт */ } } server = null; port = 0; };
  return {
    refresh() {
      let want = 0;
      try { want = siteWanted(db, { env, hasModule }); } catch (e) { log.warn('[website]', e.message); }
      if (want === port) return port;
      stop();
      if (want) {
        server = open(createSiteApp(db, appOptions), want);
        port = want;
        server.on('listening', () => log.log(`  Public website:  http://localhost:${want}`));
        server.on('error', (err) => {
          log.error(err && err.code === 'EADDRINUSE'
            ? `Public website not started: port ${want} is already in use.`
            : `Public website error: ${err && err.message}`);
          server = null; port = 0;
        });
      }
      return port;
    },
    stop,
    get port() { return port; },
  };
}
```

- [ ] **Step 4: Тест проходит**

Run: `node --test server/site/controller.test.js`
Expected: PASS, 2 теста.

- [ ] **Step 5: Подключить в `server/index.js`**

Импорты рядом с остальными (после строки `import { applyPendingTestDataWipe } ...`):
```js
import { createSiteController } from './site/controller.js';   // WEBSITE_V1 — публичный сайт на втором порту
import { pruneWebsiteAnalytics } from './site/analytics.js';    // WEBSITE_V1 — чистка сырых просмотров
```
Рядом с `setInterval(() => pruneOpsEvents(db), 3600 * 1000).unref();`:
```js
// WEBSITE_V1 — сырые просмотры сайта старше срока хранения; свои try/catch, как соседи.
const pruneWebsite = () => { try { pruneWebsiteAnalytics(db); } catch (e) { console.warn('[website-analytics-prune]', e.message); } };
pruneWebsite();
setInterval(pruneWebsite, 3600 * 1000).unref();
```
Сразу после вызова `createApp(db, { dataDir: DATA_DIR }).listen(PORT, ...)` (строка ~341,
после закрытия его колбэка):
```js
// WEBSITE_V1 — сайт поднимается, только если есть модуль лицензии и он включён
// в настройках (server/site/controller.js). Раз в минуту — пересчёт: выдача
// модуля через check-in и «Сайт включён» действуют без перезапуска.
const website = createSiteController(db, { appOptions: { storageDir: path.join(DATA_DIR, 'storage') } });
website.refresh();
setInterval(() => website.refresh(), 60 * 1000).unref();
```
`storageDir` сверить с тем, как `createApp`/`server/routes/storage.js` вычисляют
каталог хранилища от `DATA_DIR`, и передать ровно его.

- [ ] **Step 6: Проверить, что сервер стартует и сайт НЕ поднят без лицензии**

```powershell
$env:PORT='8099'; $env:EASYMED_DATA_DIR="$env:TEMP\em-website-boot"; $p = Start-Process node 'server/index.js' -PassThru -NoNewWindow -RedirectStandardOutput "$env:TEMP\em-website-boot.log"
```
Подождать, пока `Get-NetTCPConnection -LocalPort 8099 -State Listen` вернёт строку,
затем: `Get-NetTCPConnection -LocalPort 8001 -State Listen -ErrorAction SilentlyContinue` —
Expected: пусто. `Stop-Process $p.Id`. Удалить `$env:TEMP\em-website-boot*`.
(Переменные `PORT` и `EASYMED_DATA_DIR` сверить с `server/index.js`.)

- [ ] **Step 7: Коммит**

```powershell
git add server/site/controller.js server/site/controller.test.js server/index.js
git commit -m "Сайт (WEBSITE_V1), этап 1: сайт поднимается только при модуле лицензии website и «Сайт включён», без перезапуска; чистка аналитики раз в час"
```

---

### Task 9: Просмотр сайта владельцем на копии базы

Владелец смотрит каждый этап на localhost, но модуль `website` ещё не выдаётся
(контрольная плоскость не знает его — этап 5). Обхода лицензии в программе НЕТ:
вместо него — скрипт разработчика, который поднимает ТОЛЬКО приложение сайта на
КОПИИ базы. В пакет выпуска `scripts/` не входит (проверить в Step 3).

**Files:**
- Create: `scripts/site-preview.mjs`

- [ ] **Step 1: Написать скрипт**

```js
// WEBSITE_V1 — просмотр сайта разработчиком: node scripts/site-preview.mjs <путь к копии easymed.db> [порт]
//
// Поднимает ТОЛЬКО приложение сайта (server/site/app.js) на копии базы — без
// ЕРП, ботов и лицензии. Это не обход лицензии: в клинике этого скрипта нет
// (scripts/ не входит в пакет выпуска), а настоящий сервер поднимает сайт лишь
// через server/site/controller.js. Копия, а не рабочая база: сайт пишет заявки,
// карточки CRM и аналитику.
import path from 'node:path';
import { openDb } from '../server/db/connection.js';
import { migrate } from '../server/db/migrate.js';
import { createSiteApp } from '../server/site/app.js';

const [file, portArg] = process.argv.slice(2);
if (!file || /[\\/]data[\\/]easymed\.db$/i.test(path.resolve(file))) {
  console.error('Usage: node scripts/site-preview.mjs <COPY of easymed.db> [port]  (never the live data/easymed.db)');
  process.exit(2);
}
const db = openDb(path.resolve(file));
migrate(db);
const port = Number(portArg) || 8001;
createSiteApp(db, { storageDir: path.join(path.dirname(path.resolve(file)), 'storage') })
  .listen(port, '127.0.0.1', () => console.log(`Site preview: http://localhost:${port}/`));
```

- [ ] **Step 2: Проверить на пустой копии**

```powershell
$tmp = "$env:TEMP\em-site-preview"; New-Item -ItemType Directory -Force $tmp | Out-Null
node -e "import('./server/db/connection.js').then(async ({openDb}) => { const {migrate} = await import('./server/db/migrate.js'); const db = openDb(process.argv[1]); migrate(db); db.close(); })" "$tmp\easymed.db"
$p = Start-Process node "scripts/site-preview.mjs","$tmp\easymed.db","8011" -PassThru -NoNewWindow
```
Когда порт 8011 слушает: `(Invoke-WebRequest http://localhost:8011/uz/ -UseBasicParsing).StatusCode` —
Expected: 200. `Stop-Process $p.Id`.

- [ ] **Step 3: Убедиться, что скрипт не попадает в пакет выпуска, а сайт — попадёт позже**

Run: `Select-String -Path scripts\build-bundle.mjs -Pattern "scripts|server/|public/" | Select-Object LineNumber, Line`
Expected: `scripts/` в разрешённом списке нет. (Включение `server/site/**` и `public/site/**` — этап 5;
здесь только записать в отчёт, покрывает ли их список уже сейчас.)

- [ ] **Step 4: Коммит**

```powershell
git add scripts/site-preview.mjs
git commit -m "Сайт (WEBSITE_V1), этап 1: просмотр сайта разработчиком на копии базы (без лицензии и ЕРП; в клинику не уходит)"
```

---

### Task 10: Полный прогон и показ владельцу

- [ ] **Step 1: Полный набор**

Run: `npm test` (в `em-website`, не одновременно с записью файлов).
Expected: все проходят, кроме известных CRLF-падений разбора исходников (список в памяти
`crlf-source-parsing-test-failures`) и сетевого флейка «bad port». Любое другое падение — разобрать.
Не считать прогон зелёным по одному запуску, если есть сетевые ошибки — перезапустить.

- [ ] **Step 2: Копия базы разработки для просмотра**

```powershell
$tmp = "$env:TEMP\em-site-preview-dev"; New-Item -ItemType Directory -Force $tmp | Out-Null
# горячая копия через API SQLite — сервер разработки может работать
node -e "import('better-sqlite3').then(({default: D}) => new D(process.argv[1], {readonly:true}).backup(process.argv[2]).then(() => console.log('ok')))" "..\easymed.local\data\easymed.db" "$tmp\easymed.db"
robocopy "..\easymed.local\data\storage\doctor-photos" "$tmp\storage\doctor-photos" /E /NFL /NDL /NJH /NJS /NP | Out-Null
node scripts/site-preview.mjs "$tmp\easymed.db" 8001
```
(в фоне). Открыть `http://localhost:8001/uz/`, `/ru/doctors`, `/ru/services`, форму записи.
Копия содержит данные пациентов — она живёт только в `%TEMP%`, после показа удалить папку.

- [ ] **Step 3: Отчёт владельцу и СТОП**

Сообщить: что сделано, итог `npm test`, адрес просмотра, какие врачи и услуги видны (это те,
у кого включён показ в профиле), что сайт в настоящем сервере НЕ поднимается, пока нет модуля
`website`. Ждать, пока владелец посмотрит. Не пушить. Этап 2 — отдельным планом.
