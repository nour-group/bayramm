-- ════════════════════════════════════════════════════════════════════════════
-- ЧЕРНОВИКИ текстов согласий вендора — ТОЛЬКО для staging (демо и тесты).
--
-- Пара к consent-texts.draft.sql (тексты клиента). Без действующего текста цели
-- vendor_contact панель оператора не отметит «согласие ПДн подписано», и ни одна
-- карточка не пройдёт публикацию. Юридические тексты пишет и утверждает юрист;
-- в production они попадают отдельно. Оператор (legal_entity_id) не указан,
-- каждый текст начинается со слова «ЧЕРНОВИК» / «QORALAMA».
--
-- Запуск (staging, psql или SQL-редактор Supabase), одной пачкой:
--   set bayramm.env = 'staging';
--   \i supabase/demo/vendor-consent-texts.draft.sql
-- Повторный запуск безопасен: существующие версии не трогаются.
-- Утверждённые тексты выходят версией 2, черновики выводятся из оборота так же,
-- как в consent-texts.draft.sql (purpose in vendor_contact, vendor_phone_public, vendor_offer).
-- ════════════════════════════════════════════════════════════════════════════

begin;

do $$
begin
  if current_setting('bayramm.env', true) is distinct from 'staging' then
    raise exception 'vendor-consent-texts.draft.sql — только для staging'
      using hint = 'выполните в той же сессии: set bayramm.env = ''staging'';';
  end if;
end $$;

-- Узбекский — латиница: ʻ (U+02BB) после o/g, ʼ (U+02BC) — tutuq belgisi
insert into app.consent_texts (purpose, version, locale, body) values
  ('vendor_contact', 1, 'ru',
   'ЧЕРНОВИК — не юридический текст, только для тестового стенда. '
   'Я согласен(на), чтобы Bayramm обрабатывал мои ФИО, телефон и должность как контактного лица '
   'площадки, чтобы вести кабинет, связываться со мной и передавать мне заявки клиентов.'),
  ('vendor_contact', 1, 'uz',
   'QORALAMA — yuridik matn emas, faqat sinov muhiti uchun. '
   'Bayramm kabinetni yuritish, men bilan bogʻlanish va mijozlar arizalarini menga yetkazish uchun '
   'maydonning aloqa shaxsi sifatida F.I.Sh., telefon raqamim va lavozimimni qayta ishlashiga roziman.'),

  ('vendor_phone_public', 1, 'ru',
   'ЧЕРНОВИК — не юридический текст, только для тестового стенда. '
   'Я согласен(на), чтобы телефон площадки был виден клиентам в карточке до отправки заявки.'),
  ('vendor_phone_public', 1, 'uz',
   'QORALAMA — yuridik matn emas, faqat sinov muhiti uchun. '
   'Maydon telefon raqami ariza yuborilishidan oldin kartada mijozlarga koʻrinishiga roziman.'),

  ('vendor_offer', 1, 'ru',
   'ЧЕРНОВИК — не юридический текст, только для тестового стенда. '
   'Я принимаю условия размещения площадки на Bayramm.'),
  ('vendor_offer', 1, 'uz',
   'QORALAMA — yuridik matn emas, faqat sinov muhiti uchun. '
   'Bayrammda maydonni joylashtirish shartlarini qabul qilaman.')
on conflict (purpose, version, locale) do nothing;

select distinct on (purpose, locale) purpose, locale, version, id, left(body, 40) as body
from app.consent_texts
where purpose in ('vendor_contact', 'vendor_phone_public', 'vendor_offer')
  and published_at <= now() and (retired_at is null or retired_at > now())
order by purpose, locale, version desc;

commit;
