// RPC_PORT_V1 (доводка) — «Мой профиль» врача сохраняется одним вызовом
// update_my_doctor_profile, и экран не врёт о том, что сохранил.
//
// Было: после RPC экран сам писал user_specialties и doctor_conditions через
// /api/db. Реестр пускает в user_specialties только admin, а оба insert несли
// company_id, которого среди колонок реестра нет, — «Не удалось сохранить» у
// всех. Поля публичного профиля (биография, образование, соцсети, фото) офлайн
// не хранятся вовсе, а экран говорил «Профиль сохранён».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STRINGS } from '../i18n-strings.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(HERE, '..', 'views', 'doctor-profile.js'), 'utf8');

export const NOT_STORED_MSG = 'Профиль сохранён. Биография, образование, соцсети и фото в офлайн-версии не хранятся.';

test('специальности и болезни уходят в RPC, прямых записей в таблицы нет', () => {
    assert.ok(!/from\('user_specialties'\)\s*\.(delete|insert|update)/.test(src), 'экран всё ещё пишет user_specialties сам');
    assert.ok(!/from\('doctor_conditions'\)\s*\.(delete|insert|update)/.test(src), 'экран всё ещё пишет doctor_conditions сам');
    assert.match(src, /rpc\('update_my_doctor_profile', \{ p, specialties, conditions \}\)/, 'наборы передаются в том же вызове');
});

test('not_stored — честное сообщение, а не «Профиль сохранён»', () => {
    assert.match(src, /not_stored/, 'ответ RPC про не сохранённые поля не читается');
    assert.ok(src.includes("'" + NOT_STORED_MSG + "'"), 'нет сообщения о полях, которые офлайн не хранятся');
    const e = STRINGS[NOT_STORED_MSG];
    assert.ok(e && e.ru && e.uz && e.en, 'сообщению нужен перевод в i18n-strings.js');
});

test('без медкор-каталога список специальностей берётся из канона, а сбой фото не валит сохранение', () => {
    assert.match(src, /SPECIALTY_ROWS/, 'офлайн каталог gw пуст — нужен канонический список');
    assert.match(src, /try \{ photoUrl = await uploadPendingPhoto\(\); \}/, 'сбой загрузки фото не должен останавливать сохранение');
});

test('M7b: строка специальности без слага узнаётся по каноническому имени, пустые слаги не уходят на сервер', () => {
    assert.match(src, /r\.specialty_slug \|\| slugOfName\(r\.name_ru\)/);
    assert.match(src, /st\.specSlugs\.filter\(Boolean\)\.slice\(0, 4\)/);
});
