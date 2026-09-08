-- 112_title_sheet_form003.sql — FORM_003_V1: титульный лист по форме 003.
--
-- Владелец: «we need to adapt the title list … please as a4 list» — бланк
-- «Беморнинг тиббий баённомаси» (приказ Минздрава РУз № 777 от 25.12.2017).
-- У бланка есть три строки, которых на листе не было:
--
--   mobility     — строка 6, «Беморни олиб юриш турлари»: аравачада (на
--                  коляске) / замбилда (на носилках) / ўзи юра олади (ходит сам);
--   delivered_by — строка 8, «Қандай транспортда» (каким транспортом доставлен);
--   since_onset  — строка 8, «Касаллик бошлангандан сўнг ўтган вақт» (сколько
--                  прошло от начала болезни / травмы).
--
-- Только ADD COLUMN — пересборки нет (урок 1.1.0).
ALTER TABLE admission_title_sheets ADD COLUMN mobility     TEXT NOT NULL DEFAULT '' CHECK (mobility IN ('', 'wheelchair', 'stretcher', 'walks'));
ALTER TABLE admission_title_sheets ADD COLUMN delivered_by TEXT NOT NULL DEFAULT '';
ALTER TABLE admission_title_sheets ADD COLUMN since_onset  TEXT NOT NULL DEFAULT '';
