// PUBLIC_API_V1 — «API и подключения»: строка «Публичный сервер» говорит, что с
// обменом — ещё не включён, ждём Easy-Med, работает (когда последний обмен и
// сколько заявок ждут клинику), нет обмена (с какого времени и почему);
// сервер старше экрана — прежняя строка.
import { test } from 'node:test';
import assert from 'node:assert';
import { mk, reset, onRpc, walk, textOf, byAttr, tick, settingsFixture, JOURNAL } from './api-harness.mjs';

const { renderApiConnections } = await import('../views/api-connections.js');

async function open(sync) {
  reset();
  onRpc('api_settings_get', () => settingsFixture());
  onRpc('api_journal_list', () => JOURNAL);
  if (sync !== undefined) onRpc('api_sync_status', () => sync);
  const root = mk('div');
  await renderApiConnections(root, {});
  await tick();
  return root;
}
const line = (root) => byAttr(root, 'data-apic-sync')[0];

test('сервер старше экрана (нет ответа) — прежняя строка «Ещё не включён» и «Ещё не работает»', async () => {
  const root = await open(undefined);
  assert.equal(line(root).attrs['data-apic-sync'], 'off');
  assert.ok(textOf(root).includes('Ещё не включён') && textOf(root).includes('Ещё не работает'));
});

test('ждём Easy-Med; работает — время обмена и ждущие заявки; нет обмена — с какого времени и почему', async () => {
  let root = await open({ state: 'waiting_vendor', reason: 'not_enabled', last_ok_at: null, pending_events: 0, waiting_requests: 0 });
  assert.ok(textOf(line(root)).includes('Подключения заработают, когда Easy-Med включит для клиники публичный сервер.'));
  root = await open({ state: 'ok', last_ok_at: '2030-03-11T04:00:00Z', last_error: '', waiting_requests: 2, pending_events: 0 });
  assert.match(textOf(line(root)), /Работает\. Последний обмен — .+\. Ждут ответа клиники: 2\./);
  assert.ok(textOf(root).includes('Работает'));
  root = await open({ state: 'error', last_ok_at: '2030-03-11T04:00:00Z', last_error: 'offline', last_error_at: '2030-03-11T05:00:00Z', waiting_requests: 0, pending_events: 1 });
  assert.match(textOf(line(root)), /Нет обмена с .+: нет связи с интернетом\. Заявки партнёров ждут на публичном сервере/);
  assert.ok(textOf(root).includes('Нет связи'));
  root = await open({ state: 'error', last_error: 'paused', last_error_at: '2030-03-11T05:00:00Z' });
  assert.ok(textOf(line(root)).includes('лицензия Easy-Med не продлена'));
});

// PUBLIC_API_V1 — ревью шага 8a, I3 / I4 / M4 / C1: строка «Публичный сервер» не
// говорит «нет обмена … придут, когда обмен вернётся», когда обмен идёт.
const tagText = (root) => textOf(byAttr(root, 'data-apic', 'address')[0].children[0]);
const note = (root) => byAttr(root, 'data-apic-skipped')[0];
const SKIP0 = { sealed: 0, failed: 0, last_at: null, last_ids: [] };

test('I4 (перевёрнутые client/zz-s8-crmroles-syncline и zz-s8-verify-crm-screens-3-*): неоткрывшаяся заявка — обмен «работает», отдельное предупреждение до сброса', async () => {
  const sealed = { state: 'ok', reason: '', last_ok_at: '2030-03-11T04:00:15Z', last_error: '', last_error_at: null, pending_events: 0, waiting_requests: 0,
    skipped: { sealed: 2, failed: 0, last_at: '2030-03-11T04:00:15Z', last_ids: ['rq_seal0001', 'rq_seal0002'] } };
  const root = await open(sealed);
  const t = textOf(line(root));
  assert.match(t, /Работает\. Последний обмен — /);
  assert.doesNotMatch(t, /Нет обмена|придут, когда обмен вернётся/);
  assert.ok(tagText(root).includes('Работает') && !textOf(root).includes('Нет связи'));
  const n = textOf(note(root));
  assert.match(n, /Заявки, которые не открылись ключом клиники: 2 \(последняя — .+\)\. Обратитесь в Easy-Med\./);
  assert.ok(n.includes('rq_seal0001, rq_seal0002'), 'номера заявок — для Easy-Med');
  assert.doesNotMatch(n, /придут, когда обмен вернётся/);
  // Сброс — администратору: api_sync_skipped_ack, затем строка перечитана.
  let acked = 0;
  onRpc('api_sync_skipped_ack', () => { acked += 1; return { ok: true }; });
  onRpc('api_sync_status', () => ({ ...sealed, skipped: SKIP0 }));
  const reset1 = walk(note(root)).find((x) => x.tagName === 'BUTTON');
  assert.ok(reset1 && textOf(reset1).includes('Сбросить'));
  reset1.click();
  await tick(40);
  assert.equal(acked, 1);
  assert.equal(note(root), undefined, 'после сброса предупреждения нет');
  // Без права администратора — предупреждение есть, кнопки сброса нет.
  reset();
  onRpc('api_settings_get', () => settingsFixture({ can: { view: true, edit: false, admin: false, reveal: false } }));
  onRpc('api_journal_list', () => JOURNAL);
  onRpc('api_sync_status', () => sealed);
  const viewer = mk('div');
  await renderApiConnections(viewer, {});
  await tick();
  assert.ok(note(viewer), 'предупреждение видно и «Просмотру»');
  assert.equal(walk(note(viewer)).filter((x) => x.tagName === 'BUTTON').length, 0);
  // Без пропусков — предупреждения нет.
  assert.equal(note(await open({ state: 'ok', last_ok_at: '2030-03-11T04:00:00Z', skipped: SKIP0 })), undefined);
  assert.equal(note(await open({ state: 'ok', last_ok_at: '2030-03-11T04:00:00Z' })), undefined, 'сервер без skipped');
});

