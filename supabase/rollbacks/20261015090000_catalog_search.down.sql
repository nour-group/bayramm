-- Откат 20261015090000_catalog_search: поиска по каталогу нет — ни документов витрин, ни функций,
-- ни pg_trgm

drop function app.catalog_search(text, text);

drop trigger service_types_search on app.service_types;
drop trigger districts_search on app.districts;
drop trigger categories_search on app.categories;
drop trigger listing_services_search on app.listing_services;
drop trigger listings_search on app.listings;
drop function app.listing_search_on_dictionary();
drop function app.listing_search_on_service();
drop function app.listing_search_on_listing();
drop function app.listing_search_refresh(uuid[]);

drop table app.listing_search;

drop function app.search_matches(text, text);
drop function app.listing_attrs_text(text, jsonb);
drop function app.search_norm(text);

drop extension if exists pg_trgm;
