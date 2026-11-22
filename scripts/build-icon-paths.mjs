#!/usr/bin/env node
// ICONS_LUCIDE_V1 — генератор public/js/admin/icon-paths.js.
//
//   node scripts/build-icon-paths.mjs
//
// Читает public/js/admin/icon-map.js, берёт названные там файлы из
// public/assets/icons/lucide/ и выкладывает их контуры в один JS-модуль,
// который грузится вместе с приложением.
//
// ПОЧЕМУ LUCIDE (2026-11-22, владелец: «use more professional icons everywhere,
// change all the icons, use more medical icons, minimalistic, not like ai
// generated»). Прежде стоял coolicons (общий интерфейсный набор, одна
// медицинская иконка) плюс дорисованные здесь медицинские значки, и рядом они
// выглядели собранными из разных рук. Lucide — один профессиональный набор,
// нарисованный людьми по одной сетке 24×24 и одной толщине, с настоящими
// медицинскими значками (стетоскоп, пульс, таблетка, колба, койка, больница).
// Лицензия ISC: копировать и менять можно, условие одно — уведомление об
// авторском праве (LICENSE рядом с иконками). Вендорятся только названные в
// карте файлы, а не 2400 штук набора.
//
// ЗАЧЕМ ГЕНЕРАТОР, А НЕ ЧТЕНИЕ SVG В БРАУЗЕРЕ. Icon(name) синхронно возвращает
// элемент — так его зовут все экраны. fetch за файлом иконки синхронным не
// бывает, значит любой вариант «читаем SVG в рантайме» требует переписать все
// места вызова на await. Контуры, вкомпилированные в модуль, оставляют подпись
// Icon() ровно такой, какой она была.
//
// ЧТО ДЕЛАЕТСЯ С ИСХОДНЫМ SVG И ПОЧЕМУ:
//
//   <circle>, <ellipse>, <rect>, <line> → <path d="…">. Lucide рисует часть
//     иконок фигурами, а весь остальной код (onboarding.js узнаёт пункт меню по
//     атрибуту d ПЕРВОГО контура иконки, тесты, проверка «контуры чистые»)
//     живёт в мире «иконка — это одни <path>». Фигура переводится в тот же
//     рисунок дугами и отрезками — на экране не меняется ни пиксель.
//
//   stroke / stroke-width / fill / class / комментарий лицензии — снимаются.
//     Атрибут на элементе бьёт наследование от родителя: оставить их — значит
//     намертво прибить толщину и сделать параметр { stroke } в Icon()
//     неработающим. Толщину и цвет задаёт внешний <svg> из icons.js (цвет — из
//     currentColor, то есть из токенов темы). Это и есть «изменения» набора,
//     о которых сказано в ATTRIBUTION.md.
//
// Файл на выходе КОММИТИТСЯ, а не собирается при запуске: у проекта нет шага
// сборки (CLAUDE.md, «Vanilla HTML/CSS/JS ES modules. No framework, no build
// step»), клиника получает папку как есть. Свежесть сгенерированного файла
// стережёт тест (public/js/admin/__tests__/icons.test.mjs): он повторяет эту же
// генерацию в памяти и сверяет, так что «поправил SVG, забыл перегенерировать»
// падает в CI, а не на экране у клиники.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ICON_MAP } from '../public/js/admin/icon-map.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ASSETS = path.join(ROOT, 'public', 'assets', 'icons');
export const ICONS_DIR = path.join(ASSETS, 'lucide');
export const ICON_DIRS = Object.freeze([ICONS_DIR]);
// ICONS_HEALTH_V1 (2026-11-22, владелец: «Change the general section icons to
// better ones too», после предложения взять медицинский набор) — медицинские
// разделы меню рисует Healthicons (healthicons.org, CC0): набор, сделанный
// именно для здравоохранения — врач, микроскоп, шприц, пациент в койке. Имя в
// карте с папкой ('healthicons/doctor') берётся отсюда; без папки — из Lucide.
// Healthicons рисует ЗАЛИВКОЙ (контур — это закрашенная фигура с вырезами
// fill-rule="evenodd"), а не линией, поэтому такие иконки перечислены в
// ICON_FILLED, и icons.js рисует их fill="currentColor" без обводки.
export const HEALTH_DIR = path.join(ASSETS, 'healthicons');
export const FILLED_SETS = Object.freeze(['healthicons']);
export const OUT_FILE = path.join(ROOT, 'public', 'js', 'admin', 'icon-paths.js');

