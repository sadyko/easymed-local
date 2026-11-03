// LAB_TUBE_LABEL_V1 — материал пробирки один для приёма и для этикетки.
//
// Очередь лаборатории теперь делит строки визита на пробирки (этикетка на
// каждую), а приём делит заказы визита между пробирками (D3) — по одному и тому
// же ключу материала. Две копии правила разошлись бы при первой правке, и
// этикетка назвала бы пробирку, которую приём заполняет по-другому. Поэтому
// правило одно (public/js/shared/specimen-key.js), а ingest.js его реэкспортирует.
import test from 'node:test';
import assert from 'node:assert/strict';
import { specimenKey as fromIngest } from './ingest.js';
import { specimenKey as fromShared } from '../../public/js/shared/specimen-key.js';

test('приём берёт правило материала из общего модуля — это одна и та же функция', () => {
  assert.equal(typeof fromShared, 'function');
  assert.equal(fromIngest, fromShared);
});

test('правило прежнее: моча, плазма, сыворотка, кровь — по слову; прочее — текстом; пусто — не указан', () => {
  assert.deepEqual(
    ['Моча', 'Плазма крови (цитрат)', 'Сыворотка крови', 'Цельная кровь (ЭДТА)', 'whole blood', '  Мокрота ', null, '', '   '].map(fromShared),
    ['urine', 'plasma', 'serum', 'blood', 'blood', 'мокрота', '', '', ''],
  );
});
