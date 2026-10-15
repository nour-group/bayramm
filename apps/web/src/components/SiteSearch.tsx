import type { MouseEvent } from "react";
import { flushSync } from "react-dom";
import { useLang } from "../context";
import { Icon } from "../icons";
import { hrefFor, useNav } from "../router";
import { searchText } from "../screens/catalog-feed";
import { CATALOG_SEARCH_ID, CatalogSearch, requestSearchFocus } from "./CatalogSearch";

/* Поиск в шапке сайта (гостя и после входа; в Telegram поиск — вверху вкладки каталога):
   на компьютере — поле с подсказками, Enter открывает каталог с ?q=; на телефоне и планшете —
   значок: каталог открывается с фокусом в его поле поиска. На самом каталоге шапка поиска не
   показывает: поле там уже есть (каждое — один раз на экран). */

const SITE_SEARCH_ID = "site-search";

export function SiteSearch() {
  const { t } = useLang();
  const { navigate } = useNav();
  const catalog = hrefFor({ name: "catalog" });

  const openCatalog = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    requestSearchFocus();
    // Экран каталога уже загружен — поле есть сразу: фокус в том же нажатии (иначе iOS не
    // покажет клавиатуру); ещё грузится — поле возьмёт фокус само, когда появится
    flushSync(() => navigate(catalog));
    document.getElementById(CATALOG_SEARCH_ID)?.focus({ preventScroll: true });
  };

  return (
    <>
      <CatalogSearch
        id={SITE_SEARCH_ID}
        className="top-search-field"
        value=""
        onSubmit={(text) => {
          const q = searchText(text);
          if (q !== null) navigate(hrefFor({ name: "catalog" }, { q }));
        }}
      />
      <a className="icon-btn top-search" href={catalog} aria-label={t.nav0} onClick={openCatalog}>
        <Icon name="search" size={17} />
      </a>
    </>
  );
}
