-- ROOMS_WARDS_DEPT_V1 — кабинеты и палаты принадлежат ОТДЕЛУ.
--
-- Владелец: «we should be able to create another departments and add rooms and
-- doctors to them». Врачи к отделу уже привязаны (users.department_id), а
-- кабинеты и палаты — нет: у них был только этаж.
--
-- Экран настроек кабинетов при этом УЖЕ показывал колонку «Отдел» и поле
-- выбора: разметка была написана (ROOMS_DEPT_FLOOR_V1), а колонки в таблице не
-- завели. Колонка стояла пустой у каждого кабинета, а выбранный отдел
-- сохранить было некуда — реестр такого поля не знал и молча его отбрасывал.
--
-- Ссылка НЕ каскадная: удаление отдела не должно уносить кабинет вместе с
-- расписанием и визитами, которые на него ссылаются. Кабинет остаётся без
-- отдела — это видно в списке и чинится выбором другого.
ALTER TABLE rooms ADD COLUMN department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL;
ALTER TABLE wards ADD COLUMN department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL;

-- Заметка к кабинету: поле в разметке тоже было, а колонки не было.
ALTER TABLE rooms ADD COLUMN notes TEXT;

CREATE INDEX IF NOT EXISTS idx_rooms_department ON rooms(department_id);
CREATE INDEX IF NOT EXISTS idx_wards_department ON wards(department_id);
