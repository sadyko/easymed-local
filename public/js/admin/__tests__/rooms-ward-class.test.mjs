// JOURNALS_V1_WARD_CLASS — «Класс палаты» в окне палаты («Настройки → Помещения»):
// Люкс / Полулюкс / Обычная / не задан. Право — то же, что у правки палаты:
// класс в grantColumns «Помещений» (задача 1), stripToGrant его не срезает.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { catalogByKey } from '../../shared/permission-catalog.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const src = fs.readFileSync(path.join(ROOT, 'public', 'js', 'admin', 'views', 'rooms-setup.js'), 'utf8');
const admin = fs.readFileSync(path.join(ROOT, 'public', 'js', 'admin.js'), 'utf8');

test('окно палаты: выбор класса из общего словаря, «не задан» первым', () => {
  assert.match(src, /import \{ WARD_CLASSES, WARD_CLASS_RU, normalizeWardClass \} from '\.\.\/\.\.\/shared\/ward-class\.js';/);
  const step2 = src.slice(src.indexOf('function step2()'), src.indexOf('function doctorsField('));
  // Ветка палаты — от «if (isWard) {» до ветки кабинета (поле «Очередь»).
  const isWard = step2.slice(step2.indexOf('if (isWard) {'), step2.indexOf("field(tr('Очередь')"));
  assert.ok(isWard.length > 200, 'ветка палаты не найдена');
  assert.match(isWard, /field\(tr\('Класс палаты'\), h\('select'/);
  assert.match(isWard, /h\('option', \{ value: '', selected: !d\.ward_class \}, tr\('— не задан —'\)\)/);
  assert.match(isWard, /\.\.\.WARD_CLASSES\.map\(\(k\) => h\('option', \{ value: k, selected: d\.ward_class === k \}, tr\(WARD_CLASS_RU\[k\]\)\)\)/);
  // Выбор класса не спрятан за правом «Цены и проценты»: он стоит ПОСЛЕ
  // ветки цен, а не внутри неё.
  const cls = isWard.indexOf("tr('Класс палаты')");
  assert.ok(cls > isWard.indexOf("tr('Цены и проценты меняет только администратор.')"), 'класс палаты внутри ветки цен');
});

test('класс читается с палатой и пишется вместе с ней; пусто — null', () => {
  assert.match(src, /supabase\.from\('wards'\)\.select\('[^']*\bward_class\b[^']*'\)/);
  assert.match(src, /ward_class: src && src\.ward_class \? src\.ward_class : '',/);
  const save = src.slice(src.indexOf('async function save(d, row)'), src.indexOf('// users нельзя писать'));
  assert.match(save, /ward_class: normalizeWardClass\(d\.ward_class\),/);
  assert.match(save, /const wardBody = stripToGrant\('wards', payload\);/);
});

test('право: класс палаты пишет «Помещения: Изменение» — колонка в grantColumns палат', () => {
  const row = catalogByKey().get('settings.rooms');
  assert.ok(row && row.grantColumns && Array.isArray(row.grantColumns.wards), 'нет grantColumns палат у «Помещений»');
  assert.ok(row.grantColumns.wards.includes('ward_class'), 'stripToGrant срезал бы класс палаты у не-администратора');
});

test('штамп кэша «Помещений» обновлён', () => {
  assert.match(admin, /from '\.\/admin\/views\/rooms-setup\.js\?v=jrn1';/);
});
