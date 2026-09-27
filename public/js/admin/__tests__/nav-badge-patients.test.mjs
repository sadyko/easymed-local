// V3120_CLEANUP — бейдж «Пациенты» в меню спрашивает сервер только у того, кому
// пункт «Пациенты» выдан.
//
// После закрытия данных пациентов по разделам (server/db/patient-data-gate.js)
// роль без раздела «Пациенты» (склад) получает 403 на запрос patients. Счётчик
// в loadNavCounts (admin.js) спрашивался при каждой перерисовке меню — в прогоне
// экранов это 129 отказов у склада, по одному на каждый экран. Бейдж — подсказка
// к пункту меню; нет пункта — нет и запроса (так же, как у телеграма и кассы).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, '..', '..', 'admin.js'), 'utf8');

test('loadNavCounts: запрос patients — под isModuleAllowed(\'patients\')', () => {
  const start = SRC.indexOf('async function loadNavCounts');
  assert.ok(start > 0, 'loadNavCounts не найден');
  const body = SRC.slice(start, SRC.indexOf('\n}\n', start));
  const q = body.indexOf("from('patients')");
  assert.ok(q > 0, 'запрос бейджа пациентов не найден');
  const gate = body.lastIndexOf("isModuleAllowed('patients')", q);
  assert.ok(gate > 0, 'бейдж пациентов спрашивает сервер без проверки пункта меню');
  // Между проверкой и запросом — только тот же блок (никакого другого if/запроса).
  const between = body.slice(gate, q);
  assert.ok(!/supabase\.(from|rpc)\(/.test(between), 'проверка относится к другому запросу');
});
