-- AI_OWN_KEY_V1 (2026-11-18) — свой ключ OpenAI клиники и выключатели функций ИИ.
--
-- Владелец: «first permission to use this block from settings.easymed.uz/cp, then key
-- putting mirror should be opened with functions … Meta answering, analyzing call record
-- and so on». То есть: модуль `ai` по-прежнему выдаёт вендор (лицензия), а уже на
-- открывшемся экране клиника вводит СВОЙ ключ OpenAI и включает функции по одной.
--
-- openai_key_sealed — ключ, зашифрованный ключом клиники (api/secret-box.js, тот же
--   .api-secrets-key, что у токенов Meta): в копии базы ключа не прочесть.
-- openai_key_tail   — последние 4 знака, чтобы экран показал, какой ключ стоит.
-- openai_model      — модель ChatGPT; пусто — по умолчанию (gpt-4o-mini).
-- features          — JSON { telegram, meta_dm, meta_comment }: false — функция выключена.
--   Нет ключа — функция ВКЛЮЧЕНА: до этой миграции ИИ отвечал во всех каналах, и
--   обновление этого не меняет.
--
-- Номер 291, а не 288: в GitHub main уже есть 287–290 (ветка ИИ пока на своём 287,
-- он переименуется при следующем слиянии с main).
ALTER TABLE ai_settings ADD COLUMN openai_key_sealed TEXT NOT NULL DEFAULT '';
ALTER TABLE ai_settings ADD COLUMN openai_key_tail TEXT NOT NULL DEFAULT '';
ALTER TABLE ai_settings ADD COLUMN openai_model TEXT NOT NULL DEFAULT '';
ALTER TABLE ai_settings ADD COLUMN features TEXT NOT NULL DEFAULT '{}';
