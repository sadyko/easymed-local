// BRANCH_SYNC_V1 — что экран «Настройки → Филиалы» ГОВОРИТ владельцу.
//
// Без фальшивого DOM: все решения о тексте живут в branch-sync-logic.js
// (чистые функции), поэтому здесь проверяется главное требование к этому
// экрану — филиал, который не достучался до главного, должен сказать ИМЕННО
// это, а не «Ошибка» и не бодрое «Синхронизировано».
//
// BRANCH_LIST_V2 (2026-08-30) — и второе требование, появившееся после жалобы
// владельца («all the sloppy text that no one will read is unnecessary»):
// динамические фразы возвращаются ШАБЛОНОМ с дырками, а не готовой склейкой.
// Склейка не переводится нигде: tr() ищет в словаре строку целиком. Поэтому
// тесты ниже собирают текст тем же порядком, что и экран, — fill() ПОСЛЕ
// перевода, — а сам словарь стережёт views/branch-sync-i18n.test.js.

import { test } from 'node:test';
import assert from 'node:assert';
import { fill } from '../updates-logic.js';
import {
  roleBadge, roleExplainer, syncLine, changesLabel, whenLabel, canSyncNow, addressValue,
  routeLabel, syncKeyLine, relayExplainer, publishLine, canRegenerateKey, KEY_LOSS_WARNING,
  branchRows, branchListNote, KEY_REISSUE_WARNING, KEY_REISSUE_QUESTION,
  LETTER_PERMANENCE_WARNING, ADD_BRANCH_QUESTION, ISSUE_KEY_QUESTION,
  UNLINK_WARNING_MAIN, UNLINK_WARNING_SECONDARY, UNLINK_QUESTION, UNLINKED_BRANCH_NOTE,
  RELAY_ACCESS_ISSUED, pairedMessage, letterExplainer, becomeMainState, IDENTITY_UNKNOWN_NOTE,
} from '../branch-sync-logic.js';

/** Тем же порядком, что и экран (views/branch-sync.js say): перевод, потом подстановка. */
const say = (line) => (line ? fill(line.template, line.params) : '');

test('роль установки читается с одного взгляда', () => {
  assert.equal(roleBadge({ role: 'main' }).label, 'Главный филиал');
  assert.equal(roleBadge({ role: 'main' }).kind, 'ok');
  assert.equal(roleBadge({ role: 'secondary' }).label, 'Подключённый филиал');
  assert.equal(roleBadge({ role: 'none' }).label, 'Не связан');
  // Ответ старого сервера или пустой — это «не связан», а не пустая метка.
  assert.equal(roleBadge(null).label, 'Не связан');
  assert.equal(roleBadge({}).label, 'Не связан');
});

test('подпись к роли — ОДНА КОРОТКАЯ СТРОКА, и она всё ещё говорит главное', () => {
  // Было по два предложения на роль, и у подключённого филиала они дословно
  // повторяли абзац «Синхронизация переносит только справочник…», висевший
  // ниже под кнопкой. Один факт, набранный дважды на одном экране, учит
  // пролистывать оба — а пролистывают вместе с ним и то, что читать было надо.
  const secondary = roleExplainer({ role: 'secondary' });
  assert.match(secondary, /остаются здесь/, 'клинические данные никуда не едут — это обязано остаться');
  assert.match(roleExplainer({ role: 'main' }), /справочник/i);
  assert.match(roleExplainer({}), /главным/i);
  for (const role of ['main', 'secondary', 'none']) {
    // Мерка грубая, но она ловит именно то, ради чего всё переписано: подпись
    // под меткой роли не должна снова стать абзацем.
    assert.ok(roleExplainer({ role }).length <= 90, `подпись роли ${role} снова разрослась в абзац`);
  }
});

test('пока синхронизации не было — так и написано', () => {
  const line = syncLine({ role: 'secondary' });
  assert.equal(line.tone, 'none');
  assert.equal(say(line), 'Синхронизации ещё не было.');
});

