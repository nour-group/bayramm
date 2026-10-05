import type { ListingCard as Card, CatalogCategory } from "@bayramm/shared/api";
import type { CategoryConfig } from "@bayramm/shared/categories";
import { DateField, NumberStepper, Select } from "@bayramm/ui/react";
import { type FormEvent, useId, useState } from "react";
import { CLIENT_CATEGORIES, categoryName, clientCategory, hasCapacity } from "../categories";
import { useCalendarTexts } from "../components/Calendar";
import { CategoryGrid, listingsIn, useCatalogCategories } from "../components/Categories";
import { ListingCard } from "../components/ListingCard";
import { useLang, useServices } from "../context";
import { addDays, formatDayMonth, tashkentToday } from "../format";
import { type AsyncResult, useAsync, useDocumentTitle } from "../hooks";
import { Icon, type IconName } from "../icons";
import { DEFAULT_CATEGORY, hrefFor, useNav } from "../router";
import { DATE_HORIZON_DAYS, filtersQuery, MAX_GUESTS, NO_FILTERS, parseGuests } from "./catalog-feed";

/* Лендинг (/) — для тех, кто открыл сайт в браузере; внутри Telegram корень — каталог.
   Каждое — один раз: первый экран про весь праздник с подбором (что ищете, дата; гости — где
   они есть → каталог раздела с этими фильтрами), разделы каталога — одной сеткой (пустой —
   «скоро»), настоящие исполнители из API — по одному из разных разделов (нет их — блока нет,
   заглушек под видом витрин не рисуем), как это работает (шаги), обещания клиенту (правила
   продукта), партнёрам, вопросы — только о том, чего выше нет. Рейтингов, отзывов и
   выдуманных цифр нет. */

/** Сколько витрин показать на лендинге: ряд на компьютере, лента — на телефоне */
const FEATURED = 4;

/**
 * Ширина фото витрин лендинга: на телефоне карточка — 84% ленты, с 640px — две колонки,
 * с 1024px — четыре (styles.css, .ln-cards)
 */
const FEATURED_SIZES = "(min-width: 1280px) 300px, (min-width: 1024px) 23vw, (min-width: 640px) 50vw, 80vw";

/**
 * Из каких разделов брать витрины: первые FEATURED разделов с витринами (по порядку показа),
 * и сколько из каждого — чтобы вместе набралось FEATURED. Пока категории не пришли — null;
 * не пришли вовсе (ошибка) — залы, как каталог по умолчанию
 */
export function featuredPlan(
  categories: AsyncResult<{ readonly items: readonly CatalogCategory[] }>,
): { readonly codes: readonly string[]; readonly per: number } | null {
  if (categories.status === "loading") return null;
  const live: readonly CategoryConfig[] =
    categories.status === "error"
      ? [clientCategory(DEFAULT_CATEGORY)]
      : CLIENT_CATEGORIES.filter((c) => listingsIn(categories, c.code));
  const codes = live.slice(0, FEATURED).map((c) => c.code);
  return { codes, per: codes.length === 0 ? 0 : Math.ceil(FEATURED / codes.length) };
}

/** По очереди из каждого раздела: первый каждого, потом вторые… — не больше FEATURED */
export function interleave(lists: readonly (readonly Card[])[]): Card[] {
  const out: Card[] = [];
  for (let i = 0; out.length < FEATURED && lists.some((list) => i < list.length); i++)
    for (const list of lists) {
      const card = list[i];
      if (card && out.length < FEATURED) out.push(card);
    }
  return out;
}

/** Обещания — по порядку lnPromT/lnPromP; иконки — смысловые (duotone) */
const PROMISE_ICONS: readonly IconName[] = ["shieldD", "checkFill", "phone", "clockD"];

