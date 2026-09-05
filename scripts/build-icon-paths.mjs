#!/usr/bin/env node
// COOLICONS_V1 — генератор public/js/admin/icon-paths.js.
//
//   node scripts/build-icon-paths.mjs
//
// Читает public/js/admin/icon-map.js, берёт названные там файлы из
// public/assets/icons/ и выкладывает их контуры в один JS-модуль, который
// грузится вместе с приложением.
//
// ДВЕ ПАПКИ, И ЛОКАЛЬНАЯ ВЫИГРЫВАЕТ. Иконки лежат в двух наборах:
// easymed/ (нарисовано здесь, см. ORIGIN.md) и coolicons/ (вендоренный набор,
// CC BY 4.0). Путь из карты ищется сначала в easymed/, потом в coolicons/ —
// значит, чтобы заменить приближение набора собственным рисунком, достаточно
// положить файл по тому же имени в easymed/. Папки разделены не ради удобства:
// ATTRIBUTION.md набора не должен выглядеть распространяющимся на наш рисунок,
// а наш ORIGIN.md — на их.
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
const ASSETS = path.join(ROOT, 'public', 'assets', 'icons');
export const ICONS_DIR = path.join(ASSETS, 'coolicons');
export const LOCAL_ICONS_DIR = path.join(ASSETS, 'easymed');
/** Порядок поиска: свой рисунок перекрывает приближение набора. */
export const ICON_DIRS = Object.freeze([LOCAL_ICONS_DIR, ICONS_DIR]);
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

/**
 * Путь к файлу иконки по её имени в карте ('Arrow/Chevron_Down'). Ищет по
 * dirs по порядку и возвращает первый существующий файл; если нет нигде —
 * возвращает путь в ПОСЛЕДНЕЙ папке, чтобы сообщение об ошибке называло
 * основной набор, а не локальный.
 */
export function iconFile(coolPath, dirs = ICON_DIRS) {
    const list = Array.isArray(dirs) ? dirs : [dirs];
    const paths = list.map((dir) => path.join(dir, ...coolPath.split('/')) + '.svg');
    return paths.find((f) => fs.existsSync(f)) || paths[paths.length - 1];
}

/** 'easymed' | 'coolicons' — из какого набора реально взят рисунок. */
export function iconSource(coolPath, dirs = ICON_DIRS) {
    return path.basename(path.dirname(path.dirname(iconFile(coolPath, dirs))));
}

/**
 * Собирает содержимое icon-paths.js в память — ровно то, что пишется на диск.
 * Тест свежести зовёт эту же функцию, поэтому «сгенерировано» и «проверено»
 * не могут разъехаться.
 */
export function renderModule(map = ICON_MAP, dirs = ICON_DIRS) {
    const wanted = [...new Set(Object.values(map))].sort();
    const lines = [];
    for (const coolPath of wanted) {
        const file = iconFile(coolPath, dirs);
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
        '// Источник: public/assets/icons/easymed/ (наш рисунок, см. ORIGIN.md) и',
        '// public/assets/icons/coolicons/ (набор coolicons v4.1, CC BY 4.0, см.',
        '// ATTRIBUTION.md рядом с иконками) + public/js/admin/icon-map.js.',
        '// Имя ищется сначала в easymed/, потом в coolicons/.',
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
    const wanted = [...new Set(Object.values(ICON_MAP))];
    const local = wanted.filter((p) => iconSource(p) === 'easymed').length;
    console.log(`icon-paths.js: ${wanted.length} иконок (${local} свои, ${wanted.length - local} coolicons), ${(Buffer.byteLength(out) / 1024).toFixed(1)} КБ`);
}
