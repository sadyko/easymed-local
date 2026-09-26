// DOCTOR_PUBLIC_PROFILE_V1 (мигр. 159) — колонки публичного профиля врача в users.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { PROFILE_KEYS } from '../../services/rpc/doctor-profile.js';

test('159: каждая колонка белого списка профиля есть; списки по умолчанию — пустой JSON', () => {
  const db = openDb(':memory:');
  try {
    migrate(db);
    const cols = new Set(db.prepare('PRAGMA table_info(users)').all().map((c) => c.name));
    for (const k of PROFILE_KEYS) assert.ok(cols.has(k), 'нет users.' + k);
    db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('d', 'x', 'doctor')").run();
    const u = db.prepare("SELECT education_entries, prof_dev_entries, bio_ru, experience_years FROM users WHERE username = 'd'").get();
    assert.deepEqual(u, { education_entries: '[]', prof_dev_entries: '[]', bio_ru: null, experience_years: null });
  } finally { db.close(); }
});
