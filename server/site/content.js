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
import fs from 'node:fs';
import { LANGS, DEFAULT_LANG } from './i18n.js';
import { clinicLogoUrl } from './logo.js';
import { publicDoctors, profileEntries, photoFile } from '../services/api/snapshot.js';
import { readLanguages, shownPracticeSince, experienceYears } from '../../public/js/shared/doctor-public.js';
import { servicePublicState, serviceNames } from '../../public/js/shared/service-public.js';

const TTL_MS = 30_000;
let cache = new Map();

// WEBSITE_PREVIEW_V1 — черновик редактора на время одного рендера (site/preview.js). Рендеры
// синхронны, поэтому черновик не может попасть в страницу посетителя: между подменой и
// возвратом другой запрос не выполняется. Кэш на это время — свой, пустой.
//   settings — объект настроек вместо сохранённого;
//   row      — { kind, row }: одна открытая в редакторе карточка содержимого.
let draft = null;
export function withDraft(d, fn) {
  const prevCache = cache;
  const prevDraft = draft;
  cache = new Map();
  draft = d || null;
  try { return fn(); } finally { cache = prevCache; draft = prevDraft; }
}
const DRAFT_KEY = { services: 'service_id', departments: 'department_id', testimonials: 'id', faq: 'id', posts: 'id' };
const DRAFT_SLUG = 'draft';
const draftRow = (kind) => (draft && draft.row && draft.row.kind === kind ? draft.row.row : null);
// Черновик встаёт на место своей строки; новый или неопубликованный — первым в списке.
function withDraftRow(kind, rows) {
  const d = draftRow(kind);
  if (!d) return rows;
  const key = DRAFT_KEY[kind];
  const old = rows.find((r) => d[key] != null && r[key] === d[key]);
  const merged = { id: 0, sort_order: 0, published_at: null, image_path: '', cover_path: '', author_name: '', rating: 5, ...old };
  for (const k of ['author_name', 'rating', 'image_path', 'cover_path', 'department_id', 'service_id']) if (d[k] !== undefined) merged[k] = d[k];
  merged.slug = String(d.slug || merged.slug || DRAFT_SLUG);
  merged.content = JSON.stringify(d.content || {});
  return old ? rows.map((r) => (r === old ? merged : r)) : [merged, ...rows];
}

export function invalidateContentCache() {
  cache = new Map();
}

// WEBSITE_V1 — каталог хранилища (тот же, что у /api/storage), нужен, чтобы
// проверить, что файл фото врача и правда лежит на диске: иначе страница
// получила бы photo_path и показала сломанную картинку вместо аватара с
// инициалами. Не настроен (тесты без диска) — прежнее поведение: photo_url
// непуст — photo_path есть. Смена каталога сбрасывает кэш врачей.
// Папка хранилища — глобальна для модуля: одно приложение сайта на процесс (побеждает последний configureContent).
let storageDir = null;
export function configureContent({ storageDir: dir } = {}) {
  storageDir = dir || null;
  invalidateContentCache();
}
export const contentConfigured = () => storageDir !== null;   // WEBSITE_PREVIEW_V1 — сайт выключен: папку задаёт предпросмотр

function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.val;
  const val = fn();
  // undefined (промах по слагу — departmentBySlug/postBySlug) НЕ кладём в кэш:
  // эти ключи контролирует атакующий через URL, и при кэшировании промахов он
  // мог бы бесконечно раздувать Map случайными слагами — неограниченный по
  // памяти DoS. Врачи и услуги кэшируются целиком под фиксированными ключами
  // 'doctors:all' / 'services:all', а слаг ищется уже в этом списке.
  if (val !== undefined) cache.set(key, { exp: Date.now() + TTL_MS, val });
  return val;
}

