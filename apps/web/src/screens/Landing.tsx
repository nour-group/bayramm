import { DateField, NumberStepper, Select } from "@bayramm/ui/react";
import { type FormEvent, useId, useState } from "react";
import { useCalendarTexts } from "../components/Calendar";
import { Link } from "../components/Link";
import { ListingCard } from "../components/ListingCard";
import { pick, useDictionaries, useLang, useServices } from "../context";
import { addDays, formatDayMonth, tashkentToday } from "../format";
import { useAsync, useDocumentTitle } from "../hooks";
import { Icon, type IconName } from "../icons";
import { hrefFor, useNav } from "../router";
import { DATE_HORIZON_DAYS, filtersQuery, MAX_GUESTS, NO_FILTERS, parseGuests } from "./catalog-feed";

/* Лендинг (/) — для тех, кто открыл сайт в браузере; внутри Telegram корень — каталог.
   Блоки: первый экран с подбором (дата, гости, район → каталог с этими фильтрами),
   настоящие опубликованные залы из API (нет их — блока нет, заглушек под видом залов
   не рисуем), как это работает, обещания клиенту — из правил продукта, площадкам,
   вопросы. Рейтингов, отзывов и выдуманных цифр нет. */

/** Сколько залов показать на лендинге: ряд на компьютере, два — на телефоне */
const FEATURED = 4;

/** Обещания — по порядку lnPromT/lnPromP; иконки — смысловые (duotone) */
const PROMISE_ICONS: readonly IconName[] = ["shieldD", "checkFill", "phone", "clockD"];

function QuickSearch() {
  const { now } = useServices();
  const { t, lang } = useLang();
  const { state: dicts } = useDictionaries();
  const { navigate } = useNav();
  const calendarTexts = useCalendarTexts();
  const today = tashkentToday(now());
  const [date, setDate] = useState<string | null>(null);
  const [guests, setGuests] = useState("");
  const [district, setDistrict] = useState("");
  const id = useId();
  const districts = dicts.status === "ready" ? dicts.data.districts : [];

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    navigate(
      hrefFor(
        { name: "catalog" },
        filtersQuery({ ...NO_FILTERS, date, guests: parseGuests(guests), district: district || null }),
      ),
    );
  };

  return (
    <form className="ln-search" aria-label={t.lnSearchLabel} onSubmit={onSubmit}>
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
      <div className="field">
        <label className="field-label" htmlFor={`${id}-district`}>
          {t.fDistrict}
        </label>
        <Select
          id={`${id}-district`}
          label={t.fDistrict}
          value={district}
          options={[
            { value: "", label: t.anyDistrict },
            ...districts.map((item) => ({ value: item.code, label: pick(item.name, lang) })),
          ]}
          onChange={setDistrict}
        />
      </div>
      <button type="submit" className="btn btn-primary ln-search-go">
        <Icon name="search" size={17} />
        {t.lnSearch}
      </button>
    </form>
  );
}

/** Залы из каталога — в том же порядке, что и каталог по умолчанию (по цене; оплата не влияет) */
function Featured() {
  const { api } = useServices();
  const { t } = useLang();
  const venues = useAsync("landing:featured", (signal) => api.catalog({ limit: FEATURED }, signal));

  // Пока грузятся — место под карточки (без сдвига вёрстки); пусто или ошибка — блока нет
  if (venues.status === "error") return null;
  if (venues.status === "ready" && venues.data.items.length === 0) return null;

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
        <Link className="btn btn-secondary ln-head-link" href={hrefFor({ name: "catalog" })}>
          {t.lnVenuesAll}
        </Link>
      </div>
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
        <Icon name="hall" size={26} />
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
          <span className="ln-hero-badge">
            <Icon name="hall" size={26} />
          </span>
        </div>
        <QuickSearch />
        <Link className="link-btn ln-browse" href={hrefFor({ name: "catalog" })}>
          {t.lnBrowse}
        </Link>
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