test('неудачная попытка показывает ПРИЧИНУ и не прячет прошлый успех', () => {
  const line = syncLine({
    last_attempt: { at: '2026-08-29T09:05:00Z', ok: false, reason: 'offline', message: 'Нет связи с главным филиалом. Проверьте, включён ли его компьютер и та же ли это сеть.' },
    last_ok: { at: '2026-08-28T19:40:00Z', ok: true, changed: 4, updated: { services: 4 } },
  });
  assert.equal(line.tone, 'warn', 'строка должна выглядеть иначе, чем успешная');
  assert.match(say(line), /Нет связи с главным филиалом/);
  assert.match(say(line), /Последний раз получилось/, 'владелец должен видеть, что связь вообще работала');
});

test('неудача без единого успеха в прошлом не выдумывает дату', () => {
  const line = syncLine({ last_attempt: { at: '2026-08-29T09:05:00Z', ok: false, reason: 'unauthorized' } });
  assert.equal(line.tone, 'warn');
  assert.equal(say(line).includes('Последний раз получилось'), false);
  assert.match(say(line), /Не удалось синхронизироваться/, 'даже без message должна быть внятная фраза');
});

test('успешная синхронизация рассказывает, что именно изменилось', () => {
  const line = syncLine({
    last_attempt: { at: '2026-08-29T10:00:00Z', ok: true, changed: 3, created: { services: 2 }, updated: { lab_panels: 1 }, settings: true },
    last_ok: { at: '2026-08-29T10:00:00Z', ok: true, changed: 3, created: { services: 2 }, updated: { lab_panels: 1 }, settings: true },
  });
  assert.equal(line.tone, 'ok');
  assert.match(say(line), /добавлено: услуги — 2/);
  assert.match(say(line), /обновлено: лабораторные панели — 1/);
  assert.match(say(line), /сведения о клинике/);
});

test('пустой прогон не притворяется обновлением', () => {
  const line = syncLine({ last_ok: { at: '2026-08-29T10:00:00Z', ok: true, changed: 0, created: {}, updated: {} } });
  assert.equal(line.tone, 'ok');
  assert.match(say(line), /Изменений не было/);
});

test('служебные таблицы не превращаются в непонятные слова на экране', () => {
  // Имена таблиц базы данных владельцу ничего не говорят: справочник он знает
  // как «услуги» и «лабораторные панели».
  assert.match(changesLabel({ ok: true, created: { lab_panel_analytes: 5 } }), /показатели — 5/);
  // Неизвестная таблица просто не называется, а не печатается сырым именем.
  assert.equal(/some_new_table/.test(changesLabel({ ok: true, created: { some_new_table: 3 } })), false);
});

test('КАЖДОЕ склеиваемое слово проходит через переводчик, а не только внешняя фраза', () => {
  // Это и есть та ошибка, которую владелец сфотографировал, только на уровень
  // ниже: перечень изменений собирается вокруг чисел из данных сервера, поэтому
  // целой строкой в словаре не найдётся никогда — переводить надо каждое слово.
  const seen = [];
  const spy = (s) => { seen.push(s); return `[${s}]`; };
  const text = changesLabel({ ok: true, created: { services: 2 }, updated: { departments: 1 }, settings: true }, spy);
  assert.ok(seen.includes('услуги') && seen.includes('отделения'), 'названия таблиц обязаны идти через переводчик');
  assert.ok(seen.includes('добавлено') && seen.includes('обновлено'), 'и слова групп тоже');
  assert.ok(seen.includes('обновлены сведения о клинике'));
  assert.match(text, /\[услуги\] — 2/, 'переведённое слово встаёт на место непереведённого');

  // И то же самое во внешней фразе: путь синхронизации — её часть, а не подпись.
  const routeSeen = [];
  syncLine({ last_ok: { at: '2026-08-28T19:40:00Z', ok: true, route: 'relay', relayed_at: '2026-08-27T10:00:00Z' } },
    (s) => { routeSeen.push(s); return s; });
  assert.ok(routeSeen.includes('через сервер Easy-Med (зашифровано)'));
});

