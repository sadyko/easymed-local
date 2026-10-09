// CRM_UNIFY_V1 (итоговое ревью) — доска, «Список», «Задачи», «Отчёт», «CRM-канбан» и выгрузка Excel
// на языке uz: ни одной кириллической подписи (прогон — crm-i18n-leaks.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crmLeaks } from './crm-i18n-leaks.mjs';

test('CRM_UNIFY_V1: uz — в интерфейсе CRM нет кириллицы', async () => {
  const found = await crmLeaks('uz');
  const bad = Object.entries(found).filter(([, v]) => v.length);
  assert.deepEqual(bad, [], 'кириллица на экране:\n' + JSON.stringify(Object.fromEntries(bad), null, 1));
});
