-- Откат миграции 20260928120000_foundation.sql (после отката core).
--
-- Только для локальной разработки и проверки в CI (up → down → up); удаляет данные.
-- Роль bayramm_api не удаляется: она общая для кластера, а на staging/production
-- у неё есть пароль, выданный вне репозитория.

drop schema if exists pii cascade;
drop schema if exists app cascade;