test('неизвестное состояние — прочерк, никогда «undefined»', () => {
  assert.equal(changesLabel(null), '—');
  assert.equal(changesLabel({ ok: false }), '—');
  assert.equal(whenLabel(null), '—');
  assert.equal(whenLabel('не дата'), '—');
});

test('дата и время показываются так, как их читает клиника', () => {
  assert.match(whenLabel('2026-08-29T09:05:00Z'), /^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}$/);
});

test('кнопка синхронизации доступна только администратору подключённого филиала', () => {
  assert.equal(canSyncNow({ role: 'secondary' }, true), true);
  assert.equal(canSyncNow({ role: 'secondary' }, false), false);
  assert.equal(canSyncNow({ role: 'main' }, true), false, 'главному филиалу неоткуда забирать справочник');
  assert.equal(canSyncNow(null, true), false);
});

test('поле адреса: сохранённый адрес важнее подсказки', () => {
  // Уже сохранённый адрес набран в ключах, разошедшихся по филиалам: перебить
  // его догадкой значило бы выдать новый ключ с другим адресом молча.
  assert.equal(addressValue({ role: 'main', main_url: '10.0.0.5:8000', suggested_url: '192.168.1.7:8000' }), '10.0.0.5:8000');
  assert.equal(addressValue({ role: 'none', suggested_url: '192.168.1.7:8000' }), '192.168.1.7:8000');
  assert.equal(addressValue(null), '');
});

test('путь синхронизации назван прямым текстом — и в успехе тоже', () => {
  // Клиника платит за VPN между зданиями. Если он полгода как не работает и
  // справочник всё это время ездит через сервер поставщика, владелец обязан
  // видеть это на экране, а не узнать случайно.
  assert.equal(routeLabel({ route: 'relay' }), 'через сервер Easy-Med (зашифровано)');
  assert.equal(routeLabel({ ok: true }), 'напрямую');
  assert.equal(routeLabel(null), 'напрямую');
  const line = syncLine({ last_ok: { at: '2026-08-28T19:40:00Z', ok: true, changed: 0 } });
  assert.match(say(line), /напрямую/);
  assert.equal(/undefined/.test(say(line)), false);
});

test('справочник, приехавший через сервер, назван так — и с возрастом копии', () => {
  // Прямым путём приезжает сегодняшний справочник, а через сервер — копия на
  // момент последней выгрузки главного филиала. Разницу между «цены свежие» и
  // «цены такие, какими были в понедельник» видно только отсюда.
  const line = syncLine({
    last_ok: { at: '2026-08-29T10:00:00Z', ok: true, route: 'relay', relayed_at: '2026-08-27T18:00:00Z', changed: 0 },
  });
  assert.match(say(line), /через сервер Easy-Med/);
  assert.match(say(line), /Копия главного филиала от 27\.08\.2026/);
});

test('неудача не прячет, каким путём получалось в прошлый раз', () => {
  const line = syncLine({
    last_attempt: { at: '2026-08-29T09:05:00Z', ok: false, message: 'Нет связи.' },
    last_ok: { at: '2026-08-28T19:40:00Z', ok: true, route: 'relay' },
  });
  assert.match(say(line), /через сервер Easy-Med/);
});

test('старая запись без пути читается как «напрямую», а не как «undefined»', () => {
  const line = syncLine({ last_ok: { at: '2026-08-28T19:40:00Z', ok: true, changed: 0 } });
  assert.equal(/undefined/.test(say(line)), false);
});

test('состояние ключа синхронизации: три честных ответа и ни одного бодрого', () => {
  const none = syncKeyLine({ sync_key_present: false, relay_ready: false });
  assert.equal(none.state, 'none');
  assert.match(say(none), /ещё не создан/);

  // Ключ у установки есть, но пара создана по старому ключу подключения:
  // резервный канал заработает только после перевыпуска.
  const stale = syncKeyLine({ sync_key_present: true, relay_ready: false });
  assert.equal(stale.state, 'unpaired');
  assert.match(say(stale), /выдайте филиалам ключи заново/);

  const ready = syncKeyLine({ sync_key_present: true, relay_ready: true, sync_key_created_at: '2026-08-12T10:00:00Z' });
  assert.equal(ready.state, 'ready');
  assert.match(say(ready), /Создан 12\.08\.2026/);
});

