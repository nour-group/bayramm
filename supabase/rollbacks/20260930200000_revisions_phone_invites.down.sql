-- Откат 20260930200000_revisions_phone_invites.sql: оповещение команды о правке
-- карточки от партнёра и приглашение сотрудника по телефону. Уже созданные
-- приглашения и строки outbox остаются (сотрудники — данные, а не схема).

drop function if exists app.staff_invite_phone(bytea, text, app.staff_role);
drop trigger if exists listing_revisions_notify on app.listing_revisions;
drop function if exists app.listing_revisions_notify();
drop function if exists app.enqueue_staff_alert(text, app.staff_role[], jsonb, text);
