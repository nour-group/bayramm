-- Поиск во входящих кабинета партнёра по последним цифрам номера клиента.
--
--   · pii.vendor_requests_by_phone_tail(цифры) — id своих заявок, чей номер клиента кончается на эти
--     цифры (от 4 до 9). Номер роли API не виден (столбец закрыт), поэтому сравнивает функция и
--     наружу отдаёт только id — по тем же правилам видимости контакта, что у карточки заявки
--     (app.can_see_request_contact: своя заявка, не отозвана, согласие действует; номер не стёрт
--     по сроку хранения).
--   · Каждый такой поиск — строка в журнале доступа к ПДн: кто, когда, витрины какого вендора
--     (subject_kind vendor_inbox, subject_id — вендор), purpose request_search, в reason — сколько
--     совпало. Самих цифр в журнале нет. Перебор концов номера виден в журнале, а частоту держит
--     лимит API (RATE_LIMIT_INBOX_SEARCH, 20 в минуту на пользователя кабинета).
--   · Поиск по номеру заявки и имени клиента обходится без функции: номер заявки — столбец заявки,
--     имя видно партнёру политикой request_contacts_read.

alter table app.pii_access_log drop constraint pii_access_log_subject_kind_check;
alter table app.pii_access_log add constraint pii_access_log_subject_kind_check check (subject_kind in
  ('client', 'request_contact', 'vendor_contact', 'vendor_user', 'listing_contact', 'vendor_inbox'));

create function pii.vendor_requests_by_phone_tail(p_tail text)
returns uuid[]
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_ids uuid[];
begin
  if app.actor_kind() is distinct from 'vendor_user' or p_tail is null or p_tail !~ '^[0-9]{4,9}$' then
    return '{}';
  end if;
  select coalesce(array_agg(rc.request_id), '{}') into v_ids
  from pii.request_contacts rc
  join app.requests r on r.id = rc.request_id
  where r.vendor_id = app.actor_vendor_id()
    and rc.purged_at is null
    and right(rc.contact_phone, length(p_tail)) = p_tail
    and app.can_see_request_contact(rc.request_id);
  perform app.log_pii_access('vendor_inbox', app.actor_vendor_id(), 'request_search',
                             format('совпадений: %s', cardinality(v_ids)));
  return v_ids;
end
$$;

revoke all on function pii.vendor_requests_by_phone_tail(text) from public;
grant execute on function pii.vendor_requests_by_phone_tail(text) to bayramm_api;
