// REFERRAL_LINE_V1 — надпись под «Рекомендациями» кабинета говорила «Реферальный бонус
// начисляется при выполнении», а правило — оплаченные счета (reports.js referralLines).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ws = fs.readFileSync(path.join(HERE, 'service-workspace.js'), 'utf8');

test('кабинет: бонус за направление — «когда счёт оплачен», а не «при выполнении»', () => {
  assert.ok(!ws.includes('начисляется при выполнении'), 'неправдивая надпись осталась');
  const at = ws.indexOf('function recsCard(ctx)');
  assert.ok(at > 0, 'карточка «Рекомендации» не найдена');
  assert.match(ws.slice(at, at + 1400), /Бонус за направление начисляется, когда счёт оплачен\./);
});