test('C1: заявки, которые клиника не смогла сохранить, — то же предупреждение; застрявший приём — «обмен идёт с ошибкой», не «нет обмена»', async () => {
  const root = await open({ state: 'error', reason: 'intake_failed', last_ok_at: '2030-03-11T04:00:15Z', last_error: 'intake_failed', last_error_at: '2030-03-11T04:00:15Z',
    pending_events: 0, waiting_requests: 0, skipped: { sealed: 1, failed: 3, last_at: '2030-03-11T04:00:15Z', last_ids: ['rq_fail0001'] } });
  const t = textOf(line(root));
  assert.match(t, /обмен идёт с ошибкой: заявку из очереди не удаётся принять — если это не пройдёт за несколько минут, обратитесь в Easy-Med\./);
  assert.doesNotMatch(t, /Нет обмена|придут, когда обмен вернётся/);
  const n = textOf(note(root));
  assert.ok(n.includes('Заявки, которые не открылись ключом клиники: 1') && n.includes('Заявки из очереди, которые клиника не смогла сохранить: 3'), n);
  assert.ok(!tagText(root).includes('Нет связи') && tagText(root).includes('Ошибка'));
});

test('I3: имя в адресе занято — «заявки и уведомления идут, данные клиники не обновляются», с причиной; не «нет связи»', async () => {
  const root = await open({ state: 'error', reason: 'slug_taken', last_ok_at: '2030-03-11T05:00:00Z', last_error: 'slug_taken', last_error_at: '2030-03-11T05:00:00Z',
    pending_events: 0, waiting_requests: 0, skipped: SKIP0 });
  const t = textOf(line(root));
  assert.match(t, /Заявки и уведомления партнёрам идут, но данные клиники на сервере не обновляются с .+: имя клиники в адресе занято другой клиникой — смените имя\./);
  assert.doesNotMatch(t, /Нет обмена|придут, когда обмен вернётся|ошибка на стороне сервера/);
  assert.ok(tagText(root).includes('Ошибка') && !textOf(root).includes('Нет связи'));
  const other = await open({ state: 'error', reason: 'conflict', last_error: 'conflict', last_error_at: '2030-03-11T05:00:00Z', skipped: SKIP0 });
  assert.match(textOf(line(other)), /данные клиники на сервере не обновляются с .+: публичный сервер не принял данные клиники\./);
});

test('M4: файл ключа обмена повреждён — «нет обмена: … обратитесь в Easy-Med», а не «ждём Easy-Med»; с временем и без', async () => {
  let root = await open({ state: 'error', reason: 'key_broken', last_ok_at: null, last_error: '', last_error_at: null, pending_events: 0, waiting_requests: 0, skipped: SKIP0 });
  let t = textOf(line(root));
  assert.match(t, /Нет обмена: файл ключа обмена повреждён — обратитесь в Easy-Med\. Заявки партнёров ждут на публичном сервере/);
  assert.doesNotMatch(t, /когда Easy-Med включит/);
  assert.ok(textOf(root).includes('Нет связи'));
  root = await open({ state: 'error', reason: 'key_broken', last_ok_at: '2030-03-11T04:00:00Z', last_error: 'key_broken', last_error_at: '2030-03-11T05:00:00Z', skipped: SKIP0 });
  assert.match(textOf(line(root)), /Нет обмена с .+: файл ключа обмена повреждён — обратитесь в Easy-Med\./);
});

