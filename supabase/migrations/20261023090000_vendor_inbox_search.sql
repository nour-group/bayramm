-- Поиск во входящих кабинета партнёра по концу номера клиента.
--
--   · pii.vendor_requests_by_phone_tail(цифры) — id своих заявок, чей номер клиента кончается на эти
--     цифры (от 4 до 9). Номер роли API не виден (столбец закрыт), поэтому сравнивает функция и
--     наружу отдаёт только id — по тем же правилам видимости контакта, что у карточки заявки
--     (app.can_see_request_contact: своя заявка, не отозвана, согласие действует; номер не стёрт
--     по сроку хранения). Номер не раскрывается, поэтому чтение не журналируется: партнёр ищет
--     номер, который ему уже назвал клиент.
--   · Поиск по номеру заявки и имени клиента обходится без функции: номер заявки — столбец заявки,
--     имя видно партнёру политикой request_contacts_read.

create function pii.vendor_requests_by_phone_tail(p_tail text)
returns setof uuid
language sql stable security definer set search_path = ''
as $$
  select rc.request_id
  from pii.request_contacts rc
  join app.requests r on r.id = rc.request_id
  where app.actor_kind() = 'vendor_user'
    and r.vendor_id = app.actor_vendor_id()
    and p_tail ~ '^[0-9]{4,9}$'
    and rc.purged_at is null
    and right(rc.contact_phone, length(p_tail)) = p_tail
    and app.can_see_request_contact(rc.request_id)
$$;

revoke all on function pii.vendor_requests_by_phone_tail(text) from public;
grant execute on function pii.vendor_requests_by_phone_tail(text) to bayramm_api;
