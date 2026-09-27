// LIVE_AUDIT_FIX_V1 — единица товара в окне выдачи (item-picker-modal.js).
//
// Выпадающий список у строки молча переписывал products.unit ВСЕГО каталога,
// а врачу/медсестре/регистратуре сервер это запрещает — отказ глотался. Теперь
// единицу правят только роли products.update (сверено с реестром), отказ
// показывается, остальным единица видна как текст.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const SRC = fs.readFileSync(new URL('../views/item-picker-modal.js', import.meta.url), 'utf8');
const { REGISTRY } = await import('../../../../server/db/schema-registry.js');

test('правка единицы — только ролям products.update; отказ не глотается', () => {
  const m = SRC.match(/export const PRODUCT_UNIT_ROLES = \[([^\]]*)\]/);
  assert.ok(m, 'нет PRODUCT_UNIT_ROLES');
  const roles = m[1].split(',').map((x) => x.trim().replace(/'/g, '')).filter(Boolean).sort();
  assert.deepEqual(roles, [...REGISTRY.products.write.update.roles].sort());
  assert.match(SRC, /const canEditUnit = hasActorRole\(PRODUCT_UNIT_ROLES\)/);
  assert.ok(!/unit save:/.test(SRC), 'отказ записи единицы снова уходит только в консоль');
  assert.match(SRC, /Единица товара не сохранена/);
  // запись в каталог стоит ТОЛЬКО под canEditUnit
  const write = SRC.indexOf(".from('products').update({ unit");
  const guard = SRC.lastIndexOf('if (canEditUnit)', write);
  assert.ok(write > 0 && guard > 0 && write - guard < 1500, 'запись единицы в каталог не под проверкой роли');
});
