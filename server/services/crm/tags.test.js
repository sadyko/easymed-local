// CRM_HEAD_MERGE_TAGS_V1 (2026-09-25) — метки CRM: справочник в «Настройки →
// CRM-канбан», отчёт колл-центра «По меткам» и объединение меток при слиянии.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { saveTags, listTags, crmConfig, saveConfig, CrmConfigError } from './config.js';
import { crmConfigSave } from '../rpc/crm-config.js';
import { callcenterReport } from '../rpc/callcenter.js';
import { crmMergeLeads } from '../rpc/crm-merge.js';

const ADMIN = { id: 1, role: 'admin', extra_roles: [] };
const REG = { id: 2, role: 'registrar', extra_roles: [] };

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (1,'a','x','Админ','admin'), (2,'r','x','Регистратор','registrar')").run();
  return db;
}

test('saveTags: целым списком, порядок — позиция, цвет из токенов, пустой список допустим', () => {
  const db = fresh();
  try {
    const out = saveTags(db, [
      { key: 'vip', label: ' VIP ', color: 'purple' },
      { key: 'Repeat', label: 'Повторный', color: 'none', is_active: false },
    ]);
    assert.deepEqual(out, [
      { key: 'vip', label: 'VIP', color: 'purple', position: 1, is_active: true },
      { key: 'repeat', label: 'Повторный', color: '', position: 2, is_active: false },
    ]);
    assert.deepEqual(crmConfig(db).tags, out, 'доска и экран настроек не получают меток одним вызовом');
    assert.throws(() => saveTags(db, [{ key: 'x', label: 'X', color: '#f00' }]), CrmConfigError);
    assert.throws(() => saveTags(db, [{ key: 'bad key', label: 'X', color: '' }]), CrmConfigError);
    assert.throws(() => saveTags(db, [{ key: 'a', label: 'A' , color: ''}, { key: 'a', label: 'B', color: '' }]), /повторяется/);
    assert.throws(() => saveTags(db, [{ key: 'a', label: '  ', color: '' }]), CrmConfigError);
    assert.deepEqual(saveTags(db, []), [], 'клинике без меток не дали их убрать');
  } finally { db.close(); }
});

test('saveTags: метку на карточках удалить нельзя (409) — только скрыть', () => {
  const db = fresh();
  try {
    saveTags(db, [{ key: 'vip', label: 'VIP', color: 'purple' }, { key: 'spare', label: 'Запасная', color: '' }]);
    const rid = db.prepare("INSERT INTO crm_requests (full_name, phone) VALUES ('Лид', '901')").run().lastInsertRowid;
    db.prepare("INSERT INTO crm_request_tags (request_id, tag_key) VALUES (?, 'vip')").run(rid);
    assert.throws(() => saveTags(db, [{ key: 'spare', label: 'Запасная', color: '' }]),
      (e) => e instanceof CrmConfigError && e.status === 409 && /только скрыть/.test(e.message));
    assert.equal(listTags(db).length, 2, 'отказ всё-таки что-то удалил');
    const hidden = saveTags(db, [{ key: 'vip', label: 'VIP', color: 'purple', is_active: false }]);
    assert.deepEqual(hidden.map((t) => [t.key, t.is_active]), [['vip', false]], 'неиспользуемую метку не удалось удалить или используемую — скрыть');
  } finally { db.close(); }
});

test('crm_config_save { tags } — только администратору; ответ — вся конфигурация', () => {
  const db = fresh();
  try {
    assert.throws(() => crmConfigSave(db, { tags: [{ key: 'vip', label: 'VIP', color: 'ok' }] }, REG), (e) => e.status === 403);
    const out = crmConfigSave(db, { tags: [{ key: 'vip', label: 'VIP', color: 'ok' }] }, ADMIN);
    assert.equal(out.tags.length, 1);
    assert.ok(Array.isArray(out.stages) && out.stages.length, 'ответ сохранения меток без остальной конфигурации');
    assert.throws(() => crmConfigSave(db, { tags: [{ key: 'vip', label: '', color: 'ok' }] }, ADMIN), (e) => e.status === 400);
    // Сохранение меток не трогает колонки и источники.
    const before = crmConfig(db);
    saveConfig(db, { tags: [] });
    assert.deepEqual(crmConfig(db).stages, before.stages);
  } finally { db.close(); }
});

test('отчёт колл-центра «По меткам»: заявки периода с каждой меткой и сколько дошло', () => {
  const db = fresh();
  try {
    saveTags(db, [{ key: 'vip', label: 'VIP', color: 'purple' }, { key: 'repeat', label: 'Повторный', color: 'teal' }]);
    const add = (status, tags, at = '2026-08-17T07:00:00Z') => {
      const id = db.prepare('INSERT INTO crm_requests (full_name, phone, status, created_at) VALUES (?,?,?,?)').run('Лид', '901', status, at).lastInsertRowid;
      for (const t of tags) db.prepare('INSERT INTO crm_request_tags (request_id, tag_key) VALUES (?,?)').run(id, t);
    };
    add('came', ['vip', 'repeat']);
    add('in_process', ['vip']);
    add('came', []);
    add('came', ['vip'], '2026-07-01T07:00:00Z');   // вне периода
    const r = callcenterReport(db, { from: '2026-08-10', to: '2026-08-20' }, ADMIN);
    assert.deepEqual(r.byTag.map((x) => [x.key, x.name, x.count, x.came, x.came_pct]),
      [['vip', 'VIP', 2, 1, 50], ['repeat', 'Повторный', 1, 1, 100]]);
    assert.equal(r.byTag[0].color, 'purple');
  } finally { db.close(); }
});

test('слияние объединяет метки: у оставшейся — все метки всех карточек, без повторов', () => {
  const db = fresh();
  try {
    saveTags(db, [{ key: 'vip', label: 'VIP', color: 'purple' }, { key: 'repeat', label: 'Повторный', color: 'teal' }, { key: 'x', label: 'Икс', color: '' }]);
    const mk = (tags) => {
      const id = Number(db.prepare("INSERT INTO crm_requests (full_name, phone) VALUES ('Лид', '901112233')").run().lastInsertRowid);
      for (const t of tags) db.prepare('INSERT INTO crm_request_tags (request_id, tag_key) VALUES (?,?)').run(id, t);
      return id;
    };
    const a = mk(['vip']);
    const b = mk(['vip', 'repeat']);
    const c = mk(['x']);
    crmMergeLeads(db, { keep_id: a, merge_ids: [b, c] }, ADMIN);
    assert.deepEqual(db.prepare('SELECT tag_key FROM crm_request_tags WHERE request_id = ? ORDER BY tag_key').all(a).map((r) => r.tag_key), ['repeat', 'vip', 'x']);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM crm_request_tags').get().n, 3, 'у влитых карточек остались метки');
    const snap = JSON.parse(db.prepare('SELECT snapshot FROM crm_merge_log').get().snapshot);
    assert.deepEqual(snap.merged.find((m) => m.id === b).tags, ['repeat', 'vip']);
  } finally { db.close(); }
});
