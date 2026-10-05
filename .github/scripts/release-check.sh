#!/usr/bin/env bash
# Чек-лист выпуска: в production нет того, что допустимо только на staging. Запускает
# deploy.yml после выкладки production; вручную — перед выпуском:
#
#   .github/scripts/release-check.sh bayramm.uz
#
# Публичные адреса — то, что увидит клиент:
#   · тексты согласий клиента (GET /api/consent-texts): все три цели на ru и uz, ни одного
#     черновика — они начинаются с «ЧЕРНОВИК» / «QORALAMA» (supabase/demo/*.draft.sql);
#   · витрины каталога (все включённые категории, все страницы и карточки): ни одной
#     демо-витрины — id из диапазона DEMO_ID_PREFIX (apps/api/src/demo/venues.ts), slug demo-…,
#     «Демо» / «Demo» в названии — и ни одного телефона с кодом оператора 00 (+998 00 … —
#     заведомо несуществующие номера демо-витрин);
#   · бот окружения (GET /api/telegram/bot) — не тестовый: в имени нет test, staging, dev, demo.
# С SUPABASE_DB_URL (секрет environment) — ещё и база: действующих черновиков согласий нет ни у
# одной цели (в том числе у целей вендора — их API наружу не отдаёт), строк из демо-диапазона нет.
#
# Находит всё сразу, каждую проблему — строкой ::error::, затем выход 1. Нужны curl и jq
# (и psql для базы — есть на раннере GitHub).
set -uo pipefail

host="${1:?usage: release-check.sh <host>, например bayramm.uz}"
# Адрес API можно подменить (проверка самого скрипта на подставном сервере)
base="${RELEASE_CHECK_API:-https://$host/api}"
# Тот же литерал — DEMO_ID_PREFIX в apps/api/src/demo/venues.ts и в app.demo_purge()
demo_prefix="00000000-0000-4000-8000-de"
failed=0

fail() {
  echo "::error::$1"
  failed=1
}

get() {
  curl -sSf --retry 5 --retry-delay 3 --retry-all-errors "$base$1"
}

# ── тексты согласий клиента ─────────────────────────────────────────────────
if consents=$(get "/consent-texts"); then
  for purpose in client_service request_transfer bot_notifications; do
    for locale in ru uz; do
      if ! jq -e --arg p "$purpose" --arg l "$locale" \
        'any(.items[]; .purpose == $p and .locale == $l)' <<<"$consents" >/dev/null; then
        fail "нет действующего текста согласия $purpose ($locale)"
      fi
    done
  done
  while read -r draft; do
    [ -n "$draft" ] && fail "текст согласия $draft — черновик, а не утверждённый юридический текст"
  done < <(jq -r '.items[] | select(.body | test("^\\s*(ЧЕРНОВИК|QORALAMA)"; "i")) | "\(.purpose) \(.locale) v\(.version)"' <<<"$consents")
else
  fail "GET $base/consent-texts не ответил"
fi

# ── витрины каталога ────────────────────────────────────────────────────────
if categories=$(get "/catalog/categories"); then
  slugs=()
  for code in $(jq -r '.items[] | select(.listings > 0) | .code' <<<"$categories"); do
    cursor=""
    while :; do
      query="category=$code&limit=50${cursor:+&cursor=$cursor}"
      if ! page=$(get "/catalog/listings?$query"); then
        fail "GET $base/catalog/listings?$query не ответил"
        break
      fi
      while IFS=$'\t' read -r id slug name; do
        [ -z "$id" ] && continue
        slugs+=("$slug")
        if [[ "$id" == "$demo_prefix"* || "$slug" == demo-* || "$name" =~ (Демо|Demo|DEMO) ]]; then
          fail "в каталоге ($code) демо-витрина $slug — «$name»"
        fi
      done < <(jq -r '.items[] | [.id, .slug, .name] | @tsv' <<<"$page")
      cursor=$(jq -r '.nextCursor // empty | @uri' <<<"$page")
      [ -z "$cursor" ] && break
    done
  done
  for slug in "${slugs[@]}"; do
    if ! detail=$(get "/catalog/listings/$slug"); then
      fail "GET $base/catalog/listings/$slug не ответил"
      continue
    fi
    if jq -e '(.phone // "") | gsub("[^0-9+]"; "") | startswith("+99800")' <<<"$detail" >/dev/null; then
      fail "у витрины $slug телефон с кодом оператора 00 — номер демо-витрины, а не настоящий"
    fi
  done
  echo "витрин в каталоге: ${#slugs[@]}"
else
  fail "GET $base/catalog/categories не ответил"
fi

# ── бот окружения ───────────────────────────────────────────────────────────
if bot=$(get "/telegram/bot"); then
  username=$(jq -r '.username // ""' <<<"$bot")
  if [ -z "$username" ]; then
    fail "API не знает имени бота (GET $base/telegram/bot)"
  elif [[ "${username,,}" =~ (test|staging|stage|dev|demo) ]]; then
    fail "бот окружения похож на тестовый: @$username"
  fi
else
  fail "GET $base/telegram/bot не ответил"
fi

# ── база (если есть доступ) ─────────────────────────────────────────────────
if [ -n "${SUPABASE_DB_URL:-}" ]; then
  if row=$(psql "$SUPABASE_DB_URL" -XAt -F ' ' -v ON_ERROR_STOP=1 -c "
    select
      (select count(*) from app.consent_texts t
        where (t.body like 'ЧЕРНОВИК%' or t.body like 'QORALAMA%')
          and t.published_at <= now() and (t.retired_at is null or t.retired_at > now())),
      (select count(*) from app.vendor_accounts where id::text like '$demo_prefix%'),
      (select count(*) from app.listings where id::text like '$demo_prefix%')"); then
    read -r drafts vendors listings <<<"$row"
    [ "$drafts" != 0 ] && fail "в базе действующих черновиков согласий: $drafts (вывести из оборота — supabase/demo/*.draft.sql)"
    [ "$vendors" != 0 ] && fail "в базе демо-вендоров: $vendors (app.demo_purge())"
    [ "$listings" != 0 ] && fail "в базе демо-витрин: $listings (app.demo_purge())"
  else
    fail "запрос к базе не прошёл"
  fi
else
  echo "::notice::SUPABASE_DB_URL не задан — проверены только публичные адреса"
fi

if [ "$failed" != 0 ]; then
  echo "::error::Чек-лист выпуска $host не пройден"
  exit 1
fi
echo "Чек-лист выпуска $host пройден"
