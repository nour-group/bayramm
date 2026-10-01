import type { Dict } from "@bayramm/shared";
import { type ListingCard as Card, type DateLoad, estimatedTotalUzs } from "@bayramm/shared/api";
import { categoryName, clientCategory, hasCalendar } from "../categories";
import { useDictionaries, useLang } from "../context";
import { formatDayMonth, formatMoney, formatPriceFrom } from "../format";
import { hrefFor } from "../router";
import { FavoriteButton } from "./FavoriteButton";
import { Link } from "./Link";
import { NewBadge } from "./NewBadge";
import { Photo } from "./Photo";

interface ListingCardProps {
  readonly card: Card;
  /** Дата из фильтра: по ней отметка «свободно / частично занято / занято» */
  readonly date: string | null;
  readonly guests: number | null;
  readonly eager?: boolean;
  /** Уровень заголовка с названием: 2 — в списке экрана, 3 — в разделе лендинга */
  readonly headingLevel?: 2 | 3;
  /** Подписать категорию: в списке из разных категорий («Сохранённое») */
  readonly showCategory?: boolean;
}

/**
 * Ширина фото в сетке карточек (styles.css, .cards): одна колонка на телефоне, две с 640px,
 * три с 1024px, четыре с 1280px (колонка ~300px). По ней браузер выбирает вариант из srcset
 */
export const CARD_PHOTO_SIZES =
  "(min-width: 1280px) 300px, (min-width: 1024px) 31vw, (min-width: 640px) 50vw, 100vw";

/** Отметка загрузки на дату: текст и вид чипа */
export function dayLoadChip(load: DateLoad, date: string, t: Dict): { text: string; tone: string } {
  const day = formatDayMonth(date, t);
  switch (load) {
    case "busy":
      return { text: t.dayBusy(day), tone: "chip chip-busy" };
    case "partial":
      return { text: t.dayPartial(day), tone: "chip chip-partial" };
    case "free":
      return { text: t.dayFree(day), tone: "chip chip-free" };
  }
}

/**
 * Карточка витрины в выдаче. Рейтинга и отзывов нет (правило продукта): вместо них — «Новый».
 * Сердечко «Сохранить» — в углу фото, как в прототипе. Цена «от» — с единицей категории
 * («за час», «за кг»…); вместимость — только у залов.
 * Занятая на дату не прячется и не бледнеет текстом: отметка «занято» и приглушённое фото;
 * занятая частью дня (кортеж, фото, декор) — «частично занято». У категорий без календаря
 * (заказ за N дней) отметки на дату нет. С числом гостей у цены за гостя — примерная сумма
 * на них: по ней и сортирует каталог
 */
export function ListingCard({
  card,
  date,
  guests,
  eager,
  headingLevel = 2,
  showCategory = false,
}: ListingCardProps) {
  const { t, lang } = useLang();
  const { districtName } = useDictionaries();
  const price = formatPriceFrom(card.priceFromUzs, card.priceUnit, t);
  const district = districtName(card.districtCode);
  const busy = card.busyOnDate === true;
  const load: DateLoad | null = card.dateLoad ?? (card.busyOnDate === null ? null : busy ? "busy" : "free");
  const chip =
    date && load !== null && hasCalendar(clientCategory(card.categoryCode))
      ? dayLoadChip(load, date, t)
      : null;
  const estimate =
    guests !== null && card.priceUnit === "per_guest"
      ? t.estimateFor(formatMoney(estimatedTotalUzs(card, guests), t), guests)
      : null;
  const href = hrefFor({ name: "venue", slug: card.slug }, { date, guests });
  const Name = headingLevel === 3 ? "h3" : "h2";
  const meta = [
    showCategory ? categoryName(card.categoryCode, lang) : null,
    district,
    card.capMax === null ? null : t.people(card.capMax),
  ].filter(Boolean);

  return (
    <article className={busy ? "card busy" : "card"}>
      <Link href={href} className="card-link">
        <div className="card-photo">
          <Photo photo={card.cover} alt="" sizes={CARD_PHOTO_SIZES} eager={eager} />
          <span className="card-badges">{chip ? <span className={chip.tone}>{chip.text}</span> : null}</span>
        </div>
        <div className="card-body">
          <div className="card-top">
            <Name className="card-name">{card.name}</Name>
            <NewBadge />
          </div>
          {meta.length > 0 ? <p className="card-meta">{meta.join(" · ")}</p> : null}
          <p className="card-price">
            <b>{price.amount}</b>
            {price.unit ? <span className="unit"> {price.unit}</span> : null}
          </p>
          {estimate ? <p className="card-estimate">{estimate}</p> : null}
        </div>
      </Link>
      {/* Сердечко — рядом со ссылкой, а не внутри: кнопка в ссылке недопустима */}
      <FavoriteButton listing={card} />
    </article>
  );
}