// PUBLIC_LICENCE_V1 — ревью 8c: клиника сменила компьютер — новый ключ обмена ждёт
// «Accept new key» в панели Easy-Med. Сотрудник Easy-Med спрашивает код ключа и
// вводит его в панели: строка «Публичный сервер» показывает «Код ключа обмена:
// 46de-4fe9» (код от сервера, api_sync_status key_code) и подсказку — в состояниях
// «ждём Easy-Med», «работает» и «ошибка». Код не переводится и не правится
// переводчиком браузера.
const CODE = '46de-4fe9';
const codeLine = (root) => byAttr(root, 'data-apic-keycode')[0];
test('PUBLIC_LICENCE_V1, ревью 8c: «Код ключа обмена: 46de-4fe9» и подсказка — у «ждём Easy-Med», «работает», «ошибка»', async () => {
  for (const sync of [
    { state: 'waiting_vendor', reason: 'not_enabled', last_ok_at: null, pending_events: 0, waiting_requests: 0, skipped: SKIP0, key_code: CODE },
    { state: 'ok', reason: '', last_ok_at: '2030-03-11T04:00:00Z', last_error: '', waiting_requests: 0, pending_events: 0, skipped: SKIP0, key_code: CODE },
    { state: 'error', reason: 'offline', last_ok_at: '2030-03-11T04:00:00Z', last_error: 'offline', last_error_at: '2030-03-11T05:00:00Z', skipped: SKIP0, key_code: CODE },
    { state: 'error', reason: 'unauthorized', last_error: 'unauthorized', last_error_at: '2030-03-11T05:00:00Z', skipped: SKIP0, key_code: CODE },
  ]) {
    const root = await open(sync);
    const el = codeLine(root);
    assert.ok(el, sync.state + ': нет строки с кодом');
    assert.equal(el.attrs['data-apic-keycode'], CODE);
    assert.ok(walk(line(root)).includes(el), sync.state + ': код — в строке «Публичный сервер»');
    const t = textOf(el);
    assert.ok(t.includes('Код ключа обмена: ' + CODE), sync.state + ': ' + t);
    assert.ok(t.includes('Easy-Med спросит этот код, если вы меняли компьютер.'), sync.state + ': ' + t);
    const val = walk(el).find((n) => n.tagName === 'CODE');
    assert.ok(val && textOf(val) === CODE && val.attrs.translate === 'no', 'код — отдельным элементом, без перевода');
  }
});

test('PUBLIC_LICENCE_V1, ревью 8c: кода нет — «ещё не включён», «первый обмен», ключ повреждён, сервер старше экрана, неверный код', async () => {
  for (const sync of [
    undefined,
    { state: 'off', reason: 'no_connections', key_code: CODE, skipped: SKIP0 },
    { state: 'starting', reason: '', key_code: CODE, skipped: SKIP0 },
    { state: 'error', reason: 'key_broken', last_error: 'key_broken', key_code: '', skipped: SKIP0 },
    { state: 'ok', last_ok_at: '2030-03-11T04:00:00Z', skipped: SKIP0 },
    { state: 'ok', last_ok_at: '2030-03-11T04:00:00Z', skipped: SKIP0, key_code: '46de4fe9a62a7f1349bdd3658be1696a' },
    { state: 'ok', last_ok_at: '2030-03-11T04:00:00Z', skipped: SKIP0, key_code: '<b>x</b>' },
  ]) {
    const root = await open(sync);
    assert.equal(codeLine(root), undefined, JSON.stringify(sync));
    assert.ok(!textOf(root).includes('Код ключа обмена'), JSON.stringify(sync));
  }
});

// PUBLIC_LICENCE_V1 — ревью 8c, телефон 360 px и шкала шрифтов: код — своей строкой
// под текстом (не сжимает его в колонку рядом), переносится, не шире строки;
// размеры — ступени шкалы (12.5 / 13.5, страж type-scale.test.mjs).
test('PUBLIC_LICENCE_V1, ревью 8c: код ключа на телефоне — своей строкой, переносится; размеры по шкале', async () => {
  const fs = await import('node:fs');
  const css = fs.readFileSync(new URL('../../../css/admin-views.css', import.meta.url), 'utf8');
  const rule = (sel) => (css.match(new RegExp('\\n' + sel.replace(/[.]/g, '\\.') + ' \\{([^}]*)\\}')) || [])[1] || '';
  assert.match(rule('.apic-keycode'), /display: block/, 'код — своей строкой под текстом');
  assert.match(rule('.apic-keycode'), /overflow-wrap: anywhere/, 'на 360 px строка переносится, а не уходит за край');
  assert.match(rule('.apic-keycode code'), /font-size: 13\.5px/);
  assert.match(rule('.apic-keycode code'), /white-space: nowrap/, 'код не рвётся посередине — его читают вслух');
  assert.match(rule('.apic-keycode-hint'), /font-size: 12\.5px/);
});
