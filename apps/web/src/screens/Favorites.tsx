import { Link } from "../components/Link";
import { ListingCard } from "../components/ListingCard";
import { EmptyState, ErrorState, Loading } from "../components/States";
import { useLang } from "../context";
import { useFavorites } from "../favorites";
import { useAsync, useDocumentTitle } from "../hooks";
import { hrefFor } from "../router";

/* «Сохранённое» — площадки с сердечком (прототип: вкладка избранного). Входить не нужно:
   у гостя список в браузере. Снятая с сердечком карточка сразу уходит из списка;
   снятая с публикации — не приходит с сервера, без ошибки. */
export function Favorites() {
  const { t } = useLang();
  const { ids, mode, ready, cards } = useFavorites();
  // Перечитать при входе в этой вкладке и когда аккаунт слил гостевой список
  const list = useAsync(`favorites:${mode}:${ready}`, cards);
  useDocumentTitle(t.svTitle);

  // Снятое сердечком здесь же — сразу из списка (когда отметки аккаунта уже известны)
  const items = list.status === "ready" ? list.data.filter((card) => !ready || ids.has(card.id)) : [];

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

      {list.status === "loading" ? <Loading /> : null}
      {list.status === "error" ? <ErrorState onRetry={list.reload} /> : null}
      {list.status === "ready" && items.length === 0 ? (
        <EmptyState
          title={t.svEmptyH}
          text={t.svEmptyP}
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
              <ListingCard card={card} date={null} guests={null} eager={i < 2} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