// Рисующие элементы набора (проверено по всем вендоренным файлам). Появление
// любого другого — повод упасть, а не молча потерять часть рисунка.
const SHAPES = new Set(['path', 'circle', 'ellipse', 'rect', 'line']);
const ALLOWED_ELEMENTS = new Set(['svg', 'g', ...SHAPES]);

/** Число без хвоста нулей: 10, 2.5, -0.5. */
const n = (v) => String(Math.round(Number(v) * 1000) / 1000);

function attrsOf(tag) {
    const out = {};
    for (const m of tag.matchAll(/([a-zA-Z][a-zA-Z0-9-]*)="([^"]*)"/g)) out[m[1]] = m[2];
    return out;
}

/** Одна фигура SVG → эквивалентный атрибут d. */
export function shapeToD(el, a) {
    const num = (k, d = 0) => (a[k] == null ? d : Number(a[k]));
    if (el === 'path') return a.d;
    if (el === 'line') return `M${n(num('x1'))} ${n(num('y1'))}L${n(num('x2'))} ${n(num('y2'))}`;
    if (el === 'circle' || el === 'ellipse') {
        const cx = num('cx'), cy = num('cy');
        const rx = el === 'circle' ? num('r') : num('rx'), ry = el === 'circle' ? num('r') : num('ry');
        // Два полукруга: одна дуга на 360° в SVG не рисуется.
        return `M${n(cx - rx)} ${n(cy)}a${n(rx)} ${n(ry)} 0 1 0 ${n(2 * rx)} 0a${n(rx)} ${n(ry)} 0 1 0 ${n(-2 * rx)} 0`;
    }
    if (el === 'rect') {
        const x = num('x'), y = num('y'), w = num('width'), h = num('height');
        let rx = a.rx != null ? num('rx') : (a.ry != null ? num('ry') : 0);
        let ry = a.ry != null ? num('ry') : rx;
        rx = Math.min(rx, w / 2); ry = Math.min(ry, h / 2);
        if (!rx || !ry) return `M${n(x)} ${n(y)}h${n(w)}v${n(h)}h${n(-w)}z`;
        return `M${n(x + rx)} ${n(y)}h${n(w - 2 * rx)}a${n(rx)} ${n(ry)} 0 0 1 ${n(rx)} ${n(ry)}`
            + `v${n(h - 2 * ry)}a${n(rx)} ${n(ry)} 0 0 1 ${n(-rx)} ${n(ry)}`
            + `h${n(-(w - 2 * rx))}a${n(rx)} ${n(ry)} 0 0 1 ${n(-rx)} ${n(-ry)}`
            + `v${n(-(h - 2 * ry))}a${n(rx)} ${n(ry)} 0 0 1 ${n(rx)} ${n(-ry)}z`;
    }
    throw new Error(`фигура <${el}> не переводится в контур`);
}

