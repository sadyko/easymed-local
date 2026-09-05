#!/usr/bin/env node
// COOLICONS_V1 — генератор public/js/admin/icon-paths.js.
//
//   node scripts/build-icon-paths.mjs
//
// Читает public/js/admin/icon-map.js, берёт названные там файлы из
// public/assets/icons/coolicons/ и выкладывает их контуры в один JS-модуль,
// который грузится вместе с приложением.
//
// ЗАЧЕМ ГЕНЕРАТОР, А НЕ ЧТЕНИЕ SVG В БРАУЗЕРЕ. Icon(name) синхронно возвращает
// элемент — так его зовут все 88 экранов. fetch за файлом иконки синхронным не
// бывает, значит любой вариант «читаем SVG в рантайме» требует переписать все
// места вызова на await. Контуры, вкомпилированные в модуль, оставляют подпись
// Icon() ровно такой, какой она была.
//
// ЧТО ВЫРЕЗАЕТСЯ ИЗ ИСХОДНОГО SVG И ПОЧЕМУ:
//
//   id="Vector" / id="Interface / Book"  — в авторских файлах у каждого контура
//     один и тот же id. Иконок на экране десятки, и все они инлайнятся в один
//     документ: сотня элементов с id="Vector" — это невалидный DOM, по которому
//     getElementById и любой :target начинают возвращать случайный из них.
//
//   stroke / stroke-width / stroke-linecap / stroke-linejoin / fill  — эти
//     атрибуты в авторском файле стоят НА КОНТУРЕ, а атрибут на элементе бьёт
//     любое наследование от родителя. Оставить их — значит намертво прибить
//     stroke-width="2" и сделать параметр { stroke } в Icon() неработающим.
//     Убрав их, мы отдаём и толщину, и цвет внешнему <svg>, а он берёт цвет из
//     currentColor, то есть из цветовых токенов темы.
//
// Файл на выходе КОММИТИТСЯ, а не собирается при запуске: у проекта нет шага
// сборки (CLAUDE.md, «Vanilla HTML/CSS/JS ES modules. No framework, no build
// step»), клиника получает папку как есть. Свежесть сгенерированного файла
// стережёт тест (public/js/admin/__tests__/icons.test.mjs): он повторяет эту же
// генерацию в памяти и сверяет байты, так что «поправил SVG, забыл
// перегенерировать» падает в CI, а не на экране у клиники.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ICON_MAP } from '../public/js/admin/icon-map.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const ICONS_DIR = path.join(ROOT, 'public', 'assets', 'icons', 'coolicons');
export const OUT_FILE = path.join(ROOT, 'public', 'js', 'admin', 'icon-paths.js');

// Единственные рисующие элементы, которые встречаются в наборе (проверено по
// всем 442 файлам: только <g> и <path>). Появление любого другого — повод
// упасть, а не молча потерять часть рисунка.
const ALLOWED_ELEMENTS = new Set(['svg', 'g', 'path']);

/** Разбирает один авторский SVG в строку вида '<path d="…"/><path d="…"/>'. */
export function extractBody(svgText, label) {
    const elements = [...svgText.matchAll(/<([a-zA-Z][a-zA-Z0-9]*)\b/g)].map((m) => m[1]);
    for (const el of elements) {
        if (!ALLOWED_ELEMENTS.has(el)) {
            throw new Error(`${label}: неожиданный элемент <${el}> — генератор умеет только ${[...ALLOWED_ELEMENTS].join(', ')}`);
        }
    }
    if (!/viewBox="0 0 24 24"/.test(svgText)) {
        throw new Error(`${label}: ожидался viewBox="0 0 24 24" — иконка другого размера не встанет в общую сетку`);
    }
    const ds = [...svgText.matchAll(/<path\b[^>]*?\sd="([^"]+)"/g)].map((m) => m[1]);
    if (!ds.length) throw new Error(`${label}: в файле нет ни одного <path d="…">`);
    return ds.map((d) => `<path d="${d}"/>`).join('');
}

/** Путь к файлу набора по его имени в карте ('Arrow/Chevron_Down'). */
export function iconFile(coolPath, dir = ICONS_DIR) {
    return path.join(dir, ...coolPath.split('/')) + '.svg';
}

/**
 * Собирает содержимое icon-paths.js в память — ровно то, что пишется на диск.
 * Тест свежести зовёт эту же функцию, поэтому «сгенерировано» и «проверено»
 * не могут разъехаться.
 */
export function renderModule(map = ICON_MAP, dir = ICONS_DIR) {
    const wanted = [...new Set(Object.values(map))].sort();
    const lines = [];
    for (const coolPath of wanted) {
        const file = iconFile(coolPath, dir);
        let text;
        try {
            text = fs.readFileSync(file, 'utf8');
        } catch {
            throw new Error(`icon-map.js ссылается на «${coolPath}», а файла ${path.relative(ROOT, file)} нет`);
        }
        lines.push(`    ${JSON.stringify(coolPath)}: ${JSON.stringify(extractBody(text, coolPath))},`);
    }
    return [
        '// СГЕНЕРИРОВАННЫЙ ФАЙЛ — не править руками.',
        '//',
        '// Источник: public/assets/icons/coolicons/ (набор coolicons v4.1, CC BY 4.0,',
        '// см. ATTRIBUTION.md рядом с иконками) + public/js/admin/icon-map.js.',
        '// Пересобрать:  node scripts/build-icon-paths.mjs',
        '//',
        '// Ключ — авторское имя файла набора, значение — его контуры без атрибутов',
        '// цвета и толщины: их задаёт внешний <svg>, который собирает icons.js.',
        '',
        'export const ICON_BODIES = Object.freeze({',
        ...lines,
        '});',
        '',
    ].join('\n');
}

const realPath = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const isMain = process.argv[1]
    && realPath(path.resolve(process.argv[1])) === realPath(fileURLToPath(import.meta.url));

if (isMain) {
    const out = renderModule();
    fs.writeFileSync(OUT_FILE, out);
    const n = new Set(Object.values(ICON_MAP)).size;
    console.log(`icon-paths.js: ${n} иконок, ${(Buffer.byteLength(out) / 1024).toFixed(1)} КБ`);
}
