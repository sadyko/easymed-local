// WEBSITE_V1, этап 2 — содержимое публичного сайта из редактора «Веб-сайт».
//
// Перенос из Chilla (rpc/website-content.js). Отделения, отзывы, FAQ и новости —
// как в Chilla: свои строки со своей отметкой «Опубликовать».
//
// ВРАЧИ И УСЛУГИ — ДРУГИЕ (решение владельца 2026-11-23, «Reuse existing
// profiles»; спека §4). На сайт их выводит тот же показ, что для Symptex и
// партнёров: «Публичный профиль» врача и флаг услуги «показывать». Поэтому
// здесь у них нет ни публикации, ни слага: website_doctors / website_services
// хранят только ДОБАВКИ сайта (порядок, «на главной», у услуги — фото и
// описание по языкам). Метка «На сайте» / «Скрыт» считается ТЕМИ ЖЕ функциями,
// что у самого сайта (site/content.js siteDoctorProfiles / siteServiceRows), а
// добавки скрытому врачу сохранить можно, но видимым они его не делают: сайт
// читает добавки только у тех, кого уже пропустило правило показа.
//
// Ворота — rpc/website.js requireWebsite: модуль лицензии `website` (402),
// затем строка прав «Веб-сайт» (commerce_website: просмотр / изменение).
//
// Имена таблиц и столбцов в SQL ниже — только из KIND_CONFIG и констант этого
// файла; из тела запроса в SQL попадают лишь значения (bound-параметры).
import { invalidateContentCache, siteDoctorProfiles, siteServiceRows } from '../../site/content.js';
import { doctorPublicState } from '../../../public/js/shared/doctor-public.js';
import { servicePublicState } from '../../../public/js/shared/service-public.js';
import { makeSlug } from './website-slug.js';
import { RpcError, requireWebsite, hasWebsiteModule } from './website.js';

export { RpcError };

const LANGS = ['uz', 'ru', 'en'];
const SLUG_RE = /^[a-z0-9-]{2,80}$/;

// -----------------------------------------------------------------------
// Виды содержимого. doctors / services — «добавки» (extras: true) со своим
// путём ниже; остальные — Chilla как есть.

function activeDepartmentCheck(db, id) {
  const d = db.prepare('SELECT id, active FROM departments WHERE id = ?').get(id);
  if (!d) return null;
  return d.active ? d : false;
}

const KIND_CONFIG = {
  doctors: { table: 'website_doctors', fkCol: 'user_id', extras: true },
  services: { table: 'website_services', fkCol: 'service_id', extras: true },
  departments: {
    table: 'website_departments',
    fkCol: 'department_id',
    fkCheck: activeDepartmentCheck,
    scalars: ['image_path', 'sort_order'],
    hasUpdatedAt: true,
  },
  testimonials: {
    table: 'website_testimonials',
    fkCol: null,
    scalars: ['author_name', 'rating', 'sort_order'],
    hasUpdatedAt: false,
  },
  faq: {
    table: 'website_faq',
    fkCol: null,
    scalars: ['sort_order'],
    hasUpdatedAt: true,
  },
  // Новости — без внешнего ключа, но со СВОИМ слагом (website_posts.slug
  // UNIQUE NOT NULL); порядок — по published_at, sort_order в таблице нет.
  posts: {
    table: 'website_posts',
    fkCol: null,
    scalars: ['cover_path'],
    hasUpdatedAt: true,
    hasSlug: true,
  },
};

function kindConfig(kind) {
  const cfg = Object.prototype.hasOwnProperty.call(KIND_CONFIG, kind) ? KIND_CONFIG[kind] : null;
  if (!cfg) throw new RpcError('Неизвестный раздел содержимого сайта.', 400);
  return cfg;
}

const NO_PUBLISH = {
  doctors: 'Врач показывается на сайте по своему «Публичному профилю» — включите его в профиле врача.',
  services: 'Услуга показывается на сайте по флагу «Показывать на сайте и партнёрам» в «Услугах» — отдельной публикации у сайта нет.',
};

