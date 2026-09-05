-- 100_cross_branch_calendar.sql — CROSS_BRANCH_CALENDAR_V1: «видеть и записывать
-- в любой филиал» (решение владельца 2026-09-05, Задача 6).
--
-- ─── ЧТО БЫЛО СЛОМАНО ───────────────────────────────────────────────────────
--
-- Календарь (099) показывает записи ТОЛЬКО своего здания: `.is('sync_origin',
-- null)`. Снять этот фильтр было нельзя, и упиралось всё в одну строку
-- branch-sync/journal.js:
--
--   SHIPPED.visits = visit_date, duration_minutes, visit_kind, visit_type,
--                    status, notes
--
-- doctor_id там нет НАМЕРЕННО: локальный id врача указывал бы у соседа в
-- пустоту (миграция 083 — id у каждой установки свои). Значит чужая запись
-- приезжала БЕЗ ВРАЧА и падала в дорожку «Не назначено» — бесполезно, когда
-- колонки сетки это врачи.
--
-- Со Фазы 3 сотрудники ездят справочником (catalogue.js, миграция 086) с
-- ЕСТЕСТВЕННЫМ КЛЮЧОМ `users.username`: один человек — один логин в любом
-- здании. Поэтому врача можно повезти ССЫЛКОЙ ПО ЛОГИНУ — ровно так же, как
-- visit_services.service_id едет кодом услуги (CODE_REFS). Это решение принято
-- в journal.js; здесь — та половина, без которой оно не работает.
--
-- ─── ПОЧЕМУ ТРИГГЕР ПЕРЕСОЗДАЁТСЯ (и почему это не «пересборка таблицы») ────
--
-- visits_journal_upd (084) перечисляет колонки, изменение которых считается
-- сетевой правкой. Список обязан совпадать с SHIPPED ∪ REFS ∪ CODE_REFS —
-- это договор, и его стережёт тест «дрейф: список колонок в триггере и список
-- отправляемых колонок — одно и то же» (branch-sync/journal.test.js). Обе
-- половины дрейфа молчаливы:
--
--   • колонка едет, но её нет в триггере → правка ТОЛЬКО этой колонки не даёт
--     записи в журнал вовсе, и врач, переназначенный мышью в сетке, у соседа
--     остаётся прежним НАВСЕГДА;
--   • колонка в триггере, но не едет → каждое её касание поднимает строку в
--     сеть ради поля, которого сосед не увидит.
--
-- Поэтому вместе с doctor_id и booked_at в SHIPPED/CODE_REFS триггер
-- обязан быть пересоздан ЗДЕСЬ, в той же миграции. DROP TRIGGER + CREATE
-- TRIGGER — это правка sqlite_master, а НЕ пересборка таблицы: ни одной строки
-- visits оно не читает и не пишет, ни один INSERT/UPDATE/DELETE не выполняется,
-- и в sync_journal не появляется ни одной записи (проверяется 100.test.js
-- счётчиком до и после). Именно этого требует шапка 084: та её страшная часть
-- («каждая тронутая строка уедет соседям под свежими метками») про UPDATE и про
-- порядок из 12 шагов с INSERT ... SELECT, а не про замену текста триггера.
--
-- Текст ниже — КОПИЯ триггера из 084 с двумя добавленными колонками, а не
-- пересказ по памяти: 084 прямо требует «текстом из этого файла».
--
-- ─── ПОЧЕМУ booked_at ───────────────────────────────────────────────────────
--
-- «Кто записался первым» — единственный ответ на настоящее столкновение внутри
-- окна подтверждения (два оператора в двух зданиях занимают один слот в один и
-- тот же час, обмен-то часовой). Ответ обязан быть ОДИНАКОВЫМ в обоих зданиях,
-- иначе каждое считает победителем себя.
--
-- created_at для этого не годится, и это не мелочь: у ПРИЕХАВШЕЙ строки
-- created_at означает «когда МЫ её приняли» (шапка journal.js говорит это
-- прямо), то есть в здании A запись из B выглядит созданной позже любой своей —
-- и B считает ровно наоборот. booked_at ставится ОДИН РАЗ тем, кто записал, и
-- едет вместе с записью, поэтому обе стороны сравнивают одно и то же число.
--
-- TEXT NOT NULL DEFAULT '' — пустая строка у старых строк, и НИКАКОГО
-- бэкфилла: UPDATE по всей таблице visits это ровно то сетевое событие, от
-- которого предостерегает 084. Пустое значит «время записи неизвестно», и
-- разрешение столкновения падает на запасной ключ (буква здания, затем uid) —
-- он тоже одинаков у обеих сторон. Разбор — в services/rpc/calendar.js.
--
-- ─── ПОЧЕМУ cross_branch И cross_branch_seq ─────────────────────────────────
--
-- «Слот держится у обеих сторон, пока принимающее здание не подтвердило» —
-- требование владельца. Подтверждение УЖЕ ЕСТЬ и второго заводить нельзя:
-- sync_peers.sent_seq двигает ТОЛЬКО квитанция соседа (markConfirmed,
-- branch-sync/journal.js). Значит на записи надо хранить не «флаг
-- подтверждено», который кто-то должен не забыть снять, а ДВА факта:
--
--   cross_branch     — буква здания, ДЛЯ которого запись, когда это не мы.
--                      Пусто = запись своего здания (обычный случай).
--   cross_branch_seq — номер sync_journal той записи, которую это здание
--                      должно подтвердить.
--
-- И тогда «подтверждено» — это не колонка, а ВОПРОС К ГОРИЗОНТУ:
--   sent_seq(cross_branch) >= cross_branch_seq.
-- Ответ на него всегда свежий, его не надо чинить после сбоя, и он не может
-- разойтись с настоящим состоянием канала.
--
-- НИ ОДНА ИЗ ЭТИХ ДВУХ НЕ ЕЗДИТ. Это факты ОТПРАВИТЕЛЯ («мы записали в чужое
-- здание и ждём его квитанцию»), у принимающей стороны они бессмысленны: она
-- видит sync_origin = буква автора и знает, что запись — её работа. Поэтому их
-- нет ни в SHIPPED, ни в перечне триггера, и правка любой из них НЕ порождает
-- записи в журнале — то же свойство, что у service_id/room_id (099).
--
-- ─── ПОЧЕМУ room_id ПО-ПРЕЖНЕМУ НЕ ЕДЕТ ─────────────────────────────────────
--
-- Правило владельца: кабинеты — принадлежность здания. «Кабинет 5» соседа в
-- нашей базе означал бы случайную местную комнату или ничего, ровно как
-- users.room_id в справочнике (catalogue.js). Ось кабинетов остаётся местной, и
-- 099.test.js это пиняет; здесь мы этого не меняем.
--
-- ─── ПОЧЕМУ ЗДЕСЬ НЕТ НОВОГО ИНДЕКСА ────────────────────────────────────────
--
-- Единственный новый запрос — «какие записи видимого дня ещё не подтверждены»,
-- и он ВСЕГДА ограничен диапазоном visit_date, то есть уже берёт
-- idx_visits_date (099). Индекс по cross_branch добавил бы запись в B-дерево
-- на каждый визит клиники ради условия, которое верно у единиц строк, и
-- планировщик всё равно предпочёл бы диапазон по дате. Тот же довод, которым
-- 097 отказалась от своего частичного индекса.

