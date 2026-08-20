// TELEGRAM_DRAFT_KEEP_V1 — опрос не должен стирать набранный ответ.
import { test } from 'node:test';
import assert from 'node:assert';
import { threadFingerprint, threadChanged } from '../../shared/thread-sync.js';

const T = (...ids) => ({ messages: ids.map((id) => ({ id, text: 'x' + id })) });

// Главный случай: за 10 секунд ничего не пришло — перерисовывать нечего, и
// поле ввода трогать нельзя.
test('без новых сообщений перерисовка не нужна', () => {
    assert.strictEqual(threadChanged(T(1, 2, 3), T(1, 2, 3)), false);
});

test('новое сообщение требует перерисовки', () => {
    assert.strictEqual(threadChanged(T(1, 2, 3), T(1, 2, 3, 4)), true);
});

// Пациент написал и тут же удалил — количество прежнее, последний другой.
test('изменение последнего сообщения замечается', () => {
    assert.strictEqual(threadChanged(T(1, 2, 3), T(1, 2, 9)), true);
});

test('пустая и отсутствующая лента не ломают сравнение', () => {
    for (const empty of [null, undefined, {}, { messages: [] }]) {
        assert.strictEqual(threadFingerprint(empty), '0:', JSON.stringify(empty));
    }
    assert.strictEqual(threadChanged(null, { messages: [] }), false);
    assert.strictEqual(threadChanged(null, T(1)), true);
});

// Без id (старые записи) сравниваем по времени — лишь бы не считать разным то,
// что не менялось.
test('без id используется время', () => {
    const a = { messages: [{ created_at: '2026-08-19T05:00:00Z' }] };
    const b = { messages: [{ created_at: '2026-08-19T05:00:00Z' }] };
    const c = { messages: [{ created_at: '2026-08-19T06:00:00Z' }] };
    assert.strictEqual(threadChanged(a, b), false);
    assert.strictEqual(threadChanged(a, c), true);
});