/** Разбирает один SVG набора в строку вида '<path d="…"/><path d="…"/>'. */
export function extractBody(svgText, label) {
    const text = String(svgText).replace(/<!--[\s\S]*?-->/g, '');
    const tags = [...text.matchAll(/<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g)];
    for (const [, el] of tags) {
        if (!ALLOWED_ELEMENTS.has(el)) {
            throw new Error(`${label}: неожиданный элемент <${el}> — генератор умеет только ${[...ALLOWED_ELEMENTS].join(', ')}`);
        }
    }
    if (!/viewBox="0 0 24 24"/.test(text)) {
        throw new Error(`${label}: ожидался viewBox="0 0 24 24" — иконка другого размера не встанет в общую сетку`);
    }
    const shapes = tags.filter(([, el]) => SHAPES.has(el)).map(([, el, attrs]) => {
        const a = attrsOf(attrs);
        // ICONS_HEALTH_V1 — правило заливки СОХРАНЯЕТСЯ: у иконок-заливок вырезы
        // (лицо врача, просвет пробирки) держатся только на evenodd; без него
        // рисунок залился бы сплошным пятном. Цвет и обводка по-прежнему снаружи.
        const rule = a['fill-rule'] ? ` fill-rule="${a['fill-rule']}"` : '';
        const clip = a['clip-rule'] ? ` clip-rule="${a['clip-rule']}"` : '';
        return { d: shapeToD(el, a), extra: rule + clip };
    }).filter((s) => s.d);
    if (!shapes.length) throw new Error(`${label}: в файле нет ни одного контура`);
    return shapes.map((s) => `<path d="${s.d}"${s.extra}/>`).join('');
}

/**
 * Путь к файлу иконки по её имени в карте: 'stethoscope' — из Lucide,
 * 'healthicons/doctor' — из названной папки (ICONS_HEALTH_V1).
 */
export function iconFile(name, dirs = ICON_DIRS) {
    if (name.includes('/')) return path.join(ASSETS, ...name.split('/')) + '.svg';
    const list = Array.isArray(dirs) ? dirs : [dirs];
    const paths = list.map((dir) => path.join(dir, name) + '.svg');
    return paths.find((f) => fs.existsSync(f)) || paths[paths.length - 1];
}

/** 'lucide' — из какого набора взят рисунок. */
export function iconSource(name, dirs = ICON_DIRS) {
    return path.basename(path.dirname(iconFile(name, dirs)));
}

/**
 * Собирает содержимое icon-paths.js в память — ровно то, что пишется на диск.
 * Тест свежести зовёт эту же функцию, поэтому «сгенерировано» и «проверено»
 * не могут разъехаться.
 */
export function renderModule(map = ICON_MAP, dirs = ICON_DIRS) {
    const wanted = [...new Set(Object.values(map))].sort();
    const lines = [];
    for (const name of wanted) {
        const file = iconFile(name, dirs);
        let text;
        try {
            text = fs.readFileSync(file, 'utf8');
        } catch {
            throw new Error(`icon-map.js ссылается на «${name}», а файла ${path.relative(ROOT, file)} нет`);
        }
        lines.push(`    ${JSON.stringify(name)}: ${JSON.stringify(extractBody(text, name))},`);
    }
    const filled = wanted.filter((name) => FILLED_SETS.includes(iconSource(name, dirs)));
    return [
        '// СГЕНЕРИРОВАННЫЙ ФАЙЛ — не править руками.',
        '//',
        '// Источник: public/assets/icons/lucide/ (набор Lucide, лицензия ISC) и',
        '// public/assets/icons/healthicons/ (Healthicons, CC0) — см. LICENSE и',
        '// ATTRIBUTION.md рядом с иконками — + public/js/admin/icon-map.js.',
        '// Пересобрать:  node scripts/build-icon-paths.mjs',
        '//',
        '// Ключ — имя файла набора, значение — его контуры (фигуры переведены в',
        '// <path>) без атрибутов цвета и толщины: их задаёт внешний <svg>, который',
        '// собирает icons.js.',
        '',
        'export const ICON_BODIES = Object.freeze({',
        ...lines,
        '});',
        '',
        '// Иконки-заливки (Healthicons): icons.js рисует их fill="currentColor".',
        `export const ICON_FILLED = Object.freeze(${JSON.stringify(filled)});`,
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
    console.log(`icon-paths.js: ${wanted.length} иконок (Lucide + Healthicons), ${(Buffer.byteLength(out) / 1024).toFixed(1)} КБ`);
}
