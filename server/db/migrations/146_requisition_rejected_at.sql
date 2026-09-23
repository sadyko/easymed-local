-- STOCK_REQUEST_V1, разбор ревью (2026-09-23) — КОГДА ЗАЯВКУ ОТКЛОНИЛИ.
--
-- ЗАЧЕМ. Автозаявка по минимуму (rpc/stock-requests.js) подаётся, как только
-- остаток на руках ниже минимума и открытой автозаявки нет. Кладовщик
-- отклоняет её обычно по одной причине — на складе пусто, — и без этой колонки
-- следующее же списание подало бы ту же заявку снова: кладовщику шла бы
-- заявка за заявкой на товар, которого нет. Правило: в тот же день клиники,
-- когда автозаявку отклонили, новая на тот же товар тому же держателю не
-- подаётся.
--
-- ПОЧЕМУ ТРИГГЕР. Отклоняет экран «Заявки» прямой записью status='rejected'
-- через реестр (views/inventory-docs.js), а не вызовом сервера. Время ставит
-- база — при любом пути, которым заявка стала отклонённой.
--
-- Колонка только для сервера: в реестр (schema-registry.js) не выносится, в
-- обмен зданий не едет (заявки в SHIPPED нет вовсе).
-- migrate.js оборачивает файл в транзакцию — здесь BEGIN/COMMIT нет.

ALTER TABLE purchase_requisitions ADD COLUMN rejected_at TEXT;

CREATE TRIGGER IF NOT EXISTS trg_requisitions_rejected_at
AFTER UPDATE OF status ON purchase_requisitions
WHEN NEW.status = 'rejected' AND OLD.status IS NOT 'rejected'
BEGIN
  UPDATE purchase_requisitions
     SET rejected_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
   WHERE id = NEW.id;
END;
