import type { CatalogCategory } from "@bayramm/shared/api";
import { CLIENT_CATEGORIES, categoryIcon, categoryName } from "../categories";
import { useLang, useServices } from "../context";
import { type AsyncResult, useAsync } from "../hooks";
import { Icon } from "../icons";
import { ALL_CATEGORIES, hrefFor } from "../router";
import { Link } from "./Link";

/* Категории в каталоге и на лендинге: список — из описания категорий (включённые, по
   порядку), сколько витрин — из API (GET /catalog/categories). Пустую категорию клиент не
   показывает как живую: в переключателе каталога её нет, на лендинге — пометка «скоро».
   Чисел витрин не пишем: выдуманных цифр нет, а настоящие на старте малы и быстро стареют.
   Названия — короткие из глоссария клиента (categoryName). Сетка лендинга и переключатель
   каталога — одно и то же место выбора раздела: второго списка разделов на экране нет. */

export function useCatalogCategories(): AsyncResult<{ readonly items: readonly CatalogCategory[] }> {
  const { api } = useServices();
  return useAsync(
    "catalog-categories",
    (signal) => api.catalogCategories(signal),
    () => api.peek?.catalogCategories(),
  );
}

/** Есть ли в категории витрины; пока API не ответило (или ошибка) — null: не знаем */
export function listingsIn(
  state: AsyncResult<{ readonly items: readonly CatalogCategory[] }>,
  code: string,
): boolean | null {
  if (state.status !== "ready") return null;
  const item = state.data.items.find((c) => c.code === code);
  return item ? item.listings > 0 : false;
}

/** Адрес каталога категории (весь каталог — без параметра); дата — та же, что выбрана */
export function categoryHref(code: string, date: string | null = null): string {
  return hrefFor({ name: "catalog" }, { category: code === ALL_CATEGORIES ? null : code, date });
}

/**
 * Переключатель категорий каталога: «Все» первым, затем разделы — ссылки-чипы, лентой вбок на
 * телефоне. Категории без витрин не показываются (кроме открытой — по ссылке в неё можно
 * попасть); пока список не пришёл — все включённые
 */
export function CategorySwitch({ current, date }: { current: string; date: string | null }) {
  const { t, lang } = useLang();
  const state = useCatalogCategories();
  const shown = CLIENT_CATEGORIES.filter((c) => c.code === current || listingsIn(state, c.code) !== false);
  return (
    <nav className="cat-switch" aria-label={t.catSwitch}>
      <ul>
        <li>
          <Link
            className="cat-chip"
            href={categoryHref(ALL_CATEGORIES, date)}
            aria-current={current === ALL_CATEGORIES ? "page" : undefined}
          >
            <Icon name="list" size={17} className="cat-chip-ico" />
            <span>{t.catAll}</span>
          </Link>
        </li>
        {shown.map((category) => (
          <li key={category.code}>
            <Link
              className="cat-chip"
              href={categoryHref(category.code, date)}
              aria-current={category.code === current ? "page" : undefined}
            >
              <Icon name={categoryIcon(category.code)} size={17} className="cat-chip-ico" />
              <span>{categoryName(category.code, t, lang)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * Сетка категорий лендинга: все включённые, со значком и названием. Категория без витрин —
 * с пометкой «скоро» (ведёт в каталог, где честно сказано, что вендоров пока нет). Пометка
 * появляется, когда API ответило: в пререндере её нет
 */
export function CategoryGrid({ headingLevel = 3 }: { headingLevel?: 2 | 3 }) {
  const { t, lang } = useLang();
  const state = useCatalogCategories();
  const Name = headingLevel === 2 ? "h2" : "h3";
  return (
    <ul className="cat-grid">
      {CLIENT_CATEGORIES.map((category) => {
        const soon = listingsIn(state, category.code) === false;
        return (
          <li key={category.code}>
            <Link className={soon ? "cat-tile is-soon" : "cat-tile"} href={categoryHref(category.code)}>
              <span className="cat-tile-ico" aria-hidden="true">
                <Icon name={categoryIcon(category.code)} size={24} />
              </span>
              <Name className="cat-tile-name">{categoryName(category.code, t, lang)}</Name>
              {soon ? <span className="cat-soon">{t.catSoon}</span> : null}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
