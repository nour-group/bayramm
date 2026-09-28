-- ════════════════════════════════════════════════════════════════════════════
-- Миграция 3 — фото листингов в Supabase Storage.
--
--   · бакет listing-photos: публичное чтение, файл до 10 МБ, только WebP, JPEG
--     и PNG. Пишет в него только API ключом service_role через Storage API;
--     политик для anon/authenticated на storage.objects нет — из браузера и
--     Data API в бакет не записать;
--   · фото готовит браузер (длинная сторона ≤ 2560, перекодирование, без
--     EXIF), API проверяет байты (формат, размеры, отсутствие метаданных) и
--     кладёт объект. Варианты по ширине отдаёт воркер media (apps/media) через
--     Cloudflare Image Transformations — хранится один оригинал;
--   · в app.photos — только ключ объекта и его свойства. public_prefix (адрес
--     вариантов в R2 из первоначального плана) больше не нужен;
--   · ключ: listings/<listing_id>/<uuid>.<webp|jpg|png> — объект лежит под
--     своим листингом, одна строка — один объект;
--   · «готово» (ready) = файл проверен сервером и лежит в хранилище: известны
--     тип, размер, ширина, высота и sha256. Ставит его system, а не вендор
--     (photos_guard) — правила публикации не меняются.
--
-- Откат: supabase/rollbacks/20260929120000_listing_photos_storage.down.sql
-- ════════════════════════════════════════════════════════════════════════════

-- ── бакет ───────────────────────────────────────────────────────────────────
-- Декларативно: повторный прогон приводит настройки к этим значениям.
-- Числа совпадают с @bayramm/media (MAX_UPLOAD_BYTES, UPLOAD_MIME_TYPES) —
-- это проверяет тест API
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('listing-photos', 'listing-photos', true, 10485760, array['image/webp', 'image/jpeg', 'image/png'])
on conflict (id) do update
  set name               = excluded.name,
      public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ── app.photos ──────────────────────────────────────────────────────────────
-- «ready требует public_prefix» заменяется на «ready требует проверенный файл»
alter table app.photos drop constraint photos_check;
alter table app.photos drop column public_prefix;

-- Предел размера — как у бакета
alter table app.photos drop constraint photos_bytes_check;
alter table app.photos add constraint photos_bytes_check check (bytes between 1 and 10485760);

alter table app.photos add constraint photos_storage_key_format check (
  storage_key ~ '^listings/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(webp|jpg|png)$'
  and split_part(storage_key, '/', 2) = listing_id::text);

alter table app.photos add constraint photos_ready_file check (
  status <> 'ready'
  or (mime is not null and bytes is not null and width is not null and height is not null and sha256 is not null));

-- Один объект — одна строка: удаление фото не заденет чужое
create unique index photos_storage_key_uq on app.photos (storage_key);

comment on table app.photos is
  'Фото листинга: оригинал без метаданных в Supabase Storage (бакет listing-photos), варианты — воркер media';
comment on column app.photos.storage_key is
  'Ключ объекта в бакете listing-photos: listings/<listing_id>/<uuid>.<webp|jpg|png>';
comment on column app.photos.sha256 is 'sha256 файла: один и тот же файл дважды в листинг не загрузить';

-- ── photos_guard без public_prefix ──────────────────────────────────────────
-- Та же логика, что в миграции 2: лимит на листинг; вендор не одобряет свои
-- фото и не меняет результат проверки файла
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
     and (new.status, new.moderation, new.mime, new.bytes, new.width, new.height,
          new.sha256, new.failure_reason, new.processed_at, new.moderated_by, new.moderated_at)
         is distinct from
         (old.status, old.moderation, old.mime, old.bytes, old.width, old.height,
          old.sha256, old.failure_reason, old.processed_at, old.moderated_by, old.moderated_at) then
    raise exception 'forbidden_for_actor' using errcode = 'BR003';
  end if;
  if new.moderation is distinct from old.moderation then
    new.moderated_at := now();
    new.moderated_by := case when v_actor = 'staff' then app.actor_id() end;
  end if;
  return new;
end $$;

revoke execute on function app.photos_guard() from public;