// -----------------------------------------------------------------------
// website_pick_lists — отделения клиники для вкладки «Отделения». Врачей и
// услуги экран берёт из website_content_list (там же их метка показа), поэтому
// в отличие от Chilla здесь их нет.
export function websitePickLists(db, _args, user, { hasModule = hasWebsiteModule } = {}) {
  requireWebsite(db, user, 'view', hasModule);
  const departments = db.prepare(`
    SELECT id AS department_id, name
      FROM departments
     WHERE active = 1
     ORDER BY name`).all();
  return { departments };
}

// -----------------------------------------------------------------------
// Добавки врачей и услуг.

const parseObj = (s) => { try { const v = JSON.parse(s || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; } };

function doctorRows(db) {
  // shown — правило самого сайта; state — почему скрыт (подсказка экрана:
  // 'off' — не включён «Публичный профиль», 'branch_hidden' — здание скрыто).
  const shown = new Set(siteDoctorProfiles(db).map((u) => u.id));
  const branches = new Map(db.prepare('SELECT id, active, show_public FROM branches').all().map((b) => [Number(b.id), b]));
  const specs = new Map();
  for (const s of db.prepare('SELECT user_id, name_ru FROM user_specialties ORDER BY is_primary DESC, id').all()) {
    if (!specs.has(s.user_id) && s.name_ru) specs.set(s.user_id, s.name_ru);
  }
  const extras = new Map(db.prepare('SELECT user_id, sort_order, featured FROM website_doctors').all().map((r) => [r.user_id, r]));
  return db.prepare('SELECT * FROM users WHERE is_doctor = 1 AND is_active = 1 ORDER BY id').all().map((u) => {
    const x = extras.get(u.id);
    const isShown = shown.has(u.id);
    return {
      id: u.id,
      user_id: u.id,
      full_name: String(u.full_name_ru || u.full_name || '').trim(),
      specialty: specs.get(u.id) || '',
      photo_url: u.photo_url || '',
      shown: isShown,
      state: isShown ? 'shown' : doctorPublicState(u, branches),
      featured: x ? Number(x.featured) || 0 : 0,
      sort_order: x ? Number(x.sort_order) || 0 : 0,
      has_extras: !!x,
    };
  }).sort(byShownThenOrder);
}

function serviceRows(db) {
  const shown = new Set(siteServiceRows(db).map((s) => s.id));
  const extras = new Map(db.prepare('SELECT service_id, sort_order, featured, image_path, content FROM website_services').all().map((r) => [r.service_id, r]));
  return db.prepare('SELECT * FROM services WHERE active = 1 ORDER BY id').all().map((s) => {
    const x = extras.get(s.id);
    const isShown = shown.has(s.id);
    return {
      id: s.id,
      service_id: s.id,
      name: s.name || '', name_uz: s.name_uz || '', name_en: s.name_en || '',
      price: s.price, department_id: s.department_id, type: s.type,
      shown: isShown,
      // 'off' — флаг показа снят; 'no_uz' — нет названия на узбекском
      state: isShown ? 'shown' : servicePublicState(s),
      featured: x ? Number(x.featured) || 0 : 0,
      sort_order: x ? Number(x.sort_order) || 0 : 0,
      image_path: x ? String(x.image_path || '') : '',
      content: parseObj(x && x.content),
      has_extras: !!x,
    };
  }).sort(byShownThenOrder);
}

// Показанные — первыми и в порядке сайта (sort_order, id); скрытые — за ними.
function byShownThenOrder(a, b) {
  return (Number(b.shown) - Number(a.shown)) || (a.sort_order - b.sort_order) || (a.id - b.id);
}

function extrasTarget(db, kind, rawId) {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new RpcError(kind === 'doctors' ? 'Не выбран врач.' : 'Не выбрана услуга.', 400);
  }
  const row = kind === 'doctors'
    ? db.prepare('SELECT id, is_active AS active FROM users WHERE id = ? AND is_doctor = 1').get(id)
    : db.prepare('SELECT id, active FROM services WHERE id = ?').get(id);
  if (!row) throw new RpcError(kind === 'doctors' ? 'Врач не найден.' : 'Услуга не найдена.', 400);
  if (!Number(row.active)) throw new RpcError(kind === 'doctors' ? 'Врач неактивен.' : 'Услуга отключена в прайсе.', 400);
  return id;
}