test('ДАТА ЖИВЁТ В ДЫРКЕ ШАБЛОНА, а не в склеенной строке', () => {
  // Ровно тот дефект, который владелец увидел на английском экране:
  // «Ключ синхронизации есть. Создан 12.08.2026.» собиралась склейкой, поэтому
  // tr() не могла найти её в словаре ни при каком языке. Теперь наружу идёт
  // целая русская фраза с дыркой — она же ключ словаря, — а дата отдельно.
  const ready = syncKeyLine({ sync_key_present: true, relay_ready: true, sync_key_created_at: '2026-08-12T10:00:00Z' });
  assert.equal(ready.template, 'Создан {date}.');
  assert.match(ready.params.date, /^12\.08\.2026/);
  assert.equal(/\d/.test(ready.template), false, 'в шаблоне не должно быть ни одной цифры даты');
  // Без даты — своя короткая фраза, а не «Создан {date}.» с пустой дыркой.
  const undated = syncKeyLine({ sync_key_present: true, relay_ready: true });
  assert.equal(undated.template, 'Ключ создан.');
  assert.deepEqual(undated.params, {});
});

test('владельцу сказано, что потерянный ключ не восстановит никто, включая Easy-Med', () => {
  // Это главная цена Маршрута Б. Стояла абзацем на экране постоянно — то есть
  // там, где её пролистывают; теперь стоит в окне подтверждения перевыпуска,
  // единственного действия, которым ключ теряют нарочно (views/branch-sync.js
  // paintSyncKey). Слова те же.
  assert.match(KEY_LOSS_WARNING, /не хранит ваш ключ/);
  assert.match(KEY_LOSS_WARNING, /не сможет и восстановить/);
});

test('переключатель объясняет РАЗНОЕ главному и подключённому филиалу', () => {
  // Главный отдаёт байты наружу — на это он и соглашается.
  assert.match(relayExplainer({ role: 'main' }), /сервере Easy-Med/);
  assert.match(relayExplainer({ role: 'main' }), /зашифрованной/);
  // Подключённый ничего не отдаёт: он только берёт, и только когда прямой путь
  // не удался.
  assert.match(relayExplainer({ role: 'secondary' }), /Прямая связь пробуется первой/);
  // И обе — ОДНОЙ СТРОКОЙ: что делает переключатель, написано на нём самом.
  for (const role of ['main', 'secondary']) {
    assert.ok(relayExplainer({ role }).length <= 100, `подпись переключателя (${role}) снова стала абзацем`);
  }
});

test('главный филиал видит, отправляется ли копия и когда отправлялась', () => {
  assert.equal(publishLine({ role: 'secondary' }), null, 'подключённому филиалу это поле не про что');
  assert.match(say(publishLine({ role: 'main', relay_enabled: false })), /не отправляется/);
  assert.match(say(publishLine({ role: 'main', relay_enabled: true })), /ещё ни разу не отправлялась/);
  const last = publishLine({ role: 'main', relay_enabled: true, relay_last_publish: { at: '2026-08-29T09:00:00Z' } });
  assert.equal(last.template, 'Копия на сервере обновлена {date}.', 'дата — в дырке, иначе фраза непереводима');
  assert.match(say(last), /Копия на сервере обновлена 29\.08\.2026/);
});

test('перевыпустить ключ может главный филиал, но не подключённый', () => {
  assert.equal(canRegenerateKey({ role: 'main' }, true), true);
  assert.equal(canRegenerateKey({ role: 'none' }, true), true, 'ещё не связанной установке ключ тоже принадлежит');
  assert.equal(canRegenerateKey({ role: 'secondary' }, true), false,
    'его ключ выдаёт главный филиал: перевыпуск у себя только отвалил бы филиал от группы');
  assert.equal(canRegenerateKey({ role: 'main' }, false), false, 'не администратор — не перевыпускает');
});

