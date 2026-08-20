// CALLCENTER_REPORT_V1 — карточка «Колл-центр» в «Отчётах».
//
// Режим «графики» раньше был ЖЁСТКО привязан к отчёту владельца: RPC
// 'owner_report' и renderOwnerCharts стояли прямо в коде построителя. Второй
// такой отчёт был невозможен, поэтому определение теперь само называет свой
// RPC и рисовалку. Тест закрепляет и связку, и то, что отчёт владельца от этого
// не изменился.

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const hub = fs.readFileSync(path.join(ROOT, 'public', 'js', 'admin', 'views', 'reports-hub.js'), 'utf8');

test('карточка колл-центра объявлена и полностью описана', () => {
  const i = hub.indexOf("kind:  'callcenter'");
  assert.ok(i > -1, 'карточка должна быть в REPORT_DEFS');
  const def = hub.slice(i, i + 700);
  assert.match(def, /rpc:\s*'callcenter_report'/, 'свой RPC');
  assert.match(def, /render:\s*\(el, data\) => renderCallcenterCharts/, 'своя рисовалка');
  assert.match(def, /exports:\s*true/, 'выгрузка в Excel включена');
  assert.match(def, /noBranch:\s*true/, 'у заявок нет филиала — селектор скрыт');
});

test('рисовалка колл-центра определена, а не только упомянута', () => {
  for (const fn of ['renderCallcenterCharts', 'ccHourBars', 'ccOperators']) {
    assert.match(hub, new RegExp('function ' + fn + '\\s*\\('), fn + ' должна быть определена');
  }
});

// Если построитель снова начнёт звать owner_report напрямую, колл-центр молча
// покажет чужие данные — это и была бы худшая поломка: экран выглядит рабочим.
test('построитель берёт RPC и рисовалку из определения отчёта', () => {
  assert.match(hub, /supabase\.rpc\(rep\.rpc \|\| 'owner_report'/, 'RPC — из определения');
  assert.match(hub, /\(rep\.render \|\| renderOwnerCharts\)\(previewEl/, 'рисовалка — из определения');
});

test('отчёт владельца остался без своего RPC и рисовалки — на запасном пути', () => {
  const i = hub.indexOf("kind:  'owner'");
  assert.ok(i > -1);
  const def = hub.slice(i, i + 500);
  assert.doesNotMatch(def, /rpc:/, 'владелец продолжает падать на owner_report по умолчанию');
  assert.match(def, /mode:\s*'charts'/);
});

// Кнопку выгрузки прячем только у отчётов, которым нечего выгружать. Колл-центр
// отдаёт строки, поэтому у него она обязана остаться.
test('Excel скрывается только у отчётов без строк', () => {
  assert.match(hub, /rep\.mode === 'charts' && !rep\.exports\) downloadBtn\.style\.display = 'none'/);
});