// Сохраняет только присланные поля: не присланное (undefined) не трогается,
// как и в Chilla (иначе «На главной» стирал бы описание услуги).
function saveExtras(db, kind, cfg, row) {
  const id = extrasTarget(db, kind, row[cfg.fkCol] ?? row.id);
  const fields = {};
  if (row.featured !== undefined) fields.featured = row.featured ? 1 : 0;
  if (row.sort_order !== undefined) {
    const so = Number(row.sort_order);
    fields.sort_order = Number.isFinite(so) ? Math.trunc(so) : 0;
  }
  if (kind === 'services') {
    if (row.image_path !== undefined) fields.image_path = coerceStringScalar('image_path', row.image_path);
    if (row.content !== undefined) fields.content = JSON.stringify(sanitizeContent(row.content));
  }
  const cols = Object.keys(fields);
  db.transaction(() => {
    db.prepare(`INSERT INTO ${cfg.table} (${cfg.fkCol}) VALUES (?) ON CONFLICT(${cfg.fkCol}) DO NOTHING`).run(id);
    if (cols.length) {
      db.prepare(`UPDATE ${cfg.table} SET ${cols.map((c) => `${c} = @${c}`).join(', ')},
                         updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
                   WHERE ${cfg.fkCol} = @id`).run({ ...fields, id });
    }
  })();
  return id;
}

// -----------------------------------------------------------------------
// website_content_list — все строки вида; content уже распарсен.
export function websiteContentList(db, args, user, { hasModule = hasWebsiteModule } = {}) {
  requireWebsite(db, user, 'view', hasModule);
  const kind = (args || {}).kind;
  const cfg = kindConfig(kind);
  if (kind === 'doctors') return { rows: doctorRows(db) };
  if (kind === 'services') return { rows: serviceRows(db) };
  // Новости — по дате выхода, черновики (published_at IS NULL) в конце: без
  // этого условия SQLite кладёт NULL раньше любого значения даже в DESC.
  const order = kind === 'posts'
    ? '(published_at IS NULL), published_at DESC, id DESC'
    : 'sort_order, id';
  const rows = db.prepare(`SELECT * FROM ${cfg.table} ORDER BY ${order}`).all();
  for (const row of rows) row.content = parseObj(row.content);
  return { rows };
}

// -----------------------------------------------------------------------
// content — ввод администратора, но форма проверяется жёстко: только uz/ru/en,
// только строковые значения внутри — ничего вложенного не доходит до JSON,
// который рендерит публичный сайт.
function sanitizeContent(input) {
  if (input === undefined) return {};
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new RpcError('Текст сайта должен быть по языкам: узбекский, русский, английский.', 400);
  }
  const out = {};
  for (const lang of LANGS) {
    const langObj = input[lang];
    if (!langObj || typeof langObj !== 'object' || Array.isArray(langObj)) continue;
    const cleaned = {};
    for (const [key, val] of Object.entries(langObj)) {
      if (typeof val === 'string') cleaned[key] = val;
    }
    out[lang] = cleaned;
  }
  return out;
}

// name — у отделений, title — у новостей.
function contentName(content) {
  return (content.ru && (content.ru.name || content.ru.title))
    || (content.uz && (content.uz.name || content.uz.title))
    || (content.en && (content.en.name || content.en.title))
    || '';
}

// Свободный слаг: база, потом -2 … -20. excludeId — текущая строка при правке.
function resolveUniqueSlug(db, table, base, excludeId) {
  const ex = excludeId || 0;
  const free = (candidate) => !db.prepare(`SELECT id FROM ${table} WHERE slug = ? AND id != ?`).get(candidate, ex);
  if (free(base)) return base;
  for (let i = 2; i <= 20; i++) {
    const candidate = `${base}-${i}`;
    if (free(candidate)) return candidate;
  }
  throw new RpcError('Не удалось подобрать свободный адрес страницы — измените название.', 400);
}

