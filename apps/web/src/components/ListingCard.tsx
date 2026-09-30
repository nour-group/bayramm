import { type ListingCard as Card, estimatedTotalUzs } from "@bayramm/shared/api";
import { useDictionaries, useLang } from "../context";
import { formatDayMonth, formatMoney, formatPriceFrom } from "../format";
import { hrefFor } from "../router";
import { FavoriteButton } from "./FavoriteButton";
import { Link } from "./Link";
import { NewBadge } from "./NewBadge";
import { Photo } from "./Photo";

interface ListingCardProps {
  readonly card: Card;
  /** Дата из фильтра: по ней отметка «свободно/занято» */
  readonly date: string | null;
  readonly guests: number | null;
  readonly eager?: boolean;
}

/**
 * Карточка зала в выдаче. Рейтинга и отзывов нет (правило продукта): вместо них — «Новый».
 * Сердечко «Сохранить» — в углу фото, как в прототипе.
 * Занятый на дату зал не прячется и не бледнеет текстом: отметка «занято» и приглушённое фото.
 * С числом гостей у цены за гостя — примерная сумма на них: по ней и сортирует каталог
 */
export function ListingCard({ card, date, guests, eager }: ListingCardProps) {
  const { t } = useLang();
  const { districtName } = useDictionaries();
  const price = formatPriceFrom(card.priceFromUzs, card.priceUnit, t);
  const district = districtName(card.districtCode);
  const busy = card.busyOnDate === true;
  const estimate =
    guests !== null && card.priceUnit === "per_guest"
      ? t.estimateFor(formatMoney(estimatedTotalUzs(card, guests), t), guests)
      : null;
  const href = hrefFor({ name: "venue", slug: card.slug }, { date, guests });

  return (
    <article className={busy ? "card busy" : "card"}>
      <Link href={href} className="card-link">
        <div className="card-photo">
          <Photo photo={card.cover} alt="" sizes="(min-width: 640px) 50vw, 100vw" eager={eager} />
          <span className="card-badges">
            {date && card.busyOnDate !== null ? (
              <span className={busy ? "chip chip-busy" : "chip chip-free"}>
                {busy ? t.dayBusy(formatDayMonth(date, t)) : t.dayFree(formatDayMonth(date, t))}
              </span>
            ) : null}
          </span>
        </div>
        <div className="card-body">
          <div className="card-top">
            <h2 className="card-name">{card.name}</h2>
            <NewBadge />
          </div>
          <p className="card-meta">{[district, t.people(card.capMax)].filter(Boolean).join(" · ")}</p>
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