// --- BRANCH_IDENTITY_V1 — список филиалов, буквы и постоянные ключи ---------

test('список филиалов даёт каждому имя и ключ, который читается в любой момент', () => {
  // Требование владельца дословно: «in the branch list should be only the
  // branch name. and activation key (not one time generated)». Ключ,
  // показанный один раз и спрятанный, превращает переустановку филиала в
  // звонок поставщику.
  const rows = branchRows({ role: 'main', can_issue: true, branches: [
    { id: 1, name: 'Главный', letter: 'A', key: null, is_self: true },
    { id: 2, name: 'Чиланзар', letter: 'B', key: 'EMB2-xxxx' },
  ] });
  assert.equal(rows.length, 2);
  assert.equal(rows[1].key, 'EMB2-xxxx');
  assert.equal(rows[0].key, null, 'у главного филиала нет ключа, чтобы подключиться к самому себе');
  assert.equal(rows[0].state, 'self');
  assert.equal(rows[1].state, 'key');
});

test('ЭТА УСТАНОВКА ОТМЕЧЕНА МЕТКОЙ, а не объяснена предложением', () => {
  // Раньше под строкой стояло «Это и есть эта установка: подключать её к самой
  // себе не нужно» — одиннадцать слов там, где хватает двух. Ключа у неё нет и
  // быть не может, поэтому отличать её надо раньше, чем владелец успеет
  // поискать там ключ, — то есть меткой, а не текстом под строкой.
  const [self, other] = branchRows({ role: 'main', can_issue: true, branches: [
    { id: 1, name: 'Главный', letter: 'A', key: null, is_self: true },
    { id: 2, name: 'Чиланзар', letter: 'B', key: 'EMB2-xxxx' },
  ] });
  assert.equal(self.selfTag, 'Эта установка');
  assert.equal(self.action, null, 'подключать установку к самой себе не к чему');
  assert.equal(self.warnTag, null);
  assert.equal(other.selfTag, null, 'метка «эта установка» ровно одна на список');
  assert.equal(other.warnTag, null, 'у рабочей строки объяснять нечего');
  assert.equal(other.keyStatus, null, 'вместо ключа ничего писать не надо — ключ есть');
});

test('буква показана рядом с именем, потому что с неё начинается номер пациента', () => {
  const [row] = branchRows({ role: 'main', can_issue: true, branches: [{ id: 3, name: 'Юнусабад', letter: 'C', key: 'EMB2-y' }] });
  assert.equal(row.letter, 'C');
  assert.equal(row.letterLabel, 'C');
  // Филиал, заведённый до появления букв, не должен рисовать «undefined».
  const [old] = branchRows({ role: 'main', can_issue: true, branches: [{ id: 4, name: 'Старый', letter: null, key: null }] });
  assert.equal(old.letterLabel, '—');
  assert.equal(old.state, 'no_letter');
  assert.equal(old.keyStatus, 'Буквы и ключа ещё нет');
  assert.equal(old.action.label, 'Выдать ключ');
});

test('безымянная строка филиала не рисуется пустотой', () => {
  const [row] = branchRows({ role: 'main', branches: [{ id: 5, name: '', letter: 'D', key: 'EMB2-z' }] });
  assert.equal(row.name, '—');
});

test('подключённый филиал ключей не выдаёт и не делает вид, что может', () => {
  // Это свойство ВСЕГО СПИСКА, а не отдельной строки: не выдаёт ключи установка,
  // а не филиал. Строкой это было мёртвым состоянием — экран показывает список
  // только главному филиалу, — и мёртвая ветка тихо расходится с правдой.
  assert.match(branchListNote({ role: 'secondary' }), /главн/i);
  assert.match(branchListNote({ role: 'none' }), /главн/i);
  assert.equal(branchListNote({ role: 'main' }), null, 'главному филиалу объяснять нечего');
});