// Chilla W4 — пути к файлам и имя автора: строка остаётся строкой, число и
// булево приводятся String(), объект/массив/функция — испорченный ввод,
// отклоняется до записи (иначе в колонке оказалось бы "[object Object]").
const STRING_SCALAR_FIELDS = new Set(['image_path', 'cover_path', 'author_name']);
const FIELD_LABEL = { image_path: 'Фото', cover_path: 'Обложка', author_name: 'Автор' };

function coerceStringScalar(field, value) {
  if (value === null || value === undefined) return '';
  const t = typeof value;
  if (t === 'string') return value;
  if (t === 'number' || t === 'boolean') return String(value);
  throw new RpcError(`Поле «${FIELD_LABEL[field] || field}» должно быть текстом.`, 400);
}

function normalizeScalars(kind, cfg, row) {
  const scalars = {};
  for (const field of cfg.scalars) {
    if (row[field] !== undefined) scalars[field] = row[field];
  }
  for (const field of cfg.scalars) {
    if (STRING_SCALAR_FIELDS.has(field) && scalars[field] !== undefined) {
      scalars[field] = coerceStringScalar(field, scalars[field]);
    }
  }
  if (kind === 'testimonials' && scalars.rating !== undefined) {
    const rating = Number(scalars.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw new RpcError('Оценка отзыва — целое число от 1 до 5.', 400);
    }
    scalars.rating = rating;
  }
  if (scalars.sort_order !== undefined) {
    const so = Number(scalars.sort_order);
    scalars.sort_order = Number.isFinite(so) ? Math.trunc(so) : 0;
  }
  return scalars;
}

// «Дата выхода» новости ставится РОВНО один раз — и публикацией, и явным
// published в сохранении (одна функция, чтобы два пути не разошлись).
function publishedAtSetClause(kind, published) {
  return (kind === 'posts' && published) ? "COALESCE(published_at, strftime('%Y-%m-%dT%H:%M:%SZ','now'))" : null;
}

// Отделения: строка на отделение клиники (department_id UNIQUE), свой слаг.
function upsertDepartment(db, cfg, kind, row, content, contentJson, scalars, contentProvided, publishedOverride) {
  const fkId = Number(row[cfg.fkCol]);
  if (!Number.isInteger(fkId) || fkId <= 0) throw new RpcError('Не выбрано отделение.', 400);
  const check = cfg.fkCheck(db, fkId);
  if (check === null) throw new RpcError('Отделение не найдено.', 400);
  if (check === false) throw new RpcError('Отделение неактивно.', 400);

  const existing = db.prepare(`SELECT id FROM ${cfg.table} WHERE ${cfg.fkCol} = ?`).get(fkId);
  if (existing) {
    // Слаг пересчитывается, только когда есть из чего: явный row.slug или
    // content, присланный ЭТИМ вызовом (включение «Опубликовать» без content
    // чужой слаг не трогает).
    let slug = null;
    if (typeof row.slug === 'string' && SLUG_RE.test(row.slug)) slug = row.slug;
    else if (contentProvided) slug = makeSlug(contentName(content)) || `${cfg.fkCol}-${fkId}`;
    if (slug != null) slug = resolveUniqueSlug(db, cfg.table, slug, existing.id);

    const sets = [];
    const params = { id: existing.id };
    if (slug != null) { sets.push('slug = @slug'); params.slug = slug; }
    if (contentProvided) { sets.push('content = @content'); params.content = contentJson; }
    for (const field of cfg.scalars) {
      if (scalars[field] !== undefined) { sets.push(`${field} = @${field}`); params[field] = scalars[field]; }
    }
    if (publishedOverride !== undefined) { sets.push('published = @published'); params.published = publishedOverride; }
    if (cfg.hasUpdatedAt) sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')");
    if (sets.length) db.prepare(`UPDATE ${cfg.table} SET ${sets.join(', ')} WHERE id = @id`).run(params);
    return existing.id;
  }

  let slug = typeof row.slug === 'string' && SLUG_RE.test(row.slug) ? row.slug : null;
  if (!slug) slug = makeSlug(contentName(content)) || `${cfg.fkCol}-${fkId}`;
  slug = resolveUniqueSlug(db, cfg.table, slug, 0);
  const fields = [cfg.fkCol, 'slug', 'content'];
  const placeholders = ['@fk', '@slug', '@content'];
  const params = { fk: fkId, slug, content: contentJson };
  for (const field of cfg.scalars) {
    if (scalars[field] !== undefined) { fields.push(field); placeholders.push(`@${field}`); params[field] = scalars[field]; }
  }
  if (publishedOverride !== undefined) { fields.push('published'); placeholders.push('@published'); params.published = publishedOverride; }
  return db.prepare(`INSERT INTO ${cfg.table} (${fields.join(', ')}) VALUES (${placeholders.join(', ')})`).run(params).lastInsertRowid;
}