function QuickSearch() {
  const { now } = useServices();
  const { t, lang } = useLang();
  const { navigate } = useNav();
  const calendarTexts = useCalendarTexts();
  const today = tashkentToday(now());
  const [category, setCategory] = useState<string>(DEFAULT_CATEGORY);
  const [date, setDate] = useState<string | null>(null);
  const [guests, setGuests] = useState("");
  const id = useId();
  // Гости — только где у витрин вместимость (залы): у остальных каталог по ним не отбирает
  const withGuests = hasCapacity(clientCategory(category));

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    navigate(
      hrefFor(
        { name: "catalog" },
        filtersQuery({ ...NO_FILTERS, category, date, guests: withGuests ? parseGuests(guests) : null }),
      ),
    );
  };

  return (
    <form
      className={withGuests ? "ln-search with-guests" : "ln-search"}
      aria-label={t.lnSearchLabel}
      onSubmit={onSubmit}
    >
      <div className="field ln-search-what">
        <label className="field-label" htmlFor={`${id}-what`}>
          {t.cats}
        </label>
        <Select
          id={`${id}-what`}
          label={t.cats}
          value={category}
          options={CLIENT_CATEGORIES.map((c) => ({
            value: c.code,
            label: categoryName(c.code, t, lang) ?? c.code,
          }))}
          onChange={setCategory}
        />
      </div>
      <div className="field">
        <label className="field-label" htmlFor={`${id}-date`}>
          {t.fDate}
        </label>
        <DateField
          id={`${id}-date`}
          label={t.fDate}
          placeholder={t.anyDateV}
          value={date}
          min={today}
          max={addDays(today, DATE_HORIZON_DAYS)}
          format={(value) => formatDayMonth(value, t)}
          texts={calendarTexts}
          clearLabel={t.anyDate}
          onChange={setDate}
        />
      </div>
      {withGuests ? (
        <div className="field">
          <label className="field-label" htmlFor={`${id}-guests`}>
            {t.fGuests}
          </label>
          <NumberStepper
            id={`${id}-guests`}
            min={1}
            max={MAX_GUESTS}
            placeholder={t.anyGuestV}
            value={guests}
            onChange={setGuests}
          />
        </div>
      ) : null}
      <button type="submit" className="btn btn-primary ln-search-go">
        <Icon name="search" size={17} />
        {t.lnSearch}
      </button>
    </form>
  );
}

/**
 * Исполнители из каталога — по одному из разных разделов, у каждого подписан раздел. В
 * разделе — первые по цене (как каталог по умолчанию; оплата на порядок не влияет). Разделы
 * здесь не перечисляются второй раз: выбор раздела — сетка выше
 */
