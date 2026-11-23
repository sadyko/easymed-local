import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { createTelegramAiLead } from './lead.js';

test('заявка ИИ из Telegram: новая карточка, затем — в ту же открытую', () => {
  const db = openDb(':memory:');
  migrate(db);
  const a = createTelegramAiLead(db, { chatId: '100', phone: '+998 90 111 22 33', name: 'Алишер', wish: 'УЗИ щитовидной' });
  const row = db.prepare('SELECT full_name, phone, source, note FROM crm_requests WHERE id = ?').get(a.crm_request_id);
  assert.equal(row.full_name, 'Алишер');
  assert.equal(row.source, 'telegram');
  assert.match(row.note, /Создано ИИ/);
  assert.match(row.note, /УЗИ щитовидной/);
  const b = createTelegramAiLead(db, { chatId: '100', phone: '+998 90 111 22 33', name: 'Алишер', wish: 'и анализы' });
  assert.equal(b.crm_request_id, a.crm_request_id, 'тот же номер — та же открытая карточка');
  assert.equal(b.merged, true);
  assert.match(db.prepare('SELECT note FROM crm_requests WHERE id = ?').get(a.crm_request_id).note, /и анализы/);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM crm_requests').get().c, 1);
});