export function getSettings(db) {
  return cached('settings', () => {
    let s = {};
    try {
      s = JSON.parse(db.prepare('SELECT settings FROM website_settings WHERE id=1').get()?.settings || '{}');
    } catch {}
    // WEBSITE_PREVIEW_V1 — черновик вместо сохранённого; счётчики в предпросмотре молчат.
    if (draft && draft.settings) s = draft.settings;
    if (draft && draft.noAnalytics) s = { ...s, analytics: {} };
    const doc = db.prepare('SELECT clinic_name, address, phone, email FROM doc_settings WHERE id=1').get() || {};
    return {
      default_lang: 'uz',
      langs: ['uz', 'ru', 'en'],
      hero: {},
      stats: [],
      why_us: [],
      seo: {},
      social: {},
      notify: {},
      legal: {},
      // WEBSITE_V1 (задача W3-2) — retention_days для pruneWebsiteAnalytics()
      // читает settings.analytics.retention_days; дефолт объекта здесь нужен,
      // чтобы обращение к settings.analytics?.retention_days было безопасно
      // даже на установке, где раздел ещё ни разу не сохранялся из админки.
      analytics: {},
      ...s,
      clinic_name: doc.clinic_name || '',
      logo_url: clinicLogoUrl(db, storageDir),   // SITE_CLINIC_LOGO_V1 — из «Компании», не из настроек сайта
      contact: { phone: doc.phone || '', address: doc.address || '', email: doc.email || '', ...(s.contact || {}) },
    };
  });
}

// W2 — «Язык по умолчанию» и «включённые языки» из settings.default_lang/
// settings.langs (пишет админка, задача website-w1): обе функции терпимы к
// мусору в JSON — невалидные значения откатываются к дефолтам, а не роняют
// сайт. enabledLangsFromSettings/defaultLangFromSettings принимают уже
// прочитанный settings (используются внутри page(), где он и так под рукой),
// enabledLangs/defaultLang — обёртки для мест, где под рукой только db.
export function enabledLangsFromSettings(settings) {
  const arr = Array.isArray(settings?.langs) ? settings.langs.filter((l) => LANGS.includes(l)) : [];
  return arr.length ? arr : LANGS.slice();
}

// W2 (fix-wave 2) — website_settings_save отвергает default_lang, которого
// нет в langs (см. website.js), но settings — read-modify-write JSON без
// поперечной проверки на уровне схемы: два «Основное»-сохранения подряд
// (или сохранение старой копией формы, открытой до чужого изменения langs)
// могут в принципе положить в БД {default_lang:'uz', langs:['ru','en']}
// в обход RPC-валидатора. Без этой защиты такая комбинация давала
// бесконечный редирект: GET / -> /uz/ -> langRouter видит uz выключенным ->
// redirect на langUrl(defaultLang(db), ...) -> снова /uz/, потому что
// defaultLang вернул бы отключённый uz. Поэтому здесь — вторая линия
// обороны: если сохранённый default_lang не входит в enabled, откатываемся
// на ПЕРВЫЙ включённый язык, а не на константу DEFAULT_LANG (она попадает
// в ответ только если сама входит в enabled — тогда откат на неё и на
// enabled[0] совпадают).
export function defaultLangFromSettings(settings) {
  const enabled = enabledLangsFromSettings(settings);
  const dl = LANGS.includes(settings?.default_lang) ? settings.default_lang : DEFAULT_LANG;
  return enabled.includes(dl) ? dl : enabled[0];
}

export function enabledLangs(db) {
  return enabledLangsFromSettings(getSettings(db));
}

export function defaultLang(db) {
  return defaultLangFromSettings(getSettings(db));
}

const text = (v) => String(v == null ? '' : v).trim();
const jsonObj = (s) => { try { const v = JSON.parse(s || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; } };

const nonEmpty = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v));

