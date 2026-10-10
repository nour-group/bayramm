-- ════════════════════════════════════════════════════════════════════════════
-- ШАБЛОН публикации утверждённых текстов согласий — для production (годится для
-- любого окружения).
--
-- Юридических текстов здесь нет: только места {{…}}, куда их вписать. Тексты пишет
-- и утверждает юрист; оператор — юрлицо, которое обрабатывает данные. Черновики
-- staging (supabase/demo/*.draft.sql) в production не идут.
--
-- Как пользоваться:
--   1. Скопировать файл вне публичного репозитория (internal/ — в .gitignore):
--        cp supabase/legal/consent-texts.template.sql internal/legal/consent-texts-<дата>.sql
--   2. Заменить каждое {{…}}: оператор, получатели и тексты на ru и uz.
--      Цели клиента обязательны: без них нет заявок, их проверяет чек-лист выпуска.
--      Цель вендора, текст которой ещё не готов, можно убрать — её insert целиком.
--      Без vendor_contact панель не отметит «согласие ПДн подписано» и витрина не
--      опубликуется.
--   3. Выполнить одной пачкой (psql или SQL-редактор Supabase):
--        psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f internal/legal/consent-texts-<дата>.sql
--   4. Проверить: bash .github/scripts/release-check.sh bayramm.uz
--
-- Что делает: каждый текст выходит следующей версией своей цели и языка, прежние
-- действующие версии этой цели и языка (черновики тоже) выводятся из оборота. Уже
-- данные согласия остаются со своей версией (журнал), новые даются по новой.
-- Повторный запуск с теми же текстами ничего не меняет. Скрипт откатывается целиком,
-- если осталось {{…}}, у оператора нет названия или СТИР, текст начинается с
-- ЧЕРНОВИК / QORALAMA, в узбекском прямой или «кавычечный» апостроф или у цели нет
-- одного из языков.
-- ════════════════════════════════════════════════════════════════════════════

begin;

create temp table consent_operator (
  name text not null,
  stir text not null
) on commit drop;

create temp table consent_release (
  purpose    app.consent_purpose not null,
  locale     app.locale not null,
  -- Получатели, названные в тексте, через запятую (хостинг, Telegram…); нет — ''
  recipients text not null,
  body       text not null,
  primary key (purpose, locale)
) on commit drop;

-- ── оператор ────────────────────────────────────────────────────────────────
insert into consent_operator (name, stir) values
  ('{{ОПЕРАТОР: название юрлица, как в реестре}}', '{{СТИР: 9 цифр}}');

-- ── тексты ──────────────────────────────────────────────────────────────────
-- Узбекский — латиница: ʻ (U+02BB) после o/g — oʻ, gʻ; ʼ (U+02BC) — tutuq belgisi.
-- Кавычка внутри SQL-строки пишется двумя: ''

-- client_service: Аккаунт клиента: Telegram ID, имя, язык, свои заявки
insert into consent_release (purpose, locale, recipients, body) values
  ('client_service', 'ru', '{{ПОЛУЧАТЕЛИ}}', '{{ТЕКСТ: client_service, ru}}'),
  ('client_service', 'uz', '{{ПОЛУЧАТЕЛИ}}', '{{ТЕКСТ: client_service, uz}}');

-- request_transfer: Передача контактов клиента одной площадке — на каждую заявку
insert into consent_release (purpose, locale, recipients, body) values
  ('request_transfer', 'ru', '{{ПОЛУЧАТЕЛИ}}', '{{ТЕКСТ: request_transfer, ru}}'),
  ('request_transfer', 'uz', '{{ПОЛУЧАТЕЛИ}}', '{{ТЕКСТ: request_transfer, uz}}');

-- bot_notifications: Уведомления клиенту о заявках через бота
insert into consent_release (purpose, locale, recipients, body) values
  ('bot_notifications', 'ru', '{{ПОЛУЧАТЕЛИ}}', '{{ТЕКСТ: bot_notifications, ru}}'),
  ('bot_notifications', 'uz', '{{ПОЛУЧАТЕЛИ}}', '{{ТЕКСТ: bot_notifications, uz}}');

-- vendor_contact: Контактное лицо вендора: ФИО, телефон, должность
insert into consent_release (purpose, locale, recipients, body) values
  ('vendor_contact', 'ru', '{{ПОЛУЧАТЕЛИ}}', '{{ТЕКСТ: vendor_contact, ru}}'),
  ('vendor_contact', 'uz', '{{ПОЛУЧАТЕЛИ}}', '{{ТЕКСТ: vendor_contact, uz}}');

-- vendor_phone_public: Телефон витрины виден клиентам до заявки
insert into consent_release (purpose, locale, recipients, body) values
  ('vendor_phone_public', 'ru', '{{ПОЛУЧАТЕЛИ}}', '{{ТЕКСТ: vendor_phone_public, ru}}'),
  ('vendor_phone_public', 'uz', '{{ПОЛУЧАТЕЛИ}}', '{{ТЕКСТ: vendor_phone_public, uz}}');

-- vendor_offer: Условия размещения (оферта)
insert into consent_release (purpose, locale, recipients, body) values
  ('vendor_offer', 'ru', '{{ПОЛУЧАТЕЛИ}}', '{{ТЕКСТ: vendor_offer, ru}}'),
  ('vendor_offer', 'uz', '{{ПОЛУЧАТЕЛИ}}', '{{ТЕКСТ: vendor_offer, uz}}');

-- ════════════════════════════════════════════════════════════════════════════
-- Ниже ничего менять не нужно
-- ════════════════════════════════════════════════════════════════════════════

do $$
declare
  v_bad text;
begin
  if (select count(*) from consent_operator) <> 1
     or exists (select 1 from consent_operator
                where name ~ '\{\{|\}\}' or length(btrim(name)) not between 2 and 200
                   or stir !~ '^[0-9]{9}$') then
    raise exception 'оператор не заполнен: название юрлица и СТИР из 9 цифр';
  end if;

  select string_agg(format('%s · %s', purpose, locale), ', ' order by purpose, locale) into v_bad
  from consent_release where body ~ '\{\{|\}\}' or recipients ~ '\{\{|\}\}' or btrim(body) = '';
  if v_bad is not null then
    raise exception 'не заполнено: %', v_bad using hint = 'замените каждое {{…}}';
  end if;

  select string_agg(format('%s · %s', purpose, locale), ', ' order by purpose, locale) into v_bad
  from consent_release where body ~* '^\s*(ЧЕРНОВИК|Черновик|черновик|QORALAMA)';
  if v_bad is not null then
    raise exception 'это черновик, а не утверждённый текст: %', v_bad;
  end if;

  select string_agg(format('%s · %s', purpose, locale), ', ' order by purpose, locale) into v_bad
  from consent_release where locale = 'uz' and body ~ '[''‘’`]';
  if v_bad is not null then
    raise exception 'в узбекском тексте прямой или «кавычечный» апостроф: %', v_bad
      using hint = 'после o/g — ʻ (U+02BB), tutuq belgisi — ʼ (U+02BC)';
  end if;

  select string_agg(format('%s · %s', p, l), ', ' order by p, l) into v_bad
  from unnest(array['client_service', 'request_transfer', 'bot_notifications']::app.consent_purpose[]) p
  cross join unnest(enum_range(null::app.locale)) l
  where not exists (select 1 from consent_release r where r.purpose = p and r.locale = l);
  if v_bad is not null then
    raise exception 'нет обязательного текста клиента: %', v_bad;
  end if;

  select string_agg(r.purpose::text, ', ' order by r.purpose) into v_bad
  from (select purpose from consent_release group by purpose
        having count(*) < cardinality(enum_range(null::app.locale))) r;
  if v_bad is not null then
    raise exception 'у цели нет одного из языков (нужны ru и uz): %', v_bad;
  end if;
end $$;

-- Оператор: уже заведённый по СТИР не меняется
insert into app.legal_entities (name, stir)
select btrim(name), stir from consent_operator
on conflict (stir) do nothing;

-- Новая версия — если последняя действующая версия цели и языка не совпадает с новой
with operator as (
  select e.id from app.legal_entities e join consent_operator o on o.stir = e.stir
),
release as (
  select r.purpose, r.locale, r.body,
         coalesce(array(select btrim(x) from unnest(string_to_array(r.recipients, ',')) x
                        where btrim(x) <> ''), '{}') as recipients
  from consent_release r
),
latest as (
  select distinct on (t.purpose, t.locale) t.purpose, t.locale, t.version, t.body,
         t.legal_entity_id, t.recipients,
         t.published_at <= now() and (t.retired_at is null or t.retired_at > now()) as current
  from app.consent_texts t
  order by t.purpose, t.locale, t.version desc
)
insert into app.consent_texts (purpose, version, locale, legal_entity_id, body, recipients)
select r.purpose, coalesce(l.version, 0) + 1, r.locale, (select id from operator), r.body, r.recipients
from release r
left join latest l on l.purpose = r.purpose and l.locale = r.locale
where l.version is null
   or not l.current
   or l.body is distinct from r.body
   or l.legal_entity_id is distinct from (select id from operator)
   or l.recipients is distinct from r.recipients;

-- Прежние действующие версии этих целей и языков — из оборота
update app.consent_texts t set retired_at = now()
from consent_release r
where t.purpose = r.purpose and t.locale = r.locale
  and t.published_at <= now() and (t.retired_at is null or t.retired_at > now())
  and t.version < (select max(m.version) from app.consent_texts m
                   where m.purpose = t.purpose and m.locale = t.locale
                     and m.published_at <= now() and (m.retired_at is null or m.retired_at > now()));

-- Что действует теперь (то же выбирает GET /consent-texts)
select distinct on (t.purpose, t.locale) t.purpose, t.locale, t.version, e.name as operator,
       t.recipients, left(t.body, 40) as body
from app.consent_texts t
left join app.legal_entities e on e.id = t.legal_entity_id
where t.published_at <= now() and (t.retired_at is null or t.retired_at > now())
order by t.purpose, t.locale, t.version desc;

commit;
