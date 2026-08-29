// BRANCH_SYNC_V1 — что экран «Настройки → Филиалы» ГОВОРИТ владельцу.
//
// Без фальшивого DOM: все решения о тексте живут в branch-sync-logic.js
// (чистые функции), поэтому здесь проверяется главное требование к этому
// экрану — филиал, который не достучался до главного, должен сказать ИМЕННО
// это, а не «Ошибка» и не бодрое «Синхронизировано».

import { test } from 'node:test';
import assert from 'node:assert';
import {
  roleBadge, roleExplainer, syncLine, changesLabel, whenLabel, canSyncNow, addressValue,
} from '../branch-sync-logic.js';

test('роль установки читается с одного взгляда', () => {
  assert.equal(roleBadge({ role: 'main' }).label, 'Главный филиал');
  assert.equal(roleBadge({ role: 'main' }).kind, 'ok');
  assert.equal(roleBadge({ role: 'secondary' }).label, 'Подключённый филиал');
  assert.equal(roleBadge({ role: 'none' }).label, 'Не связан');
  // Ответ старого сервера или пустой — это «не связан», а не пустая метка.
  assert.equal(roleBadge(null).label, 'Не связан');
  assert.equal(roleBadge({}).label, 'Не связан');
});

test('подключённому филиалу прямо сказано, что клинические данные никуда не едут', () => {
  const text = roleExplainer({ role: 'secondary' });
  assert.match(text, /Пациенты, визиты, анализы и деньги остаются только здесь/);
  assert.match(roleExplainer({ role: 'main' }), /раздаёт справочник/);
  assert.match(roleExplainer({}), /не связаны/);
});

test('пока синхронизации не было — так и написано', () => {
  const line = syncLine({ role: 'secondary' });
  assert.equal(line.tone, 'none');
  assert.equal(line.text, 'Синхронизации ещё не было.');
});

test('неудачная попытка показывает ПРИЧИНУ и не прячет прошлый успех', () => {
  const line = syncLine({
    last_attempt: { at: '2026-08-29T09:05:00Z', ok: false, reason: 'offline', message: 'Нет связи с главным филиалом. Проверьте, включён ли его компьютер и та же ли это сеть.' },
    last_ok: { at: '2026-08-28T19:40:00Z', ok: true, changed: 4, updated: { services: 4 } },
  });
  assert.equal(line.tone, 'warn', 'строка должна выглядеть иначе, чем успешная');
  assert.match(line.text, /Нет связи с главным филиалом/);
  assert.match(line.text, /Последний раз получилось/, 'владелец должен видеть, что связь вообще работала');
});

test('неудача без единого успеха в прошлом не выдумывает дату', () => {
  const line = syncLine({ last_attempt: { at: '2026-08-29T09:05:00Z', ok: false, reason: 'unauthorized' } });
  assert.equal(line.tone, 'warn');
  assert.equal(line.text.includes('Последний раз получилось'), false);
  assert.match(line.text, /Не удалось синхронизироваться/, 'даже без message должна быть внятная фраза');
});

test('успешная синхронизация рассказывает, что именно изменилось', () => {
  const line = syncLine({
    last_attempt: { at: '2026-08-29T10:00:00Z', ok: true, changed: 3, created: { services: 2 }, updated: { lab_panels: 1 }, settings: true },
    last_ok: { at: '2026-08-29T10:00:00Z', ok: true, changed: 3, created: { services: 2 }, updated: { lab_panels: 1 }, settings: true },
  });
  assert.equal(line.tone, 'ok');
  assert.match(line.text, /добавлено: услуги — 2/);
  assert.match(line.text, /обновлено: лабораторные панели — 1/);
  assert.match(line.text, /сведения о клинике/);
});

test('пустой прогон не притворяется обновлением', () => {
  assert.equal(changesLabel({ ok: true, changed: 0, created: {}, updated: {} }),
    'Изменений не было — справочник уже совпадает.');
  // Нулевые счётчики — это тоже «ничего не было», а не «услуги — 0».
  assert.equal(changesLabel({ ok: true, created: { services: 0 }, updated: { lab_panels: 0 } }),
    'Изменений не было — справочник уже совпадает.');
});

test('служебные таблицы не превращаются в непонятные слова на экране', () => {
  // branch_sync_map и любое будущее имя, которому нет русского слова, просто
  // не показываются: «branch_sync_map — 12» владельцу не говорит ничего.
  const text = changesLabel({ ok: true, created: { services: 1, branch_sync_map: 12 } });
  assert.match(text, /услуги — 1/);
  assert.equal(text.includes('branch_sync_map'), false);
});

test('неизвестное состояние — прочерк, никогда «undefined»', () => {
  assert.equal(changesLabel(null), '—');
  assert.equal(changesLabel({ ok: false, reason: 'offline' }), '—');
  assert.equal(whenLabel(null), '—');
  assert.equal(whenLabel('не дата'), '—');
  assert.equal(whenLabel(''), '—');
});

test('дата и время показываются так, как их читает клиника', () => {
  // Локальное время: «копия от 29-го» должна значить 29-е по часам клиники.
  const d = new Date(2026, 7, 29, 19, 40);
  assert.equal(whenLabel(d.toISOString()), '29.08.2026 19:40');
});

test('кнопка синхронизации доступна только администратору подключённого филиала', () => {
  assert.equal(canSyncNow({ role: 'secondary' }, true), true);
  assert.equal(canSyncNow({ role: 'secondary' }, false), false, 'не администратор — не запускает');
  assert.equal(canSyncNow({ role: 'main' }, true), false, 'главный филиал раздаёт, а не забирает');
  assert.equal(canSyncNow({ role: 'none' }, true), false);
  assert.equal(canSyncNow(null, true), false);
});

test('поле адреса: сохранённый адрес важнее подсказки', () => {
  assert.equal(addressValue({ role: 'main', main_url: 'http://10.0.0.5:8000', suggested_url: 'http://192.168.1.9:8000' }),
    'http://10.0.0.5:8000', 'подмена сохранённого адреса догадкой выдала бы ключ с другим адресом');
  assert.equal(addressValue({ role: 'none', suggested_url: 'http://192.168.1.9:8000' }), 'http://192.168.1.9:8000');
  assert.equal(addressValue({ role: 'none' }), '');
  assert.equal(addressValue(null), '');
});