ALTER TABLE visits ADD COLUMN booked_at        TEXT    NOT NULL DEFAULT '';
ALTER TABLE visits ADD COLUMN cross_branch     TEXT    NOT NULL DEFAULT '';
ALTER TABLE visits ADD COLUMN cross_branch_seq INTEGER NOT NULL DEFAULT 0;

-- Копия visits_journal_upd из 084_sync_journal.sql + booked_at и doctor_id.
DROP TRIGGER visits_journal_upd;
CREATE TRIGGER visits_journal_upd AFTER UPDATE ON visits
  BEGIN
    INSERT INTO sync_journal (tbl, uid, op, cols)
    SELECT 'visits', uid, 'put', cols FROM (
      SELECT r.uid AS uid, CASE WHEN OLD.uid IS NULL THEN '*' ELSE rtrim(
             CASE WHEN NEW.visit_date IS NOT OLD.visit_date THEN 'visit_date,' ELSE '' END ||
             CASE WHEN NEW.duration_minutes IS NOT OLD.duration_minutes THEN 'duration_minutes,' ELSE '' END ||
             CASE WHEN NEW.visit_kind IS NOT OLD.visit_kind THEN 'visit_kind,' ELSE '' END ||
             CASE WHEN NEW.visit_type IS NOT OLD.visit_type THEN 'visit_type,' ELSE '' END ||
             CASE WHEN NEW.status IS NOT OLD.status THEN 'status,' ELSE '' END ||
             CASE WHEN NEW.notes IS NOT OLD.notes THEN 'notes,' ELSE '' END ||
             CASE WHEN NEW.booked_at IS NOT OLD.booked_at THEN 'booked_at,' ELSE '' END ||
             CASE WHEN NEW.patient_id IS NOT OLD.patient_id THEN 'patient_id,' ELSE '' END ||
             CASE WHEN NEW.doctor_id IS NOT OLD.doctor_id THEN 'doctor_id,' ELSE '' END, ',') END AS cols
        FROM visits r WHERE r.id = NEW.id AND r.uid IS NOT NULL
    ) WHERE cols <> '';

    -- Авторство колонок — тем же условием, что и журнал, но БЕЗ срока годности
    -- (журнал вычищается, авторство остаётся). Одним запросом, а не по запросу
    -- на колонку: правка пациента не должна стоить двух десятков вставок.
    INSERT INTO sync_authored (tbl, uid, col, at)
    SELECT 'visits', r.uid, v.col, strftime('%Y-%m-%dT%H:%M:%fZ','now')
      FROM visits r
      JOIN (
            SELECT 'visit_date' AS col WHERE NEW.visit_date IS NOT OLD.visit_date
            UNION ALL SELECT 'duration_minutes' WHERE NEW.duration_minutes IS NOT OLD.duration_minutes
            UNION ALL SELECT 'visit_kind' WHERE NEW.visit_kind IS NOT OLD.visit_kind
            UNION ALL SELECT 'visit_type' WHERE NEW.visit_type IS NOT OLD.visit_type
            UNION ALL SELECT 'status' WHERE NEW.status IS NOT OLD.status
            UNION ALL SELECT 'notes' WHERE NEW.notes IS NOT OLD.notes
            UNION ALL SELECT 'booked_at' WHERE NEW.booked_at IS NOT OLD.booked_at
            UNION ALL SELECT 'patient_id' WHERE NEW.patient_id IS NOT OLD.patient_id
            UNION ALL SELECT 'doctor_id' WHERE NEW.doctor_id IS NOT OLD.doctor_id
           ) v
     WHERE r.id = NEW.id AND r.uid IS NOT NULL AND OLD.uid IS NOT NULL
    ON CONFLICT(tbl, uid, col) DO UPDATE SET at = excluded.at;
  END;
