import { DateField } from "@bayramm/ui/react";
import { useId } from "react";
import { useCalendarTexts } from "../components/Calendar";
import { Link } from "../components/Link";
import { ListingCard } from "../components/ListingCard";
import { CardsLoading, EmptyState, ErrorState } from "../components/States";
import { useLang, useServices } from "../context";
import { useFavorites } from "../favorites";
import { addDays, formatDayMonth, tashkentToday } from "../format";
import { useAsync, useDocumentTitle } from "../hooks";
import { hrefFor, useNav } from "../router";
import { catalogDate, DATE_HORIZON_DAYS, lastCatalogDate, rememberCatalogDate } from "./catalog-feed";

/* «Сохранённое» — площадки с сердечком (прототип: вкладка избранного). Входить не нужно:
   у гостя список в браузере. Снятая с сердечком карточка сразу уходит из списка;
   снятая с публикации — не приходит с сервера, без ошибки. Дата (?date=, иначе последняя из
   каталога этой вкладки) — у карточек «свободно / частично / занято» на неё: кто из отмеченных
   свободен в день праздника, видно без захода на каждую витрину. Пустой список известен без
   запроса — пустое состояние сразу, без заготовок карточек. */

/** Заготовок карточек — сколько отмечено, но не больше ряда */
const MAX_SKELETONS = 4;

export function Favorites() {
  const { now } = useServices();
  const { t } = useLang();
  const { query, navigate } = useNav();
  const { ids, mode, ready, cards } = useFavorites();
  const calendarTexts = useCalendarTexts();
  const dateId = useId();
  const today = tashkentToday(now());
  const date = catalogDate(query.get("date"), today) ?? lastCatalogDate(today);
  // Отметок нет — и ждать нечего: пусто сразу
  const empty = ready && ids.size === 0;
  // Перечитать при входе в этой вкладке, когда аккаунт слил гостевой список и при смене даты
  const list = useAsync(`favorites:${mode}:${ready}:${date ?? ""}`, (signal) =>
    empty ? Promise.resolve([]) : cards(signal, date),
  );
  useDocumentTitle(t.svTitle);

  // Снятое сердечком здесь же — сразу из списка (когда отметки аккаунта уже известны)
  const items = list.status === "ready" ? list.data.filter((card) => !ready || ids.has(card.id)) : [];
  const setDate = (day: string | null) => {
    rememberCatalogDate(day);
    navigate(hrefFor({ name: "favorites" }, { date: day }), { replace: true });
  };

  return (
    <div className="screen favorites">
      <div className="list-head">
        <h1 className="screen-title" tabIndex={-1}>
          {t.svTitle}
        </h1>
        {items.length > 0 ? (
          <span className="count" aria-hidden="true">
            {items.length}
          </span>
        ) : null}
      </div>

      {!empty ? (
        <div className="filter-row favorites-date">
          <label className="sr-only" htmlFor={dateId}>
            {t.fDate}
          </label>
          <DateField
            size="compact"
            id={dateId}
            label={t.fDate}
            placeholder={t.anyDatePill}
            value={date}
            min={today}
            max={addDays(today, DATE_HORIZON_DAYS)}
            format={(day) => formatDayMonth(day, t)}
            texts={calendarTexts}
            clearLabel={t.anyDate}
            onChange={setDate}
          />
          {date === null ? <p className="muted small">{t.svDateHint}</p> : null}
        </div>
      ) : null}

      {list.status === "loading" && !empty ? (
        <CardsLoading count={Math.min(Math.max(ids.size, 1), MAX_SKELETONS)} />
      ) : null}
      {list.status === "error" ? <ErrorState onRetry={list.reload} /> : null}
      {empty || (list.status === "ready" && items.length === 0) ? (
        <EmptyState
          title={t.svEmptyH}
          // «Входить не нужно» — только гостю: вошедшему список хранит аккаунт
          text={mode === "account" ? t.svEmptyPSigned : t.svEmptyP}
          action={
            <Link className="btn btn-secondary" href={hrefFor({ name: "catalog" })}>
              {t.svGo}
            </Link>
          }
        />
      ) : null}
      {items.length > 0 ? (
        <ul className="cards">
          {items.map((card, i) => (
            <li key={card.id}>
              <ListingCard card={card} date={date} guests={null} eager={i < 2} showCategory />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