function Featured() {
  const { api } = useServices();
  const { t } = useLang();
  const categories = useCatalogCategories();
  const plan = featuredPlan(categories);
  const venues = useAsync(
    `landing:featured:${plan ? `${plan.codes.join(",")}/${plan.per}` : "?"}`,
    (signal) =>
      plan
        ? Promise.all(
            plan.codes.map((code) =>
              api.catalog(
                { category: code === DEFAULT_CATEGORY ? undefined : code, limit: plan.per },
                signal,
              ),
            ),
          ).then((pages) => interleave(pages.map((page) => page.items)))
        : // Категории ещё в пути: ждём их, место под карточки уже держим
          new Promise<Card[]>(() => {}),
  );

  // Витрин нет ни в одном разделе, выдача не загрузилась или пуста — блока нет
  if (plan && plan.codes.length === 0) return null;
  if (venues.status === "error") return null;
  if (venues.status === "ready" && venues.data.length === 0) return null;

  return (
    <section
      className="ln-section ln-venues"
      aria-labelledby="ln-venues"
      aria-busy={venues.status === "loading"}
    >
      <div className="ln-head">
        <h2 className="ln-h2" id="ln-venues">
          {t.lnVenuesH}
        </h2>
        <p className="muted ln-head-note">{t.lnVenuesP}</p>
      </div>
      {venues.status === "ready" ? (
        <ul className="cards ln-cards">
          {venues.data.map((card) => (
            <li key={card.id}>
              <ListingCard
                card={card}
                date={null}
                guests={null}
                headingLevel={3}
                sizes={FEATURED_SIZES}
                // Раздел подписан, когда они разные (один раздел — подпись лишняя)
                showCategory={(plan?.codes.length ?? 0) > 1}
              />
            </li>
          ))}
        </ul>
      ) : (
        <ul className="cards ln-cards" aria-hidden="true">
          {Array.from({ length: FEATURED }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: заготовки одинаковые, порядок постоянный
            <li key={i} className="card-skeleton">
              <span className="card-skeleton-photo" />
              <span className="card-skeleton-body" />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function PartnerBlock() {
  const { api } = useServices();
  const { t, lang } = useLang();
  const methods = useAsync("auth-methods", (signal) => api.authMethods(signal));
  const vendor = methods.status === "ready" ? methods.data.apps.vendor : null;

  return (
    <section className="ln-section ln-partner" aria-labelledby="ln-partner">
      <span className="ln-partner-art girih" aria-hidden="true">
        <Icon name="decor" size={26} />
      </span>
      <div className="ln-partner-text">
        <h2 className="ln-h2" id="ln-partner">
          {t.lnPartnerH}
        </h2>
        <p>{t.lnPartnerP}</p>
        <p className="muted small">{t.lnPartnerNote}</p>
      </div>
      {/* Кабинет — другое приложение, полной загрузкой. Без ?signin=1: вне Telegram без входа
          он сначала объясняет, что это и как получить доступ, и уже оттуда — вход через хаб.
          ?lang= — кабинет на том же языке, что сайт */}
      {vendor ? (
        <a className="btn btn-secondary" href={`${vendor}/?lang=${lang}`}>
          {t.accVendor}
        </a>
      ) : null}
    </section>
  );
}

/** Значки первого экрана: по одному на несколько категорий — праздник целиком */
const HERO_ICONS: readonly IconName[] = ["hall", "car", "camera", "cake"];

export function Landing() {
  const { t } = useLang();
  useDocumentTitle(t.metaHomeTitle, t.metaHomeDesc, true);

  return (
    <div className="screen landing">
      <section className="ln-hero" aria-labelledby="ln-title">
        <div className="ln-hero-text">
          <p className="ln-kicker">{t.lnKicker}</p>
          <h1 className="ln-title" id="ln-title" tabIndex={-1}>
            {t.lnTitle}
          </h1>
          <p className="ln-lead">{t.lnLead}</p>
        </div>
        {/* Иллюстрация: узор гириха — только здесь, за картинкой, не за текстом */}
        <div className="ln-hero-art girih" aria-hidden="true">
          {HERO_ICONS.map((icon) => (
            <span key={icon} className="ln-hero-badge">
              <Icon name={icon} size={26} />
            </span>
          ))}
        </div>
        <QuickSearch />
      </section>

      <section className="ln-section ln-cats" aria-labelledby="ln-cats">
        <h2 className="ln-h2" id="ln-cats">
          {t.lnCatsH}
        </h2>
        <CategoryGrid />
      </section>

      <Featured />

      <section className="ln-section" aria-labelledby="ln-how">
        <h2 className="ln-h2" id="ln-how">
          {t.lnHowH}
        </h2>
        <ol className="ln-steps">
          {t.lnStepH.map((title, i) => (
            <li key={title} className="ln-step">
              <span className="ln-step-no" aria-hidden="true">
                {i + 1}
              </span>
              <h3 className="ln-h3">{title}</h3>
              <p>{t.lnStepP[i]}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="ln-section" aria-labelledby="ln-promises">
        <h2 className="ln-h2" id="ln-promises">
          {t.lnPromH}
        </h2>
        <ul className="ln-promises">
          {t.lnPromT.map((title, i) => (
            <li key={title} className="ln-promise">
              <Icon name={PROMISE_ICONS[i] ?? "checkFill"} size={24} className="ln-promise-ico" />
              <h3 className="ln-h3">{title}</h3>
              <p>{t.lnPromP[i]}</p>
            </li>
          ))}
        </ul>
      </section>

      <PartnerBlock />

      <section className="ln-section" aria-labelledby="ln-faq">
        <h2 className="ln-h2" id="ln-faq">
          {t.lnFaqH}
        </h2>
        <div className="docs ln-faq">
          {t.lnFaqQ.map((question, i) => (
            <details key={question} className="doc">
              <summary>
                <span>{question}</span>
              </summary>
              <p className="prose ln-faq-a">{t.lnFaqA[i]}</p>
            </details>
          ))}
        </div>
      </section>
    </div>
  );
}
