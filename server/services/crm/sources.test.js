// CRM_MULTI_SOURCE_V1 (2026-09-29) — ПРАВИЛО ЧТЕНИЯ ИСТОЧНИКОВ ЗАЯВКИ ОДНО.
//
// Источники заявки = `sources`, если это непустой массив, иначе `[source]`,
// иначе `['other']`. Правило записано ДВАЖДЫ — на JS (leadSources: экран,
// проверка записи, слияние, выгрузка) и на SQL (leadSourcesSql: json_each в
// отчёте колл-центра), — и расходиться они не имеют права: иначе доска и отчёт
// назовут одной и той же заявке разные источники. Поэтому ОДНА таблица примеров
// прогоняется через обе записи.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { leadSources } from '../../../public/js/admin/crm-sources.js';
import { leadSourcesSql, sourceEachSql } from './sources.js';

// stored — то, что лежит в колонке TEXT (строка или NULL); source — главный.
const EXAMPLES = [
  { name: 'массив — как есть, в своём порядке', stored: '["instagram","referral"]', source: 'instagram', want: ['instagram', 'referral'] },
  { name: 'порядок массива главнее source', stored: '["referral","instagram"]', source: 'instagram', want: ['referral', 'instagram'] },
  { name: 'пустой массив — [source]', stored: '[]', source: 'call', want: ['call'] },
  { name: 'NULL — [source] (заявка от звонка, зеркала записи)', stored: null, source: 'telephony', want: ['telephony'] },
  { name: 'битый JSON — [source]', stored: 'not json', source: 'call', want: ['call'] },
  { name: 'объект, а не массив — [source]', stored: '{"a":1}', source: 'call', want: ['call'] },
  { name: 'JSON-строка, а не массив — [source]', stored: '"call"', source: 'walk_in', want: ['walk_in'] },
  { name: 'в массиве нет ни одного ключа — [source]', stored: '["", 5, null]', source: 'website', want: ['website'] },
  { name: 'повтор считается один раз', stored: '["a","a","b"]', source: 'a', want: ['a', 'b'] },
  { name: 'пустые элементы пропускаются', stored: '["x","","y"]', source: 'x', want: ['x', 'y'] },
  { name: 'ни sources, ни source — [other]', stored: null, source: '', want: ['other'] },
  { name: 'пустой массив и пустой source — [other]', stored: '[]', source: '', want: ['other'] },
];

test('правило чтения на JS: каждая строка таблицы примеров', () => {
  for (const ex of EXAMPLES) {
    assert.deepEqual(leadSources({ source: ex.source, sources: ex.stored }), ex.want, ex.name + ' (строка из базы)');
    // /api/db отдаёт JSON-колонку уже разобранной — тот же ответ.
    let parsed; try { parsed = JSON.parse(ex.stored); } catch { parsed = undefined; }
    if (parsed !== undefined) assert.deepEqual(leadSources({ source: ex.source, sources: parsed }), ex.want, ex.name + ' (разобранный массив)');
  }
  assert.deepEqual(leadSources(null), ['other']);
  assert.deepEqual(leadSources({}), ['other']);
});

test('правило чтения на SQL: та же таблица примеров даёт те же списки', () => {
  // Две колонки, как у crm_requests (source TEXT, sources TEXT), без справочника:
  // заявка с пустым source бывает только в старых/ручных данных, а внешний ключ
  // настоящей таблицы её не пустил бы. На самой crm_requests выражение
  // проверяют отчёт колл-центра и миграция 231.
  const db = openDb(':memory:');
  try {
    db.exec('CREATE TABLE leads (id INTEGER PRIMARY KEY, source TEXT, sources TEXT)');
    const ins = db.prepare('INSERT INTO leads (source, sources) VALUES (?,?)');
    const ids = EXAMPLES.map((ex) => Number(ins.run(ex.source, ex.stored).lastInsertRowid));
    const each = sourceEachSql('r', 'src');
    const q = db.prepare(`SELECT src.value AS k FROM leads r, ${each.join}
                           WHERE r.id = ? AND ${each.ok} GROUP BY src.value ORDER BY MIN(CAST(src.key AS INTEGER))`);
    EXAMPLES.forEach((ex, i) => {
      assert.deepEqual(q.all(ids[i]).map((x) => x.k), ex.want, ex.name);
    });
    // Само выражение — JSON-массив, пригодный для json_each где угодно.
    const arr = db.prepare(`SELECT ${leadSourcesSql('r')} AS a FROM leads r WHERE r.id = ?`).get(ids[0]).a;
    assert.deepEqual(JSON.parse(arr), ['instagram', 'referral']);
  } finally { db.close(); }
});
