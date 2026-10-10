-- Откат 20261011110000_vendor_user_invites.sql: без приглашения и удаления пользователей
-- кабинета функциями базы, без проверки владельца, без чата из известного об аккаунте и без
-- vendor.access_granted. Заполненные миграцией чаты и строки outbox остаются — это данные.
-- Только для локальной разработки и проверки в CI (up → down → up)

drop function if exists app.staff_remove_vendor_user(uuid);
drop function if exists app.staff_invite_vendor_user(uuid, bytea, text, text, text, app.locale);

drop trigger if exists vendor_users_bound on app.vendor_users;
drop function if exists app.vendor_users_bound();
drop function if exists app.enqueue_vendor_access_granted(uuid);
drop function if exists app.vendor_user_fill_telegram(uuid);

drop trigger if exists vendor_keep_owner_delete on app.vendor_users;
drop trigger if exists vendor_keep_owner on app.vendor_users;
drop function if exists app.vendor_keep_owner();
