// EASYPHONE_V1 (2026-09-17) — ОТДЕЛЬНАЯ ПРОГРАММА ДЛЯ ТЕЛЕФОНИИ.
//
// Владелец: «can we create a separate programm for calling and recieving calls
// from the providers … remove calling from the easymed. but leave the cards and
// the audios only … which can be started and used as similar to easymed but in
// the different port».
//
// ЧТО ЭТО. Второй сервер той же установки: своё окно, свой порт (8020), своя
// страница. Рабочее место оператора колл-центра — набор, журнал звонков,
// записи разговоров, видно кто звонит прямо сейчас.
//
// ПОЧЕМУ ВНУТРИ EASYMED, А НЕ ОТДЕЛЬНОЙ УСТАНОВКОЙ. Клинике не нужна вторая
// установка, второе обновление и второй ярлык «поставьте ещё вот это». Это
// ОТДЕЛЬНАЯ ПРОГРАММА по всему, что видит человек (своё окно, свой адрес, свой
// вход), и часть одной поставки по тому, что видит клиника: обновляется вместе
// со всем остальным, чинится одним обновлением.
//
// БАЗА ОДНА. Звонки, заявки и пациенты живут в базе клиники, и второй копии у
// них быть не может: иначе карточка в EasyMed и звонок в EasyPhone разъедутся
// уже к вечеру. Поэтому EasyPhone читает и пишет ТУ ЖЕ базу — и EasyMed
// продолжает показывать карточки и записи, как владелец и просил.
//
// ВХОД ОБЩИЙ. Сессия хранится в cookie, а cookie в браузере не различает порты:
// кто вошёл в EasyMed, тот уже вошёл и сюда. Своего пароля у этой программы
// нет и заводить его нельзя — это была бы вторая учётная запись на того же
// человека.
//
// ЧЕГО ЭТА ПРОГРАММА ПОКА НЕ УМЕЕТ, и это надо знать заранее: говорить в окне.
// Чтобы принять звонок В ПРОГРАММЕ, она должна сама стать телефоном (SIP через
// браузер), а для этого нужны данные подключения, которых onlinePBX по
// программному доступу не отдаёт. Сегодня трубку снимает аппарат оператора —
// станция звонит ему первой, как и в amoCRM.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

import { openDb } from '../server/db/connection.js';
import { attachUser, requireAuth } from '../server/middleware/auth.js';
import { hasAnyRole } from '../server/services/roles.js';
import { dialCall, candidateExtensions, dialProvider } from '../server/services/telephony/dial.js';
import { pbxCall } from '../server/services/telephony/onlinepbx.js';
import { getProviderRow, pbxOptions, providerConfig, listProviders } from '../server/services/telephony/providers.js';
import { telephonyCallRecording } from '../server/services/rpc/telephony.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// Кто вправе работать в этой программе. Тот же список, что у кнопки «Позвонить»
// в EasyMed: одно правило на обе двери, а не два расходящихся.
const PHONE_ROLES = ['admin', 'registrar', 'callcenter'];

function requirePhoneRole(req, res, next) {
  if (!hasAnyRole(req.user, PHONE_ROLES)) {
    return res.status(403).json({ error: { code: 'forbidden', message: 'Программа телефонии доступна регистратуре и колл-центру.' } });
  }
  next();
}

