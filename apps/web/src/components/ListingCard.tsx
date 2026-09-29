import type { ListingCard as Card } from "@bayramm/shared/api";
import { useDictionaries, useLang } from "../context";
import { formatDayMonth, formatPriceFrom } from "../format";
import { hrefFor } from "../router";
import { Link } from "./Link";
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
 * Занятый на дату зал не прячется и не бледнеет текстом: отметка «занято» и приглушённое фото
 */
export function ListingCard({ card, date, guests, eager }: ListingCardProps) {
  const { t } = useLang();
  const { districtName } = useDictionaries();
  const price = formatPriceFrom(card.priceFromUzs, card.priceUnit, t);
  const district = districtName(card.districtCode);
  const busy = card.busyOnDate === true;
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
            <span className="badge-new" title={t.newBadgeHint}>
              {t.newBadge}
            </span>
          </div>
          <p className="card-meta">{[district, t.people(card.capMax)].filter(Boolean).join(" · ")}</p>
          <p className="card-price">
            <b>{price.amount}</b>
            {price.unit ? <span className="unit"> {price.unit}</span> : null}
          </p>
        </div>
      </Link>
    </article>
  );
}
