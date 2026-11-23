// AI_OWN_KEY_V1 — миграция 295 (на ветке local/ai-on-main была 291): свой ключ OpenAI и выключатели функций ИИ.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

test('295 AI_OWN_KEY_V1: ключа нет, модель по умолчанию, функции не выключены', () => {
  const db = openDb(':memory:');
  migrate(db);
  const r = db.prepare('SELECT openai_key_sealed, openai_key_tail, openai_model, features FROM ai_settings WHERE id = 1').get();
  assert.deepEqual(r, { openai_key_sealed: '', openai_key_tail: '', openai_model: '', features: '{}' });
  db.close();
});
