-- Смена контактов витрины в счётчике «Модерации».
--
-- Партнёр просит новый телефон или Telegram витрины на проверке или на сайте
-- (20261012100000_vendor_photos_contacts.sql); решают те, кто решает по правкам. Очередь в панели
-- есть («Модерация» → «Контакты»), а числа у раздела не было: app.metrics_ops_now его не считала.
-- Теперь считает — contacts_pending: ждущие запросы (номеров здесь нет, только число).

drop function app.metrics_ops_now();
create function app.metrics_ops_now()
returns table (awaiting int, overdue int, dead_total int, listings_review int, revisions_pending int,
               photos_pending int, services_pending int, contacts_pending int)
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
            and l.status <> 'rejected')::int,
         (select count(*) from app.listing_services s
          join app.listings l on l.id = s.listing_id
          where (s.status = 'review' or s.proposal is not null) and l.status <> 'rejected')::int,
         (select count(*) from pii.listing_contact_changes c where c.status = 'pending')::int;
end $$;

comment on function app.metrics_ops_now() is
  'Очереди команды сейчас: заявки без ответа, просрочки, недоставленное, модерация (витрины, правки, фото, услуги, контакты). Сотрудник или система';

revoke execute on function app.metrics_ops_now() from public;
grant execute on function app.metrics_ops_now() to bayramm_api;
