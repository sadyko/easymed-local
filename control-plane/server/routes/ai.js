import express, { Router } from 'express';
import { callClaude as realCallClaude, costMicroUsd } from '../services/ai-reply.js';
import { aiProvider, callOpenAi } from '../services/ai-reply-openai.js';   // AI_OPENAI_V1

// AI_OPENAI_V1 — кто отвечает, решает AI_PROVIDER сервера управления: 'openai' —
// ChatGPT (ai-reply-openai.js), иначе Claude, как было. Тесты подменяют callClaude
// целиком и до провайдера не доходят.
const defaultCall = (payload) => (aiProvider() === 'openai' ? callOpenAi(payload) : realCallClaude(payload));
import { isEntitled } from '../services/checkin.js';

// AI_CHAT_V1 — POST /cp/v1/ai/chat-reply: клиника просит ответ пациенту.
//
// АУТЕНТИФИКАЦИЯ — install_token, тот же, что при сверке, но в заголовке
// X-Install-Token, а не в теле. Ручка смонтирована в app.js ВЫШЕ общего
// app.use('/cp', express.json({ limit: '100kb' })) по тем же двум причинам,
// что deploy и relay: тело (переписка + публичный снимок клиники: 2000 услуг —
// сотни килобайт) не влезает в 100 КБ, и чужой токен должен получить отказ
// ДО того, как процесс прочтёт хоть байт тела. Поэтому токен в теле не
// принимается вовсе: его там просто ещё не видно.
//
// ПОРЯДОК: клиника → модуль `ai` (свой или главной клиники сети, как в
// checkin.js BRANCH_MODULES_INHERIT_V1) → оплаченная подписка (A9: isEntitled,
// то же правило, что решает перевыпуск лицензии) → месячный лимит → разбор
// тела → Claude → учёт. Все отказы — до разбора тела и до Claude: клиника без
// права на ИИ не стоит нам ни байта, ни цента.
//
// ТЕКСТ ПЕРЕПИСКИ НИГДЕ НЕ СОХРАНЯЕТСЯ И НЕ ПИШЕТСЯ В ЛОГ: в ai_usage только
// числа. Ошибки уходят в общий обработчик app.js, который тело не печатает.

export const AI_MOUNT = '/cp/v1/ai/chat-reply';
const BODY_LIMIT = '1mb';
const MAX_TURNS = 20;
const MAX_TEXT = 2000;
const MAX_FACTS_CHARS = 250_000;

// Тот же ответ, что у checkin.js и relay.js, для пропавшего, чужого и
// выведенного из работы токена — иначе по разнице ответов можно перебирать
// живые токены.
const unknown = (res) => res.status(401).json({ error: { code: 'invalid_token', message: 'This install is not recognised.' } });
const noModule = (res) => res.status(402).json({ error: { code: 'no_module' } });

