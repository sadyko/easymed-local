// DUP_STOP_V1 (2026-11-02) — правило «та же услуга в визите»: ключ, повтор, причина.
// Одно на сервер (server/services/domain/dup-order.js) и экраны (views/dup-order-check.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  orderKey, repeatableLine, repeatReasonOk, REPEAT_REASON_KEY, REPEAT_ROLES,
  DUP_TEMPLATE_BILLED, DUP_TEMPLATE_UNBILLED, DUP_TEMPLATE_TWICE, DUP_TEMPLATE_PLAIN,
  DUP_TEMPLATE_NAMELESS, DUP_TEMPLATE_TWICE_NAMELESS,   // DUP_STOP_V1 (остаток A5)
} from './dup-order.js';
import { STRINGS } from '../admin/i18n-strings.js';

test('DUP_STOP_V1: ключ — услуга каталога без врача; консультация — вид (или услуга-консультация) и врач', () => {
  assert.equal(orderKey({ serviceId: 40, serviceType: 'lab', doctorId: 10 }), 's:40');
  assert.equal(orderKey({ serviceId: '40', serviceType: 'imaging' }), 's:40');
  assert.equal(orderKey({ serviceId: 30, serviceType: 'consultation', requiresDoctor: 1, doctorId: 10 }), 's:30|d:10');
  assert.equal(orderKey({ serviceId: 30, serviceType: 'consultation', requiresDoctor: true }), 's:30|d:');
  assert.equal(orderKey({ consultationTypeId: 5, doctorId: 11 }), 'c:5|d:11');
  assert.notEqual(orderKey({ consultationTypeId: 5, doctorId: 11 }), orderKey({ consultationTypeId: 5, doctorId: 12 }));
  assert.equal(orderKey({ serviceId: 'c|7|3' }), null, 'id выбора консультации каталога — не услуга');
  assert.equal(orderKey({}), null);
  assert.equal(orderKey({ serviceId: 40, consultationTypeId: 5, serviceType: 'lab' }), 's:40', 'услуга сильнее вида приёма');
});

test('DUP_STOP_V1 (ревью m4): услуга без типа (по умолчанию «консультация») и без «нужен врач» — ключ без врача', () => {
  // services.type по умолчанию 'consultation' (миграция 022): анализ, которому тип не
  // проставили, с врачом в ключе проходил трижды — без врача, у врача 10 и у врача 11.
  for (const doctorId of [null, 10, 11]) {
    assert.equal(orderKey({ serviceId: 70, serviceType: 'consultation', doctorId }), 's:70', 'врач ' + doctorId);
    assert.equal(orderKey({ serviceId: 70, serviceType: 'consultation', requiresDoctor: 0, doctorId }), 's:70');
    assert.equal(orderKey({ serviceId: 70, serviceType: 'consultation', requiresDoctor: '0', doctorId }), 's:70', 'строка «0» из базы');
  }
  // врач в ключе — только консультации, которой нужен врач (как needsDoctor CRM)
  assert.equal(orderKey({ serviceId: 50, serviceType: 'imaging', requiresDoctor: 1, doctorId: 10 }), 's:50', 'УЗИ с врачом — та же услуга у любого врача');
  // вид приёма — всегда вид и врач
  assert.equal(orderKey({ consultationTypeId: 5, doctorId: 10 }), 'c:5|d:10');
  assert.equal(orderKey({ consultationTypeId: 5 }), 'c:5|d:');
});

test('DUP_STOP_V1: повтор разрешён товару и процедуре, остальным — нет', () => {
  assert.equal(repeatableLine({ clinicItemId: 3 }), true);
  assert.equal(repeatableLine({ serviceType: 'procedure' }), true);
  for (const t of ['lab', 'imaging', 'consultation', 'other', null]) assert.equal(repeatableLine({ serviceType: t }), false, String(t));
});

test('DUP_STOP_V1: причина обхода — не короче 3 знаков без пробелов по краям; поле и роли обхода', () => {
  assert.equal(repeatReasonOk('  ок '), false);
  assert.equal(repeatReasonOk('контроль'), true);
  assert.equal(repeatReasonOk(null), false);
  assert.equal(REPEAT_REASON_KEY, '__repeat_reason');
  assert.deepEqual([...REPEAT_ROLES], ['admin', 'head_doctor']);
});

test('DUP_STOP_V1: шаблоны отказа — в словаре на трёх языках, дырки сохранены, в uz/en нет кириллицы', () => {
  const holes = (s) => (String(s).match(/\{\w+\}/g) || []).sort().join(',');
  for (const key of [DUP_TEMPLATE_BILLED, DUP_TEMPLATE_UNBILLED, DUP_TEMPLATE_TWICE, DUP_TEMPLATE_PLAIN, DUP_TEMPLATE_NAMELESS, DUP_TEMPLATE_TWICE_NAMELESS]) {   // DUP_STOP_V1 (ревью M2) — PLAIN · остаток A5 — NAMELESS
    const e = STRINGS[key];
    assert.ok(e, 'нет в словаре: ' + key);
    for (const lang of ['uz', 'en']) {
      assert.ok(e[lang] && !/[Ѐ-ӿ]/.test(e[lang]), key + ' — ' + lang);
      assert.equal(holes(e[lang]), holes(key), key + ' — ' + lang + ': дырки');
    }
  }
});