// Отзывы, FAQ, новости — самостоятельные строки по id.
function upsertStandalone(db, cfg, kind, row, content, contentJson, scalars, contentProvided, publishedOverride) {
  const id = row.id != null ? Number(row.id) : null;
  const existing = id ? db.prepare(`SELECT id FROM ${cfg.table} WHERE id = ?`).get(id) : null;
  const patExpr = publishedOverride === undefined ? null : publishedAtSetClause(kind, publishedOverride);

  if (existing) {
    let slug = null;
    if (cfg.hasSlug) {
      if (typeof row.slug === 'string' && SLUG_RE.test(row.slug)) slug = row.slug;
      else if (contentProvided) slug = makeSlug(contentName(content)) || `post-${Date.now()}`;
      if (slug != null) slug = resolveUniqueSlug(db, cfg.table, slug, existing.id);
    }
    const sets = [];
    const params = { id: existing.id };
    if (contentProvided) { sets.push('content = @content'); params.content = contentJson; }
    if (cfg.hasSlug && slug != null) { sets.push('slug = @slug'); params.slug = slug; }
    for (const field of cfg.scalars) {
      if (scalars[field] !== undefined) { sets.push(`${field} = @${field}`); params[field] = scalars[field]; }
    }
    if (publishedOverride !== undefined) {
      if (patExpr) sets.push('published = 1', `published_at = ${patExpr}`);
      else { sets.push('published = @published'); params.published = publishedOverride; }
    }
    if (cfg.hasUpdatedAt) sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')");
    if (sets.length) db.prepare(`UPDATE ${cfg.table} SET ${sets.join(', ')} WHERE id = @id`).run(params);
    return existing.id;
  }

  let slug;
  if (cfg.hasSlug) {
    let candidate = typeof row.slug === 'string' && SLUG_RE.test(row.slug) ? row.slug : null;
    if (!candidate) candidate = makeSlug(contentName(content)) || `post-${Date.now()}`;
    slug = resolveUniqueSlug(db, cfg.table, candidate, 0);
  }
  const fields = ['content'];
  const placeholders = ['@content'];
  const params = { content: contentJson };
  if (cfg.hasSlug) { fields.push('slug'); placeholders.push('@slug'); params.slug = slug; }
  for (const field of cfg.scalars) {
    if (scalars[field] !== undefined) { fields.push(field); placeholders.push(`@${field}`); params[field] = scalars[field]; }
  }
  if (publishedOverride !== undefined) {
    fields.push('published'); placeholders.push('@published'); params.published = publishedOverride;
    // Новая строка: COALESCE на колонку ещё не вставленной строки невозможен — прямой strftime().
    if (patExpr) { fields.push('published_at'); placeholders.push("strftime('%Y-%m-%dT%H:%M:%SZ','now')"); }
  }
  return db.prepare(`INSERT INTO ${cfg.table} (${fields.join(', ')}) VALUES (${placeholders.join(', ')})`).run(params).lastInsertRowid;
}