test('ключ без доступа к резервному каналу — МЕТКА И КНОПКА, а не три строки', () => {
  // ДВА ИЗМЕРЕННЫХ ПУТИ СЮДА, и оба обычные: перевыпуск ключа синхронизации
  // (учётки филиалов гасятся вместе с адресом, к которому были привязаны) и
  // заведение филиала при выключенном интернете. В обоих ключ рабочий — прямая
  // связь от поставщика не зависит, — но резервного канала у филиала нет.
  //
  // Объяснение было на три строки, из которых требовало действия только одно:
  // ключ придётся передать филиалу ЗАНОВО. Оно и переехало — в подтверждение
  // ПОСЛЕ нажатия (action.done), когда его надо выполнять, а на строке остались
  // метка и кнопка.
  const rows = branchRows({ role: 'main', can_issue: true, can_relay: true, branches: [
    { id: 2, name: 'Чиланзар', letter: 'B', key: 'EMB2-x', has_relay_token: false },
    { id: 3, name: 'Юнусабад', letter: 'C', key: 'EMB2-y', has_relay_token: true },
  ] });
  assert.equal(rows[0].state, 'key_no_relay');
  assert.equal(rows[0].key, 'EMB2-x', 'ключ остаётся рабочим и показывается целиком');
  assert.equal(rows[0].warnTag, 'Без резервного канала');
  assert.ok(rows[0].warnTag.split(/\s+/).length <= 4, 'это метка, а не предложение');
  assert.equal(rows[0].action.label, 'Выдать доступ');
  assert.equal(rows[0].action.done, RELAY_ACCESS_ISSUED);
  assert.match(RELAY_ACCESS_ISSUED, /ключ заново/, 'то единственное, что осталось сделать руками');
  assert.equal(rows[1].state, 'key');
  assert.equal(rows[1].warnTag, null);
  assert.equal(rows[1].action, null);
});

test('клинике без активации не показывают кнопку, которая всегда откажет', () => {
  // Резервного канала у такой клиники нет вовсе и быть не может — предлагать
  // «выдать доступ» значит обещать то, чего поставщик не выпишет.
  const [row] = branchRows({ role: 'main', can_issue: true, can_relay: false, branches: [
    { id: 2, name: 'Чиланзар', letter: 'B', key: 'EMB2-x', has_relay_token: false },
  ] });
  assert.equal(row.state, 'key');
  assert.equal(row.warnTag, null);
  assert.equal(row.action, null);
});

test('КНОПКИ СТРОКИ НЕТ ТАМ, ГДЕ СЕРВЕР ОТКАЖЕТ: can_issue решается здесь, а не на экране', () => {
  // Правило «кнопка есть ровно там, где сервер её примет» проверяется тестом
  // только пока оно живёт в тестируемом файле. Раньше его применял экран.
  const branches = [
    { id: 4, name: 'Старый', letter: null, key: null },
    { id: 2, name: 'Чиланзар', letter: 'B', key: 'EMB2-x', has_relay_token: false },
  ];
  for (const row of branchRows({ role: 'main', can_issue: false, can_relay: true, branches })) {
    assert.equal(row.action, null, `${row.state}: кнопки, которая всегда отказывает, быть не должно`);
  }
  // Состояние при этом всё равно НАЗВАНО — владелец должен понимать, что видит.
  const [noLetter, noRelay] = branchRows({ role: 'main', can_issue: false, can_relay: true, branches });
  assert.equal(noLetter.keyStatus, 'Буквы и ключа ещё нет');
  assert.equal(noRelay.warnTag, 'Без резервного канала');
});

test('буква есть, а адреса у главного нет — коротко сказано, чего не хватает', () => {
  const [row] = branchRows({ role: 'main', can_issue: false, branches: [{ id: 6, name: 'Сергели', letter: 'E', key: null }] });
  assert.equal(row.state, 'no_key');
  assert.equal(row.keyStatus, 'Нужен адрес для филиалов');
  assert.ok(row.keyStatus.split(/\s+/).length <= 5, 'это подпись клетки, а не абзац');
});

test('список переживает старый сервер и испорченный ответ', () => {
  assert.deepEqual(branchRows(null), []);
  assert.deepEqual(branchRows({ role: 'main' }), []);
  assert.deepEqual(branchRows({ role: 'main', branches: 'нет' }), []);
});

