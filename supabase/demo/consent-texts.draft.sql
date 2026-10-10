-- ════════════════════════════════════════════════════════════════════════════
-- ЧЕРНОВИКИ текстов согласий клиента — ТОЛЬКО для staging (демо и тесты).
--
-- Это не юридические тексты и не миграция: тексты согласий — юридическое
-- содержание, их пишет и утверждает юрист, в production они попадают отдельно.
-- Здесь — версия 1 на русском и узбекском для трёх целей клиента
-- (client_service, request_transfer, bot_notifications), чтобы на staging
-- можно было пройти путь «каталог → заявка» целиком. Оператор (legal_entity_id)
-- не указан, получателей нет; каждый текст начинается со слова «ЧЕРНОВИК» /
-- «QORALAMA».
--
-- Запуск (staging, psql или SQL-редактор Supabase), одной пачкой:
--   set bayramm.env = 'staging';
--   \i supabase/demo/consent-texts.draft.sql
-- Без первой строки скрипт ничего не делает и падает с объяснением.
-- Повторный запуск безопасен: существующие версии не трогаются.
--
-- Утверждённые тексты публикует шаблон supabase/legal/consent-texts.template.sql:
-- они выходят следующей версией, черновики выводятся из оборота.
-- ════════════════════════════════════════════════════════════════════════════

begin;

do $$
begin
  if current_setting('bayramm.env', true) is distinct from 'staging' then
    raise exception 'consent-texts.draft.sql — только для staging'
      using hint = 'выполните в той же сессии: set bayramm.env = ''staging'';';
  end if;
end $$;

-- Узбекский — латиница: ʻ (U+02BB) после o/g, ʼ (U+02BC) — tutuq belgisi
insert into app.consent_texts (purpose, version, locale, body) values
  ('client_service', 1, 'ru',
   'ЧЕРНОВИК — не юридический текст, только для тестового стенда. '
   'Я согласен(на), чтобы Bayramm обрабатывал мой Telegram ID, имя и язык интерфейса, '
   'чтобы вести мой аккаунт и показывать мои заявки. Согласие можно отозвать в профиле.'),
  ('client_service', 1, 'uz',
   'QORALAMA — yuridik matn emas, faqat sinov muhiti uchun. '
   'Bayramm akkauntimni yuritish va soʻrovlarimni koʻrsatish uchun Telegram ID, ismim va '
   'interfeys tilimni qayta ishlashiga roziman. Rozilikni profilda qaytarib olish mumkin.'),

  ('request_transfer', 1, 'ru',
   'ЧЕРНОВИК — не юридический текст, только для тестового стенда. '
   'Я согласен(на) передать площадке, которой отправляю заявку, моё имя, телефон, дату события, '
   'число гостей, бюджет и комментарий, чтобы она со мной связалась. '
   'Согласие действует только для этой площадки.'),
  ('request_transfer', 1, 'uz',
   'QORALAMA — yuridik matn emas, faqat sinov muhiti uchun. '
   'Soʻrov yuborayotgan hamkorimga men bilan bogʻlanishi uchun ismim, telefon raqamim, tadbir sanasi, '
   'mehmonlar soni, byudjet va izohimni berishga roziman. Rozilik faqat shu hamkor uchun amal qiladi.'),

  ('bot_notifications', 1, 'ru',
   'ЧЕРНОВИК — не юридический текст, только для тестового стенда. '
   'Я согласен(на) получать от бота Bayramm в Telegram уведомления о моих заявках. '
   'Отключить их можно в профиле.'),
  ('bot_notifications', 1, 'uz',
   'QORALAMA — yuridik matn emas, faqat sinov muhiti uchun. '
   'Telegramdagi Bayramm botidan soʻrovlarim haqida bildirishnomalar olishga roziman. '
   'Ularni profilda oʻchirib qoʻyish mumkin.')
on conflict (purpose, version, locale) do nothing;

-- Что действует теперь (то же выбирает GET /consent-texts)
select distinct on (purpose, locale) purpose, locale, version, id, left(body, 40) as body
from app.consent_texts
where purpose in ('client_service', 'request_transfer', 'bot_notifications')
  and published_at <= now() and (retired_at is null or retired_at > now())
order by purpose, locale, version desc;

commit;
