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
  routeLabel, syncKeyLine, relayExplainer, publishLine, canRegenerateKey, KEY_LOSS_WARNING,
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

// --- BRANCH_SYNC_RELAY_V1 ---------------------------------------------------
// Резервный канал через сервер поставщика. Требование владельца к этим строкам
// одно: по экрану должно быть видно, работает ли VPN между зданиями на самом
// деле. Значит путь называется вслух ВСЕГДА, а не только когда что-то сломалось.

test('путь синхронизации назван прямым текстом — и в успехе тоже', () => {
  const direct = syncLine({
    last_ok: { at: '2026-08-29T09:00:00Z', ok: true, route: 'direct', changed: 0 },
    last_attempt: { at: '2026-08-29T09:00:00Z', ok: true, route: 'direct', changed: 0 },
  });
  assert.equal(direct.tone, 'ok');
  assert.match(direct.text, /напрямую/);
  assert.equal(/через сервер/.test(direct.text), false);
});

test('справочник, приехавший через сервер, назван так — и с возрастом копии', () => {
  const line = syncLine({
    last_ok: {
      at: '2026-08-29T09:00:00Z', ok: true, route: 'relay', changed: 1,
      relayed_at: '2026-08-28T06:15:00Z', updated: { services: 1 },
    },
    last_attempt: { at: '2026-08-29T09:00:00Z', ok: true, route: 'relay', changed: 1, updated: { services: 1 } },
  });
  assert.match(line.text, /через сервер Easy-Med \(зашифровано\)/);
  // Возраст копии — не украшение: через сервер приезжает не сегодняшнее
  // состояние, а копия на момент последней выгрузки главного филиала.
  assert.match(line.text, /Копия главного филиала от/);
});

test('неудача не прячет, каким путём получалось в прошлый раз', () => {
  const line = syncLine({
    last_attempt: { at: '2026-08-29T09:05:00Z', ok: false, reason: 'offline', message: 'Нет связи с главным филиалом.' },
    last_ok: { at: '2026-08-28T19:40:00Z', ok: true, route: 'relay', changed: 2 },
  });
  assert.equal(line.tone, 'warn');
  assert.match(line.text, /через сервер Easy-Med/);
});

test('старая запись без пути читается как «напрямую», а не как «undefined»', () => {
  // Записи, сделанные до Маршрута Б, поля route не имеют. Экран обязан пережить
  // их, и прямой путь здесь — правда: другого тогда не было.
  assert.equal(routeLabel({ ok: true }), 'напрямую');
  assert.equal(routeLabel(null), 'напрямую');
  const line = syncLine({ last_ok: { at: '2026-08-28T19:40:00Z', ok: true, changed: 0 } });
  assert.match(line.text, /напрямую/);
  assert.equal(/undefined/.test(line.text), false);
});

test('состояние ключа синхронизации: три честных ответа и ни одного бодрого', () => {
  const none = syncKeyLine({ sync_key_present: false, relay_ready: false });
  assert.equal(none.state, 'none');
  assert.match(none.text, /ещё не создан/);

  // Ключ у установки есть, но пара создана по старому ключу подключения:
  // резервный канал заработает только после перевыпуска.
  const stale = syncKeyLine({ sync_key_present: true, relay_ready: false });
  assert.equal(stale.state, 'unpaired');
  assert.match(stale.text, /выдайте ключ подключения заново/);

  const ready = syncKeyLine({ sync_key_present: true, relay_ready: true, sync_key_created_at: '2026-08-12T10:00:00Z' });
  assert.equal(ready.state, 'ready');
  assert.match(ready.text, /Создан 12\.08\.2026/);
});

test('владельцу сказано, что потерянный ключ не восстановит никто, включая Easy-Med', () => {
  // Это главная цена Маршрута Б, и она должна стоять на экране ДО того, как
  // владелец на него положится, а не всплыть после потери.
  assert.match(KEY_LOSS_WARNING, /не хранит ваш ключ/);
  assert.match(KEY_LOSS_WARNING, /не сможет и восстановить/);
});

test('переключатель объясняет РАЗНОЕ главному и подключённому филиалу', () => {
  // Главный отдаёт байты наружу — на это он и соглашается.
  assert.match(relayExplainer({ role: 'main' }), /будет лежать на сервере Easy-Med/);
  assert.match(relayExplainer({ role: 'main' }), /Прочитать её Easy-Med не может/);
  // Подключённый ничего не отдаёт: он только берёт, и только когда прямой путь
  // не удался.
  assert.match(relayExplainer({ role: 'secondary' }), /Прямая связь всегда пробуется первой/);
});

test('главный филиал видит, отправляется ли копия и когда отправлялась', () => {
  assert.equal(publishLine({ role: 'secondary' }), null, 'подключённому филиалу это поле не про что');
  assert.match(publishLine({ role: 'main', relay_enabled: false }), /не отправляется/);
  assert.match(publishLine({ role: 'main', relay_enabled: true }), /ещё ни разу не отправлялась/);
  assert.match(
    publishLine({ role: 'main', relay_enabled: true, relay_last_publish: { at: '2026-08-29T09:00:00Z' } }),
    /Копия на сервере обновлена/,
  );
});

test('перевыпустить ключ может главный филиал, но не подключённый', () => {
  assert.equal(canRegenerateKey({ role: 'main' }, true), true);
  assert.equal(canRegenerateKey({ role: 'none' }, true), true, 'ещё не связанной установке ключ тоже принадлежит');
  assert.equal(canRegenerateKey({ role: 'secondary' }, true), false,
    'его ключ выдаёт главный филиал: перевыпуск у себя только отвалил бы филиал от группы');
  assert.equal(canRegenerateKey({ role: 'main' }, false), false, 'не администратор — не перевыпускает');
});