// --- ПРЕДУПРЕЖДЕНИЯ: все до одного живут в окне подтверждения --------------

test('перевыпуск ключа предупреждает ДО действия и ровно теми словами', () => {
  // Дословно из задачи: владелец должен прочитать это до нажатия, а не узнать
  // после того, как филиалы отвалились. Слова не изменились — изменилось
  // только то, что теперь они стоят ОДИН раз, в окне, а не ещё и абзацем на
  // экране под кнопкой.
  assert.equal(
    KEY_REISSUE_WARNING,
    'Перевыпуск ключа отключит все филиалы, подключённые старым ключом. Их придётся подключить заново.',
  );
  assert.match(KEY_REISSUE_QUESTION, /\?$/, 'вопрос окна обязан быть вопросом');
});

test('ПРО НЕСМЕНЯЕМОСТЬ БУКВЫ — там, где букву тратят, а не под полем ввода', () => {
  // Буква тратится безвозвратно (letters.js): её не получит ни один филиал,
  // никогда, даже если этот удалить, — иначе двое разных людей носили бы
  // одинаковые номера. Поэтому фразу нельзя выбросить.
  //
  // Но три строки под названием филиала стояли в тот момент, когда решение ещё
  // не принято: имя набирают и правят, а букву тратит НАЖАТИЕ. Оба вызова,
  // которые её тратят, теперь встречают эту фразу окном.
  assert.match(LETTER_PERMANENCE_WARNING, /навсегда/);
  assert.match(LETTER_PERMANENCE_WARNING, /номер пациента/i);
  assert.match(ADD_BRANCH_QUESTION, /\{name\}/, 'владелец должен видеть, какой филиал заводит');
  assert.match(ISSUE_KEY_QUESTION, /\{name\}/, 'и какому филиалу выдаёт ключ');
  assert.match(ADD_BRANCH_QUESTION, /\?$/);
  assert.match(ISSUE_KEY_QUESTION, /\?$/);
});

test('отвязка спрашивает, и спрашивает РАЗНОЕ у главного и у подключённого', () => {
  // Отвязка была единственным необратимым действием экрана БЕЗ вопроса перед
  // ним: последствие стояло абзацем рядом с кнопкой. Теряют они разное —
  // главный перестаёт РАЗДАВАТЬ, подключённый перестаёт ПОЛУЧАТЬ.
  assert.match(UNLINK_WARNING_MAIN, /Филиалы перестанут получать справочник отсюда/);
  assert.match(UNLINK_WARNING_SECONDARY, /Филиал перестанет получать справочник/);
  assert.notEqual(UNLINK_WARNING_MAIN, UNLINK_WARNING_SECONDARY);
  // И оба говорят, что уже приехавшее останется: это половина ответа на вопрос
  // «а не потеряю ли я услуги».
  assert.match(UNLINK_WARNING_MAIN, /останутся/);
  assert.match(UNLINK_WARNING_SECONDARY, /останутся/);
  assert.match(UNLINK_QUESTION, /\?$/);
});

test('ни одно предупреждение не потерялось по дороге', () => {
  // Смысл переписывания был в том, чтобы ПЕРЕНЕСТИ прозу, а не выбросить её.
  // Пустая или потерявшаяся константа — это молча удалённое предупреждение,
  // и заметить это на экране нельзя: там его теперь и не должно быть видно.
  for (const [name, text] of Object.entries({
    KEY_LOSS_WARNING, KEY_REISSUE_WARNING, LETTER_PERMANENCE_WARNING,
    UNLINK_WARNING_MAIN, UNLINK_WARNING_SECONDARY, IDENTITY_UNKNOWN_NOTE,
    UNLINKED_BRANCH_NOTE, RELAY_ACCESS_ISSUED,
  })) {
    assert.equal(typeof text, 'string', `${name} исчез`);
    assert.ok(text.trim().length >= 30, `${name} усох до подписи — предупреждение не должно худеть, оно должно переезжать`);
  }
});

