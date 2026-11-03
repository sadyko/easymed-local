-- REFERRAL_LINE_V1 · DOCTOR_REFERRAL_DESK_V1 (мигр. 270, 2026-11-02, выпуск 3.21.0).
--
-- НАПРАВИВШИЙ — ПРИЗНАК СТРОКИ, А НЕ ТОЛЬКО ВИЗИТА. До сих пор направивший был у
-- визита (visits.referral_source_id, иначе у карточки пациента), и ensure_visit ставил
-- его только при СОЗДАНИИ визита: врач направил пациента на УЗИ в день, когда у того
-- уже был визит (его собственная консультация), — направивший молча терялся (dev:
-- врач №18, 4 выставленные строки, бонус 0). Решение владельца 2026-11-02 — «бонус
-- обоим»: партнёр, приведший пациента, получает своё, врач, направивший на услугу, —
-- своё за строки, на которые направил.
--
--   visit_services.referred_by_source_id — внутренний источник направившего врача (или
--     источник «Кто направил» стойки). Ставит СЕРВЕР (domain/line-referral.js через штамп
--     реестра); через /api/db браузер его не пишет ни вставкой, ни правкой. Пусто — у всех
--     строк до этой миграции: прошлые строки не дозаполняются (закрытые месяцы не двигаются).
--     Без ON DELETE: источники не удаляют, их выключают (active = 0).
--   visit_services.referral_note — «Рекомендация для регистратуры» из мастера направления
--     врача (натощак, к какому часу…). Не длиннее 500 знаков (CHECK — запасной замок).
--   recommended_services.visit_service_id — строка, которой рекомендацию закрыли
--     (referral_recommendation_attach). «Реферирование → Внутренние врачи» считает такую
--     строку той же рекомендацией, а не вторым направлением. Пишет только сервер.
--
-- По филиалам ничего нового не ездит (branch-sync/journal.js SHIPPED): id источника у
-- соседа другой, а вознаграждение считает здание, выставившее счёт.
ALTER TABLE visit_services ADD COLUMN referred_by_source_id INTEGER REFERENCES referral_sources(id);
ALTER TABLE visit_services ADD COLUMN referral_note TEXT CHECK (referral_note IS NULL OR length(referral_note) <= 500);
CREATE INDEX idx_visit_services_referred_by ON visit_services(referred_by_source_id) WHERE referred_by_source_id IS NOT NULL;
ALTER TABLE recommended_services ADD COLUMN visit_service_id INTEGER REFERENCES visit_services(id) ON DELETE SET NULL;
CREATE INDEX idx_recommended_services_vs ON recommended_services(visit_service_id) WHERE visit_service_id IS NOT NULL;