export function websiteContentSave(db, args, user, { hasModule = hasWebsiteModule } = {}) {
  requireWebsite(db, user, 'edit', hasModule);
  const a = args || {};
  const kind = a.kind;
  const cfg = kindConfig(kind);
  const row = a.row;
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new RpcError('Нечего сохранять: запись не передана.', 400);
  }
  if (cfg.extras) {
    const id = saveExtras(db, kind, cfg, row);
    invalidateContentCache();
    return { id };
  }
  // content не прислан — существующий не трогаем (новая строка получает '{}');
  // published не прислан — колонку не трогаем.
  const contentProvided = row.content !== undefined;
  const content = sanitizeContent(row.content);
  const contentJson = JSON.stringify(content);
  const scalars = normalizeScalars(kind, cfg, row);
  const publishedOverride = row.published === undefined ? undefined : (row.published ? 1 : 0);
  const upsert = cfg.fkCol ? upsertDepartment : upsertStandalone;
  const id = db.transaction(() => upsert(db, cfg, kind, row, content, contentJson, scalars, contentProvided, publishedOverride))();
  invalidateContentCache();
  return { id: Number(id) };
}

export function websiteContentPublish(db, args, user, { hasModule = hasWebsiteModule } = {}) {
  requireWebsite(db, user, 'edit', hasModule);
  const a = args || {};
  const cfg = kindConfig(a.kind);
  if (cfg.extras) throw new RpcError(NO_PUBLISH[a.kind], 400);
  const id = Number(a.id);
  const existing = db.prepare(`SELECT id FROM ${cfg.table} WHERE id = ?`).get(id);
  if (!existing) throw new RpcError('Материал не найден.', 400);
  const published = a.published ? 1 : 0;
  const extra = cfg.hasUpdatedAt ? ", updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')" : '';
  const patExpr = publishedAtSetClause(a.kind, published);
  if (patExpr) {
    db.prepare(`UPDATE ${cfg.table} SET published = 1, published_at = ${patExpr}${extra} WHERE id = ?`).run(id);
  } else {
    db.prepare(`UPDATE ${cfg.table} SET published = ?${extra} WHERE id = ?`).run(published, id);
  }
  invalidateContentCache();
  return { ok: true };
}

// У врачей и услуг «удалить» = сбросить добавки (id — user_id / service_id):
// сам врач и сама услуга не трогаются, показ на сайте решает профиль.
export function websiteContentDelete(db, args, user, { hasModule = hasWebsiteModule } = {}) {
  requireWebsite(db, user, 'edit', hasModule);
  const a = args || {};
  const cfg = kindConfig(a.kind);
  const key = cfg.extras ? cfg.fkCol : 'id';
  db.prepare(`DELETE FROM ${cfg.table} WHERE ${key} = ?`).run(Number(cfg.extras ? (a[cfg.fkCol] ?? a.id) : a.id));
  invalidateContentCache();
  return { ok: true };
}

// ids — порядок сверху вниз. У врачей и услуг это user_id / service_id, и
// добавка заводится, если её ещё не было; чужие и неактивные id пропускаются.
export function websiteContentReorder(db, args, user, { hasModule = hasWebsiteModule } = {}) {
  requireWebsite(db, user, 'edit', hasModule);
  const a = args || {};
  const cfg = kindConfig(a.kind);
  if (a.kind === 'posts') {
    throw new RpcError('Новости сортируются по дате публикации — порядок менять нельзя.', 400);
  }
  const ids = Array.isArray(a.ids) ? a.ids : null;
  if (!ids) throw new RpcError('Порядок не передан.', 400);
  db.transaction(() => {
    ids.forEach((raw, index) => {
      const id = Number(raw);
      if (!Number.isInteger(id) || id <= 0) return;
      if (cfg.extras) {
        try { extrasTarget(db, a.kind, id); } catch { return; }
        db.prepare(`INSERT INTO ${cfg.table} (${cfg.fkCol}, sort_order) VALUES (?, ?)
                    ON CONFLICT(${cfg.fkCol}) DO UPDATE SET sort_order = excluded.sort_order,
                      updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')`).run(id, index);
      } else {
        db.prepare(`UPDATE ${cfg.table} SET sort_order = ? WHERE id = ?`).run(index, id);
      }
    });
  })();
  invalidateContentCache();
  return { ok: true };
}
