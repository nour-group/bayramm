-- Откат 20261011090000_moderation_flow.sql: оповещения об услугах и фото — снова только у
-- опубликованной витрины и раз в час, без оповещения об отправке витрины на проверку и без
-- следа в журнале, очереди команды — без услуг. Только для локальной разработки и проверки
-- в CI (up → down → up)

drop trigger if exists listings_submitted_notify on app.listings;
drop function if exists app.listings_submitted_notify();
-- Неотправленные оповещения нового вида прежний отправитель не знает
delete from app.outbox where kind = 'ops.listing_submitted' and status in ('pending', 'failed');

-- 20261001120100_categories_services.sql
create or replace function app.listing_services_notify() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_listing app.listings;
begin
  select l.* into v_listing from app.listings l where l.id = new.listing_id;
  if not found or v_listing.status <> 'active' then
    return null;
  end if;
  if app.actor_proposes()
     and ((new.status = 'review' and (tg_op = 'INSERT' or old.status is distinct from 'review'))
          or (new.proposal is not null and (tg_op = 'INSERT' or new.proposal_at is distinct from old.proposal_at))) then
    perform app.enqueue_staff_alert('ops.service_submitted', array['admin', 'moderator']::app.staff_role[],
      jsonb_build_object('listing_id', new.listing_id),
      new.listing_id::text || ':' || to_char(now() at time zone 'Asia/Tashkent', 'YYYY-MM-DD"T"HH24'));
  end if;
  if tg_op = 'UPDATE' and new.decided_at is not null and new.decided_at is distinct from old.decided_at
     and app.effective_actor() in ('staff', 'system') then
    perform app.enqueue_vendor_owner_notice(v_listing.vendor_id, 'vendor.service_decided',
      jsonb_build_object('service_id', new.id, 'decision', new.decision),
      new.id::text || ':' || extract(epoch from new.decided_at)::bigint::text);
  end if;
  return null;
end $$;

-- 20261001010000_cabinet_integrity.sql
create or replace function app.photos_notify() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if app.actor_proposes()
     and exists (select 1 from app.listings l where l.id = new.listing_id and l.status = 'active') then
    perform app.enqueue_staff_alert('ops.photos_submitted', array['admin', 'moderator']::app.staff_role[],
      jsonb_build_object('listing_id', new.listing_id),
      new.listing_id::text || ':' || to_char(now() at time zone 'Asia/Tashkent', 'YYYY-MM-DD"T"HH24'));
  end if;
  return null;
end $$;

create or replace function app.listing_revisions_notify() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.status = 'pending' and app.actor_proposes() then
    perform app.enqueue_staff_alert('ops.revision_submitted', array['admin', 'moderator']::app.staff_role[],
                                    jsonb_build_object('revision_id', new.id), new.id::text);
  end if;
  return null;
end $$;

drop function if exists app.enqueue_listing_alert(text, app.staff_role[], uuid);
drop function if exists app.log_alert_without_recipients(text, app.staff_role[], uuid);

-- 20260930220000_launch_metrics.sql
drop function if exists app.metrics_ops_now();
create function app.metrics_ops_now()
returns table (awaiting int, overdue int, dead_total int, listings_review int, revisions_pending int,
               photos_pending int)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
begin
  perform app.assert_metrics_reader();
  return query
  select (select count(*) from app.requests r
          where r.status in ('new', 'viewed') and r.first_response_at is null)::int,
         (select count(*) from app.requests r
          where r.status in ('new', 'viewed') and r.first_response_at is null and r.sla_due_at <= now())::int,
         (select count(*) from app.outbox o where o.status = 'dead')::int,
         (select count(*) from app.listings l where l.status = 'review')::int,
         (select count(*) from app.listing_revisions rv where rv.status = 'pending')::int,
         (select count(*) from app.photos p
          join app.listings l on l.id = p.listing_id
          where p.status = 'ready' and p.moderation = 'pending' and p.deleted_at is null
            and l.status in ('active', 'suspended'))::int;
end $$;

comment on function app.metrics_ops_now() is
  'Очереди команды сейчас: заявки без ответа, просрочки, недоставленное, модерация. Сотрудник или система';
revoke execute on function app.metrics_ops_now() from public;
grant execute on function app.metrics_ops_now() to bayramm_api;
