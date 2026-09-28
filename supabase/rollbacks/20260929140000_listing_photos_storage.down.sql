-- Откат миграции 20260929140000_listing_photos_storage.sql.
--
-- Только для локальной разработки и проверки в CI (up → down → up): удаляет
-- бакет вместе с объектами. На staging/production откат — новая миграция
-- «вперёд»; объекты в Storage удаляются через Storage API, не SQL.

-- ── app.photos как в миграции 2 ─────────────────────────────────────────────
drop index if exists app.photos_storage_key_uq;
alter table app.photos drop constraint if exists photos_ready_file;
alter table app.photos drop constraint if exists photos_storage_key_format;
alter table app.photos drop constraint if exists photos_bytes_check;
alter table app.photos add constraint photos_bytes_check check (bytes between 1 and 20971520);

alter table app.photos add column public_prefix text check (length(public_prefix) between 1 and 300);
-- Готовым фото прежняя схема требует public_prefix: ставим ключ объекта
update app.photos set public_prefix = storage_key where status = 'ready';
alter table app.photos add constraint photos_check check (status <> 'ready' or public_prefix is not null);
grant update (public_prefix) on app.photos to bayramm_api;

comment on table app.photos is null;
comment on column app.photos.storage_key is null;
comment on column app.photos.sha256 is null;

create or replace function app.photos_guard() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor app.actor_kind := app.effective_actor();
  v_count int;
begin
  if tg_op = 'INSERT' then
    -- блокируем листинг, чтобы параллельные загрузки не превысили лимит
    perform 1 from app.listings l where l.id = new.listing_id for update;
    select count(*) into v_count from app.photos p where p.listing_id = new.listing_id and p.deleted_at is null;
    if v_count >= coalesce(app.setting_int('max_photos'), 10) then
      raise exception 'too_many_photos' using errcode = 'BR011';
    end if;
    if v_actor = 'vendor_user' and (new.status <> 'uploading' or new.moderation <> 'pending') then
      raise exception 'forbidden_for_actor' using errcode = 'BR003';
    end if;
    new.uploaded_by := app.actor_id();
    new.moderated_by := null;
    new.moderated_at := null;
    new.deleted_at := null;
    new.created_at := now();
    return new;
  end if;

  if new.id <> old.id or new.listing_id <> old.listing_id or new.storage_key <> old.storage_key
     or new.created_at <> old.created_at or new.uploaded_by is distinct from old.uploaded_by
     or (old.deleted_at is not null and new.deleted_at is distinct from old.deleted_at) then
    raise exception 'immutable_column' using errcode = 'BR006';
  end if;
  if v_actor = 'vendor_user'
     and (new.status, new.moderation, new.public_prefix, new.mime, new.bytes, new.width, new.height,
          new.sha256, new.failure_reason, new.processed_at, new.moderated_by, new.moderated_at)
         is distinct from
         (old.status, old.moderation, old.public_prefix, old.mime, old.bytes, old.width, old.height,
          old.sha256, old.failure_reason, old.processed_at, old.moderated_by, old.moderated_at) then
    raise exception 'forbidden_for_actor' using errcode = 'BR003';
  end if;
  if new.moderation is distinct from old.moderation then
    new.moderated_at := now();
    new.moderated_by := case when v_actor = 'staff' then app.actor_id() end;
  end if;
  return new;
end $$;

-- ── бакет ───────────────────────────────────────────────────────────────────
-- Storage запрещает удалять строки своих таблиц SQL-ом (чтобы не расходились
-- база и файлы); для локального отката разрешаем на время сеанса psql
select set_config('storage.allow_delete_query', 'true', false);
delete from storage.objects where bucket_id = 'listing-photos';
delete from storage.buckets where id = 'listing-photos';