export function createPhoneApp(db) {
  const app = express();
  app.use(express.json({ limit: '64kb' }));
  app.use(attachUser(db));

  // --- кто я и чем звоню --------------------------------------------------
  app.get('/api/me', requireAuth, requirePhoneRole, (req, res) => {
    const me = db.prepare('SELECT id, full_name, pbx_extension FROM users WHERE id = ?').get(req.user.id) || {};
    const via = dialProvider(db);
    res.json({
      id: me.id, full_name: me.full_name || '', extension: me.pbx_extension || '',
      line: via ? via.kind : null,
      // Живые трубки из журнала — из них оператор выбирает свою, если не знает
      // номера наизусть.
      seen_extensions: candidateExtensions(db, 12),
    });
  });

  // Мой внутренний номер. Пишет ТОЛЬКО себе: чужую трубку назначать нельзя —
  // иначе звонок уйдёт от чужого имени, и разбор смены соврёт.
  app.post('/api/my-extension', requireAuth, requirePhoneRole, (req, res) => {
    const ext = String((req.body && req.body.extension) || '').trim();
    if (ext && !/^[0-9*#]{1,12}$/.test(ext)) {
      return res.status(400).json({ error: { code: 'bad_request', message: 'Внутренний номер — это цифры, не длиннее двенадцати.' } });
    }
    db.prepare('UPDATE users SET pbx_extension = ? WHERE id = ?').run(ext || null, req.user.id);
    res.json({ ok: true, extension: ext });
  });

  // Список внутренних номеров у самой станции — чтобы выбирать из настоящего,
  // а не вспоминать.
  app.get('/api/extensions', requireAuth, requirePhoneRole, async (req, res) => {
    const line = (listProviders(db) || []).find((p) => p.enabled && p.kind === 'onlinepbx');
    if (!line) return res.json({ extensions: [] });
    const row = getProviderRow(db, line.id);
    const r = await pbxCall(providerConfig(row).domain, 'user/get.json', {}, pbxOptions(db, row));
    const list = r.ok && Array.isArray(r.data)
      ? r.data.filter((u) => u && u.enabled !== false).map((u) => String(u.num))
      : [];
    res.json({ extensions: list, error: r.ok ? '' : (r.comment || r.reason || '') });
  });

  // --- позвонить -----------------------------------------------------------
  app.post('/api/dial', requireAuth, requirePhoneRole, async (req, res) => {
    const me = db.prepare('SELECT pbx_extension FROM users WHERE id = ?').get(req.user.id) || {};
    const r = await dialCall(db, { extension: me.pbx_extension || '', phone: (req.body && req.body.phone) || '' });
    if (!r.ok) return res.status(400).json({ error: { code: 'telephony', message: r.message } });
    res.json(r);
  });

  // --- журнал --------------------------------------------------------------
  // Один запрос на весь экран: последние звонки с именем пациента и именем
  // оператора (по внутреннему номеру). Экран телефониста обновляет его каждые
  // несколько секунд, поэтому лишних запросов быть не должно.
  app.get('/api/calls', requireAuth, requirePhoneRole, (req, res) => {
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
    res.json({
      calls: db.prepare(`
        SELECT c.id, c.started_at, c.call_type, c.external_number, c.internal_number,
               c.waitsec, c.billsec, c.disposition, c.recording_url,
               p.full_name AS patient_name, p.mrn AS patient_mrn,
               u.full_name AS operator_name
          FROM calls c
          LEFT JOIN patients p ON p.id = c.patient_id
          LEFT JOIN users u ON u.pbx_extension IS NOT NULL AND u.pbx_extension <> ''
                           AND u.pbx_extension = c.internal_number
         ORDER BY c.started_at DESC, c.id DESC
         LIMIT ?`).all(limit),
    });
  });

  app.get('/api/recording', requireAuth, requirePhoneRole, async (req, res) => {
    try {
      const r = await telephonyCallRecording(db, { call_id: Number(req.query.call_id) }, req.user);
      res.json(r);
    } catch (e) {
      res.status(e.status || 500).json({ error: { code: 'telephony', message: e.message } });
    }
  });

  // Страница программы.
  app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));
  app.get('/', (req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));
  return app;
}

// Запуск отдельным процессом: node phone/index.js
if (process.argv[1] && process.argv[1].endsWith(path.join('phone', 'index.js'))) {
  const dataDir = process.env.EASYMED_DATA || path.join(path.dirname(ROOT), 'data');
  const db = openDb(path.join(dataDir, 'easymed.db'));
  const port = Number(process.env.EASYPHONE_PORT) || 8020;
  createPhoneApp(db).listen(port, () => {
    console.log('EasyPhone — рабочее место телефонии');
    console.log('  На этом компьютере:  http://localhost:' + port);
  });
}