export function aiRoutes(db, { callClaude = defaultCall, now = () => new Date() } = {}) {
  const r = Router();

  const gate = (req, res, next) => {
    const raw = req.get('x-install-token');
    const token = typeof raw === 'string' && raw.trim() ? raw.trim() : null;
    if (!token) return unknown(res);
    const clinic = db.prepare(
      'SELECT clinic_id, ai_monthly_limit_usd, subscription, subscription_until FROM clinics WHERE install_token = ? AND active = 1'
    ).get(token);
    if (!clinic) return unknown(res);
    const hasAi = db.prepare(
      `SELECT 1 FROM clinic_modules WHERE module_key = 'ai'
          AND (clinic_id = ? OR clinic_id = (SELECT parent_clinic_id FROM clinics WHERE clinic_id = ?))`
    ).get(clinic.clinic_id, clinic.clinic_id);
    if (!hasAi) return noModule(res);
    // A9 — подписка СВОЕЙ строки (у филиала свой счёт, модули — общие с сетью).
    // Отказ тем же кодом no_module: для клиники итог один — ИИ не работает,
    // а экран переключателя уже умеет это показать.
    const at = now();
    if (!isEntitled(clinic.subscription, clinic.subscription_until, at)) return noModule(res);
    const month = at.toISOString().slice(0, 7);
    const used = db.prepare('SELECT cost_micro_usd FROM ai_usage WHERE clinic_id = ? AND month = ?').get(clinic.clinic_id, month);
    if ((used ? used.cost_micro_usd : 0) >= Math.round(Number(clinic.ai_monthly_limit_usd || 0) * 1_000_000)) {
      return res.status(402).json({ error: { code: 'limit' } });
    }
    req.aiClinicId = clinic.clinic_id;
    req.aiMonth = month;
    next();
  };

  r.post('/', gate, express.json({ limit: BODY_LIMIT }), async (req, res) => {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const payload = {
      channel: String(b.channel || '').slice(0, 40),
      patient_name: String(b.patient_name || '').slice(0, 200),
      post_text: String(b.post_text || '').slice(0, MAX_TEXT),
      transcript: Array.isArray(b.transcript)
        ? b.transcript.slice(-MAX_TURNS).map((m) => ({ from: m && m.from === 'patient' ? 'patient' : 'clinic', text: String((m && m.text) || '').slice(0, MAX_TEXT) }))
        : [],
      facts: b.facts && typeof b.facts === 'object' && !Array.isArray(b.facts) ? b.facts : {},
    };
    // Снимок клиники уходит Claude ЦЕЛИКОМ в каждом запросе (кэшируется, но
    // первая запись кэша платная). Клиника шлёт сжатую форму (facts.js, A5:
    // 2000 услуг < 200 000 знаков); больше — значит что-то не так, и платить
    // за это мы не будем. Код too_large клиника понимает (cp-client.js).
    if (JSON.stringify(payload.facts).length > MAX_FACTS_CHARS) return res.status(413).json({ error: { code: 'too_large' } });
    // Отвечать не на что: ни одной реплики пациента среди последних 20.
    if (!payload.transcript.some((m) => m.from === 'patient' && m.text.trim())) {
      return res.status(400).json({ error: { code: 'bad_request', message: 'No patient message to answer.' } });
    }
    let answer;
    try {
      answer = await callClaude(payload);
    } catch (e) {
      // Сбой у Anthropic (ключ, лимит, перегрузка, таймаут) — клинике 503:
      // это не её ошибка. В лог — только статус и тип ошибки: в сообщении
      // ошибки SDK бывает тело ответа, а нам в логе не нужно ничего, что
      // могло бы оказаться текстом переписки.
      const type = e && e.error && (e.error.error?.type || e.error.type);
      console.warn('[control-plane] AI upstream failure', (e && e.status) || 'no-status', type || 'no-type');
      return res.status(503).json({ error: { code: 'upstream' } });
    }
    const { result, usage = {}, cost_micro_usd: knownCost } = answer || {};   // AI_OPENAI_V1 — у ChatGPT своя цена
    if (!result) return res.status(503).json({ error: { code: 'upstream' } });
    // Учёт — после ответа Claude: запрос, упавший до ответа, денег не стоил.
    // Месяц — тот, что проверялся в gate, чтобы проверка и запись не
    // разъехались на стыке месяцев.
    db.prepare(`INSERT INTO ai_usage (clinic_id, month, requests, input_tokens, output_tokens, cost_micro_usd) VALUES (?, ?, 1, ?, ?, ?)
                ON CONFLICT(clinic_id, month) DO UPDATE SET requests = requests + 1, input_tokens = input_tokens + excluded.input_tokens,
                  output_tokens = output_tokens + excluded.output_tokens, cost_micro_usd = cost_micro_usd + excluded.cost_micro_usd`)
      .run(req.aiClinicId, req.aiMonth, Number(usage.input_tokens || 0), Number(usage.output_tokens || 0),
        Number.isFinite(knownCost) ? knownCost : costMicroUsd(usage));
    res.json(result);
  });

  return r;
}