test('подключение подтверждается буквой, а не бодрым «готово»', () => {
  // branchSyncPair возвращает принятую букву именно ради этой фразы: владелец
  // видит, чем стала установка, и сверяет её с ключом, который вводил.
  assert.equal(pairedMessage({ ok: true, letter: 'C' }).letter, 'C');
  // ЧАСТЯМИ: tr() ищет в словаре строку целиком, поэтому фраза, склеенная с
  // буквой, не нашлась бы там никогда и ушла бы в узбекскую клинику по-русски.
  assert.equal(pairedMessage({ ok: true, letter: 'C' }).base, 'Филиал подключён к главному');
  // Ключ старого выпуска буквы не несёт — выдумывать её нельзя.
  assert.equal(pairedMessage({ ok: true }).letter, null);
  assert.equal(pairedMessage(null).letter, null);
  assert.equal(pairedMessage(null).base, 'Филиал подключён к главному');
});

test('буква установки объяснена номером пациента, а не термином', () => {
  const line = letterExplainer({ letter: 'C' });
  assert.equal(line.example, 'C-26-00042', 'номер, который регистратура видит каждый день');
  // ЦЕЛОЙ ФРАЗОЙ С ДЫРКОЙ, а не двумя половинками, склеиваемыми на экране:
  // переводчику доставалась половина фразы без конца.
  assert.equal(line.template, 'Номера пациентов начинаются с {example}');
  assert.equal(say(line), 'Номера пациентов начинаются с C-26-00042');
  assert.equal(letterExplainer({}), null, 'нечего объяснять — нечего и писать');
});

test('«Сделать главным филиалом» не показывают там, где сервер откажет всегда', () => {
  // Правило то же, что у can_issue и can_relay: кнопка, которую показали и
  // которая всегда отказывает, хуже отсутствующей — владелец нажимает, читает
  // отказ и идёт искать свою ошибку там, где её нет.
  assert.equal(becomeMainState({ role: 'none', identity_role: 'main' }), 'allowed');
  assert.equal(becomeMainState({ role: 'none', identity_role: 'secondary' }), 'branch');

  // РОЛЬ НЕ ПРОЧИТАЛАСЬ — ТОЖЕ ОТКАЗ, и это вторая половина той же ошибки на
  // сервере: там «неизвестно» означало «можно» и разрешало отвязанному филиалу
  // с удалённой служебной строкой раздавать буквы. Молчание базы не может быть
  // правом.
  assert.equal(becomeMainState({ role: 'none', identity_role: null }), 'unknown');
  assert.equal(becomeMainState({ role: 'none' }), 'unknown');
  assert.equal(becomeMainState(null), 'unknown');

  // И это ОТДЕЛЬНОЕ состояние, а не «филиал»: филиалу помогает ключ подключения
  // с его буквой, а здесь помогает только восстановление базы.
  assert.notEqual(becomeMainState({ identity_role: null }), becomeMainState({ identity_role: 'secondary' }));
});

test('отвязанному филиалу сказано главное: буква осталась, нужен ключ с той же буквой', () => {
  assert.match(UNLINKED_BRANCH_NOTE, /навсегда/);
  assert.match(UNLINKED_BRANCH_NOTE, /с той же буквой/, 'это и есть лекарство, а не фон');
});

test('установке, потерявшей свою запись, сказано и про пациентов', () => {
  // Та же пропавшая строка останавливает не только выдачу ключей: триггер
  // номеров отказывает каждой регистрации. Владелец, прочитавший здесь только
  // про филиалы, пойдёт чинить филиалы, а сломана у него регистратура.
  //
  // ЭТА ФРАЗА ОСТАЁТСЯ ДЛИННОЙ НАРОЧНО: подтверждать нечего — нет действия,
  // перед которым можно спросить, — и это всё содержимое экрана в таком
  // состоянии, а не подпись под кнопкой.
  assert.match(IDENTITY_UNKNOWN_NOTE, /регистрир/i);
  assert.match(IDENTITY_UNKNOWN_NOTE, /резервной копии/i);
});
