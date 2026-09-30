-- ════════════════════════════════════════════════════════════════════════════
-- Миграция — уборка демо-данных staging.
--
--   · демо-вендоры — id из зарезервированного диапазона 00000000-0000-4000-8000-de…
--     (их заводит POST /ops/demo, только на staging: apps/api/src/demo). Случайный
--     uuid туда не попадает, а сотрудник id вендора не выбирает — диапазон и есть
--     метка; в production демо-вендоров нет, и функция ничего не находит;
--   · app.demo_purge() удаляет демо-вендоров целиком: карточки (фото, пакеты, телефон,
--     правки, занятость — каскадом), историю статусов карточек, пользователей кабинета
--     и их сессии, заявки на демо-карточки — с контактами, историей статусов,
--     заметками и уведомлениями, — и согласия на передачу контактов демо-карточкам.
--     Больше ничего: аккаунты, клиенты и их прочие согласия остаются. Журнал действий
--     и журнал доступа к ПДн тоже остаются — в них только id, без внешних ключей;
--   · история статусов, заметки и согласия — журналы только на добавление, но на
--     заявки и карточки они ссылаются внешними ключами. На время удаления их
--     триггеры append_only выключаются и включаются обратно в этой же транзакции:
--     DDL в Postgres транзакционен, другим сеансам журнал без защиты не виден;
--   · вызывает только актор system (API, маршрут staging); объекты Storage API
--     удаляет до вызова. Итог — в журнал действий (demo.reset, только числа).
--
-- Откат: supabase/rollbacks/20260930210000_demo_purge.down.sql
-- ════════════════════════════════════════════════════════════════════════════

create function app.demo_purge() returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_vendors  uuid[];
  v_listings uuid[];
  v_requests uuid[];
  v_users    uuid[];
  v_photos   int;
  v_result   jsonb;
begin
  if app.actor_kind() is distinct from 'system' then
    raise exception 'forbidden_for_actor' using errcode = 'BR003';
  end if;

  -- Демо-вендоры блокируются: параллельная правка из панели дождётся уборки
  select coalesce(array_agg(v.id), '{}') into v_vendors
  from (select v.id from app.vendor_accounts v
        where v.id::text like '00000000-0000-4000-8000-de%'
        for update) v;
  if cardinality(v_vendors) = 0 then
    return jsonb_build_object('vendors', 0, 'listings', 0, 'photos', 0, 'requests', 0, 'vendorUsers', 0);
  end if;

  select coalesce(array_agg(l.id), '{}') into v_listings
  from app.listings l where l.vendor_id = any (v_vendors);
  select coalesce(array_agg(r.id), '{}') into v_requests
  from app.requests r where r.vendor_id = any (v_vendors) or r.listing_id = any (v_listings);
  select coalesce(array_agg(u.id), '{}') into v_users
  from app.vendor_users u where u.vendor_id = any (v_vendors);
  select count(*) into v_photos from app.photos p where p.listing_id = any (v_listings);

  alter table app.request_status_log disable trigger request_status_log_append_only;
  alter table app.request_notes disable trigger request_notes_append_only;
  alter table app.consents disable trigger consents_append_only;
  alter table app.listing_status_log disable trigger listing_status_log_append_only;

  -- Уведомления: по заявкам, пользователям кабинета и правкам демо-карточек
  delete from app.outbox o
  where o.request_id = any (v_requests)
     or (o.recipient_kind = 'vendor_user' and o.recipient_id = any (v_users))
     or (o.kind = 'ops.revision_submitted' and o.payload ->> 'revision_id' in (
           select r.id::text from app.listing_revisions r where r.listing_id = any (v_listings)));
  -- Занятость ссылается на заявки (отказ «занято»)
  delete from app.availability a where a.listing_id = any (v_listings);
  delete from app.request_notes n where n.request_id = any (v_requests);
  delete from app.request_status_log s where s.request_id = any (v_requests);
  delete from app.requests r where r.id = any (v_requests);
  delete from app.consents c where c.scope_listing_id = any (v_listings);
  delete from app.listing_status_log s where s.listing_id = any (v_listings);
  delete from app.sessions s where s.vendor_user_id = any (v_users);
  delete from app.vendor_users u where u.id = any (v_users);
  delete from app.listings l where l.id = any (v_listings);
  delete from app.vendor_accounts v where v.id = any (v_vendors);

  alter table app.request_status_log enable trigger request_status_log_append_only;
  alter table app.request_notes enable trigger request_notes_append_only;
  alter table app.consents enable trigger consents_append_only;
  alter table app.listing_status_log enable trigger listing_status_log_append_only;

  v_result := jsonb_build_object(
    'vendors', cardinality(v_vendors),
    'listings', cardinality(v_listings),
    'photos', v_photos,
    'requests', cardinality(v_requests),
    'vendorUsers', cardinality(v_users));
  insert into app.audit_log (action, object_type, object_id, detail, source)
  values ('demo.reset', 'demo', 'staging', v_result, 'system');
  return v_result;
end $$;

comment on function app.demo_purge() is
  'Демо-данные staging: удаляет вендоров из диапазона 00000000-0000-4000-8000-de… целиком, с заявками на их карточки';

-- ── права ───────────────────────────────────────────────────────────────────
revoke execute on function app.demo_purge() from public;
grant execute on function app.demo_purge() to bayramm_api;
