// REP_BOT_TAB_FIX_V1 (2026-11-18) — вкладка «Бот представителей» открывалась
// ошибкой «Не удалось открыть вкладку. Cannot access 'repCell' before
// initialization» (снимок владельца).
//
// Причина: renderReferralsRepBot() звал `await load()` в самом начале, а
// load() → paint() → pendingCard()/linksCard() обращались к repCell, tgCell и
// act — константам, объявленным НИЖЕ этого вызова. Объявления функций
// поднимаются, `const` — нет: пока выполнение не дошло до строки с const,
// обращение к имени бросает ReferenceError. Ломалось всегда, когда RPC
// отвечали, то есть при каждом открытии вкладки.
//
// Здесь же — блок «Как это работает» с образцом переписки в боте (просьба
// владельца: «put there explanation and sample view of process»).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { S, mk, walk, textOf, tick } from './crm-harness.mjs';

const { renderReferralsRepBot } = await import('../views/referrals-rep-bot.js');

const LINKS = [
  { id: 1, status: 'pending', rep_name: 'Алиев Бек', rep_phone: '+998 90 111 22 33', phone_tail: '2233', tg_name: 'Bek', tg_username: 'bek_rep', linked_at: '2026-11-17T09:00:00Z' },
  { id: 2, status: 'confirmed', rep_name: 'Каримова Лола', rep_phone: '+998 91 222 33 44', tg_name: 'Lola', tg_username: '', confirmed_at: '2026-11-10T09:00:00Z', added: 3 },
];

async function openTab(links = LINKS) {
  S.rpcAnswers = {
    rep_bot_settings_get: { has_token: true, enabled: true, bot_username: 'clinic_reps_bot', last_check_status: 'ok', token_hint: 'xY9z' },
    rep_bot_stats: { reps_active: 4, connected: 1, pending: 1, without_phone: 0, added_30d: 3 },
    rep_bot_links_list: links,
    rep_bot_additions_list: [{ source_name: 'Каримов Азиз', source_code: '17', source_phone: '+998 90 123 45 67', specialty: 'терапевт', workplace: 'Поликлиника 5', rep_name: 'Каримова Лола', created_at: '2026-11-12T09:00:00Z', active: 1 }],
  };
  const host = mk('div');
  await renderReferralsRepBot(host);
  await tick(30);
  S.rpcAnswers = null;
  return host;
}

test('вкладка открывается: ожидающие, подключённые и добавленные врачи на месте', async () => {
  const host = await openTab();
  const t = textOf(host);
  assert.ok(t.includes('Алиев Бек'), 'нет представителя, ожидающего подтверждения');
  assert.ok(t.includes('Каримова Лола'), 'нет подключённого представителя');
  assert.ok(t.includes('Каримов Азиз'), 'нет врача, добавленного через бота');
  assert.ok(walk(host).some((n) => n.attrs && 'data-repbot-confirm' in n.attrs), 'нет кнопки «Подтвердить»');
});

test('блок «Как это работает»: шаги процесса и образец переписки в боте', async () => {
  const host = await openTab([]);
  const how = walk(host).find((n) => n.attrs && 'data-repbot-how' in n.attrs);
  assert.ok(how, 'нет блока с объяснением процесса');
  const t = textOf(how);
  for (const step of ['Отправить номер', 'Подтвердить', 'Добавить врача', 'Проверьте данные врача', 'Врач добавлен', 'Врачи-источники']) {
    assert.ok(t.includes(step), `в объяснении нет шага «${step}»`);
  }
  assert.ok(walk(how).some((n) => n.attrs && 'data-repbot-sample' in n.attrs), 'нет образца переписки');
});