/** Латинская часть слага: только [a-z0-9-]; пусто — слаг из одного id. */
export function slugTail(name) {
  return text(name).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[ʻʼ‘’'`]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}
const slugOf = (id, latinName) => { const t = slugTail(latinName); return t ? `${id}-${t}` : String(id); };
/** Слаг → id: решает ведущее число, хвост — для людей и поисковиков. Смена имени ссылку не ломает. */
const idOfSlug = (slug) => { const m = /^([1-9]\d{0,8})(?:-[a-z0-9-]*)?$/.exec(String(slug || '')); return m ? Number(m[1]) : null; };

function educationText(raw, lang) {
  return profileEntries(raw, { range: true }).map((e) => {
    const name = e.name[lang] || e.name.ru || e.name.uz || e.name.en;
    const years = [e.year_from, e.year_to].filter((y) => y != null).join('–');
    return [years, name].filter(Boolean).join(' ');
  }).filter(Boolean).join('\n');
}

function hasPhoto(u) {
  if (!u.photo_url) return false;
  if (!storageDir) return true;
  const file = photoFile(storageDir, u.photo_url, u.id);
  try { return !!file && fs.statSync(file).isFile(); } catch { return false; }
}

function toDoctor(u, specs, extra, now) {
  const content = {};
  for (const lang of LANGS) {
    const name = text(u['full_name_' + lang]) || (lang === 'ru' ? text(u.full_name) : '');
    if (!name) continue;
    // для en берётся русское название специальности намеренно: в user_specialties нет name_en
    const sp = specs.map((s) => text(lang === 'uz' ? s.name_uz : s.name_ru) || text(s.name_ru)).find(Boolean) || '';
    // только непустые поля: pickContent копирует и пустые строки, затирая запасной язык
    content[lang] = nonEmpty({
      name, specialty: sp, bio: text(u['bio_' + lang]),
      education: educationText(u.education_entries, lang), focus: text(u['academic_title_' + lang]),
    });
  }
  const since = shownPracticeSince(u, now);
  return {
    id: u.id,
    slug: slugOf(u.id, text(u.full_name_en) || text(u.full_name_uz)),
    // раздаёт media.js только для показанного врача; нет файла на диске — нет и пути (аватар)
    photo_path: hasPhoto(u) ? `doctor/${u.id}` : '',
    experience_years: since == null ? null : experienceYears(since, now),
    langs_spoken: readLanguages(u.languages).join(','),
    sort_order: extra ? Number(extra.sort_order) || 0 : 0,
    featured: extra ? Number(extra.featured) || 0 : 0,
    content: JSON.stringify(content),
  };
}

// WEBSITE_V1, этап 2 — ПРАВИЛО ПОКАЗА В ОДНОМ МЕСТЕ. Редактор «Веб-сайт»
// (rpc/website-content.js) ставит метку «На сайте» / «Скрыт» по ЭТИМ же
// функциям: свою копию правила там не держим, иначе метка в редакторе и сайт
// однажды разошлись бы (врач «На сайте» в редакторе, но не на сайте, или наоборот).
// Без кэша — редактор хочет видеть правку профиля сразу.
export const siteDoctorProfiles = (db) => publicDoctors(db).filter((u) => Number(u.is_active) === 1);
export const siteServiceRows = (db) => db.prepare('SELECT * FROM services WHERE active = 1 ORDER BY id').all()
  .filter((s) => servicePublicState(s) === 'shown');

function shownDoctors(db) {
  return cached('doctors:all', () => {
    const now = new Date();
    const specs = db.prepare('SELECT user_id, name_ru, name_uz FROM user_specialties ORDER BY is_primary DESC, id').all();
    const extras = new Map(db.prepare('SELECT user_id, sort_order, featured FROM website_doctors').all().map((r) => [r.user_id, r]));
    return siteDoctorProfiles(db).map((u) => ({
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
    const extras = new Map(withDraftRow('services', db.prepare('SELECT service_id, sort_order, featured, image_path, content FROM website_services').all()).map((r) => [r.service_id, r]));
    const types = new Map(db.prepare('SELECT id, name FROM service_types').all().map((t) => [t.id, t.name]));
    return siteServiceRows(db)
      .map((s) => {
        const x = extras.get(s.id);
        const extra = jsonObj(x && x.content);
        const nm = serviceNames(s);
        const content = {};
        for (const lang of LANGS) {
          const name = text(nm[lang]);
          const e = extra[lang] || {};
          if (!name && !e.short_desc && !e.body) continue;
          content[lang] = nonEmpty({ name, short_desc: text(e.short_desc), body: text(e.body), preparation: text(e.preparation) });
        }
        return {
          service_id: s.id,
          row: {
            id: s.id, slug: slugOf(s.id, text(nm.en) || text(nm.uz)),
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

export function publishedDepartments(db) {
  return cached('departments', () => withDraftRow('departments', db.prepare(`
    SELECT id, slug, image_path, sort_order, content, department_id
      FROM website_departments WHERE published = 1
     ORDER BY sort_order, id`).all()));
}

export function departmentBySlug(db, slug) {
  if (draftRow('departments')) { const r = publishedDepartments(db).find((x) => x.slug === slug); if (r) return r; }   // WEBSITE_PREVIEW_V1
  return cached(`department:${slug}`, () => db.prepare(`
    SELECT id, slug, image_path, sort_order, content, department_id
      FROM website_departments WHERE published = 1 AND slug = ?`).get(slug));
}

export function publishedTestimonials(db) {
  return cached('testimonials', () => withDraftRow('testimonials', db.prepare(`
    SELECT id, sort_order, author_name, rating, content
      FROM website_testimonials WHERE published = 1
     ORDER BY sort_order, id`).all()));
}

export function publishedFaq(db) {
  return cached('faq', () => withDraftRow('faq', db.prepare(`
    SELECT id, sort_order, content
      FROM website_faq WHERE published = 1
     ORDER BY sort_order, id`).all()));
}

// Новости (W4) — единственный оверлей с собственным слагом, но без fk на
// ЕРП: активность врача/услуги здесь проверять нечего, есть только
// published. Сортировка — published_at DESC (свежее выше), id тай-брейком
// для одинаковой секунды; LIMIT 20 — тот же приём, что и у DOCTORS_LIMIT на
// главной (home.js): лента не должна расти бесконечно на одной странице.
export function publishedPosts(db) {
  return cached('posts', () => withDraftRow('posts', db.prepare(`
    SELECT id, slug, cover_path, published_at, content
      FROM website_posts
     WHERE published = 1
     ORDER BY published_at DESC, id DESC
     LIMIT 20`).all()));
}

export function postBySlug(db, slug) {
  if (draftRow('posts')) { const r = publishedPosts(db).find((x) => x.slug === slug); if (r) return r; }   // WEBSITE_PREVIEW_V1
  return cached(`post:${slug}`, () => db.prepare(`
    SELECT id, slug, cover_path, published_at, content
      FROM website_posts
     WHERE published = 1 AND slug = ?`).get(slug));
}

// Часы работы клиники — первый активный филиал (branches.active=1), по id.
// Возвращает null, если активных филиалов нет вообще; иначе {is_24_7, hours},
// где hours — распарсенный JSON рабочего времени или null, если он не
// распарсился/оказался не объектом (мусор в БД не должен ронять страницу —
// вызывающий код (static-pages.js) трактует hours===null как «нечего рисовать»).
export function clinicHours(db) {
  return cached('clinic-hours', () => {
    const row = db.prepare(`
      SELECT working_hours, is_24_7 FROM branches
       WHERE active = 1 ORDER BY id LIMIT 1`).get();
    if (!row) return null;
    if (Number(row.is_24_7) === 1) return { is_24_7: true, hours: null };
    let hours = null;
    try {
      const parsed = JSON.parse(row.working_hours || '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) hours = parsed;
    } catch {}
    return { is_24_7: false, hours };
  });
}
