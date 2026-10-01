import { categoryText } from "@bayramm/shared/categories";
import { DateField, NumberStepper, Select } from "@bayramm/ui/react";
import { type FormEvent, useId, useState } from "react";
import { CLIENT_CATEGORIES, clientCategory, hasCapacity } from "../categories";
import { useCalendarTexts } from "../components/Calendar";
import { CategoryGrid, categoryHref, listingsIn, useCatalogCategories } from "../components/Categories";
import { Link } from "../components/Link";
import { ListingCard } from "../components/ListingCard";
import { useLang, useServices } from "../context";
import { addDays, formatDayMonth, tashkentToday } from "../format";
import { useAsync, useDocumentTitle } from "../hooks";
import { Icon, type IconName } from "../icons";
import { DEFAULT_CATEGORY, hrefFor, useNav } from "../router";
import { DATE_HORIZON_DAYS, filtersQuery, MAX_GUESTS, NO_FILTERS, parseGuests } from "./catalog-feed";

/* Лендинг (/) — для тех, кто открыл сайт в браузере; внутри Telegram корень — каталог.
   Блоки: первый экран про весь праздник с подбором (что ищете, дата; гости — где они есть →
   каталог категории с этими фильтрами), сетка категорий (пустая — с пометкой «скоро»),
   настоящие витрины из API по категориям (нет их — блока нет, заглушек под видом витрин не
   рисуем), как это работает, обещания клиенту — из правил продукта, вендорам, вопросы.
   Рейтингов, отзывов и выдуманных цифр нет. */

/** Сколько витрин показать на лендинге: ряд на компьютере, лента — на телефоне */
const FEATURED = 4;

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
          options={CLIENT_CATEGORIES.map((c) => ({ value: c.code, label: categoryText(lang, c.label) }))}
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
 * Витрины из каталога — по категориям, в том же порядке, что и каталог по умолчанию (по цене;
 * оплата не влияет). Категории — только с витринами; пока список не пришёл — все включённые
 */
function Featured() {
  const { api } = useServices();
  const { t, lang } = useLang();
  const categories = useCatalogCategories();
  const live = CLIENT_CATEGORIES.filter((c) => listingsIn(categories, c.code) !== false);
  const [picked, setPicked] = useState<string | null>(null);
  const current = live.find((c) => c.code === picked) ?? live[0] ?? null;
  const code = current?.code ?? DEFAULT_CATEGORY;
  const venues = useAsync(`landing:featured:${code}`, (signal) =>
    api.catalog({ category: code === DEFAULT_CATEGORY ? undefined : code, limit: FEATURED }, signal),
  );

  // Ни в одной категории витрин нет, выдача не загрузилась или пуста — блока нет
  if (categories.status === "ready" && live.length === 0) return null;
  if (venues.status === "error") return null;
  if (venues.status === "ready" && venues.data.items.length === 0) return null;
  const name = current ? categoryText(lang, current.label) : "";

  return (
    <section
      className="ln-section ln-venues"
      aria-labelledby="ln-venues"
      aria-busy={venues.status === "loading"}
    >
      <div className="ln-head">
        <div>
          <h2 className="ln-h2" id="ln-venues">
            {t.lnVenuesH}
          </h2>
          <p className="muted ln-head-note">{t.lnVenuesP}</p>
        </div>
        <Link className="btn btn-secondary ln-head-link" href={categoryHref(code)}>
          {t.lnSeeAll(name)}
        </Link>
      </div>
      {live.length > 1 ? (
        // biome-ignore lint/a11y/useSemanticElements: группа кнопок-переключателей с подписью, не поле формы
        <div className="ln-pick" role="group" aria-label={t.catSwitch}>
          {live.map((category) => (
            <button
              key={category.code}
              type="button"
              className="cat-chip"
              aria-pressed={category.code === code}
              onClick={() => setPicked(category.code)}
            >
              {categoryText(lang, category.label)}
            </button>
          ))}
        </div>
      ) : null}
      {venues.status === "ready" ? (
        <ul className="cards ln-cards">
          {venues.data.items.map((card) => (
            <li key={card.id}>
              <ListingCard card={card} date={null} guests={null} headingLevel={3} />
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
  const { t } = useLang();
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
          он сначала объясняет, что это и как получить доступ, и уже оттуда — вход через хаб */}
      {vendor ? (
        <a className="btn btn-secondary" href={`${vendor}/`}>
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
        <Link className="link-btn ln-browse" href={hrefFor({ name: "catalog" })}>
          {t.lnBrowse}
        </Link>
      </section>

      <section className="ln-section ln-cats" aria-labelledby="ln-cats">
        <div className="ln-head">
          <div>
            <h2 className="ln-h2" id="ln-cats">
              {t.lnCatsH}
            </h2>
            <p className="muted ln-head-note">{t.lnCatsP}</p>
          </div>
        </div>
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
