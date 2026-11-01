// CLINIC_NEWS_STRIP_V1 — кто видит полосу «Новости клиники»: регистратура и
// call-центр и администратор; не медпредставитель (его роль — на основе
// call-центра), не врач.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { newsStripAudience } = await import('../clinic-news-strip-logic.js');

test('полоса — регистратору и call-центру, в том числе своей ролью клиники на их основе', () => {
  assert.equal(newsStripAudience({ role: 'registrar' }, ['registrar']), true);
  assert.equal(newsStripAudience({ role: 'callcenter' }, ['callcenter']), true);
  assert.equal(newsStripAudience({ role: 'registrar', custom_role_code: 'senior_reg' }, ['registrar']), true, 'своя роль на основе регистратора');
  assert.equal(newsStripAudience({ role: 'doctor', extra_roles: ['registrar'] }, ['doctor', 'registrar']), true, 'регистратор дополнительной ролью');
});

test('администратор тоже видит (владелец: «put to admin role to»)', () => {
  assert.equal(newsStripAudience({ role: 'admin' }, ['admin']), true);
  assert.equal(newsStripAudience({ role: 'doctor', is_doctor: 1 }, ['doctor', 'admin']), true, 'врач-администратор');
});

test('не видят: медпредставитель, врач, кассир, никто', () => {
  assert.equal(newsStripAudience({ role: 'callcenter', custom_role_code: 'medrep' }, ['callcenter']), false, 'medrep стоит на основе call-центра');
  assert.equal(newsStripAudience({ role: 'doctor' }, ['doctor']), false);
  assert.equal(newsStripAudience({ role: 'cashier' }, ['cashier']), false);
  assert.equal(newsStripAudience(null, ['registrar']), false);
  assert.equal(newsStripAudience({ role: 'registrar' }, []), false, 'роли неизвестны — полосы нет');
});
