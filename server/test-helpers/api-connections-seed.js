// CLINIC_API_STEP7_V1 — стенд подключений API: администратор «Босс», «Компания»
// с латинским названием и полным адресом для партнёров (решение владельца 11),
// свой файл ключа шифрования во временной папке.
import path from 'node:path';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { tmpDir } from './tmpdir.js';
import { KEK_FILE } from '../services/api/secret-box.js';
import { __clearDraftsForTests } from '../services/api/drafts.js';
import { actorOf } from '../services/api/connections.js';

export function seed({ db = null, kekPath = null } = {}) {
  __clearDraftsForTests();
  const base = db || openDb(':memory:');
  if (!db) migrate(base);
  base.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (1, 'boss', 'x', 'Босс', 'admin')").run();
  base.prepare(`UPDATE doc_settings SET clinic_name = 'Шифо', name_en = 'Shifo Clinic', region_code = 'tashkent-city',
    district_code = 'yunusobod', street_ru = 'ул. Мира, 1' WHERE id = 1`).run();
  return { db: base, actor: actorOf(base, { id: 1 }), kekPath: kekPath || path.join(tmpDir('em-apic-'), KEK_FILE) };
}
export const PARTNER = Object.freeze({ kind: 'partner', name: 'med24.uz', site_url: 'https://med24.uz', contact: 'Отдел партнёров',
  scopes: ['clinic', 'doctors', 'services', 'slots', 'requests', 'appointments'],
  webhook_url: 'https://med24.uz/hooks', webhook_events: ['request.accepted'] });
