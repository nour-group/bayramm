/* Сведения о витрине — карточки-группы с «Изменить» у каждой (окно — ListingEdit.tsx):
     · «Основное» — описание, цена «от» (ссылка на «Услуги»: цены только там), телефон для заявок
       (его меняет менеджер Bayramm — под ним код вендора для разговора с ним); название — в
       шапке экрана или в выборе витрины, строкой здесь оно только когда его предложили сменить;
     · «Место» — район, адрес, вместимость (район — у категорий с district, вместимость — с
       guest_capacity);
     · «Данные витрины» — поля категории (по ним клиенты находят витрину в фильтрах каталога);
     · «Видео» — ссылки на YouTube и Instagram.
   Карточка показывает значения как их видят клиенты. Предложение на проверке затрагивает
   карточку — у неё метка «на проверке», а у строк, которые оно меняет, — «Предложено: …».
   «Изменить» нет у сотрудника площадки и пока предложение открыто (одно на витрину). */

import type { Lang } from "@bayramm/shared";
import type { ListingRevisionPayload, VendorListing, VendorRevision } from "@bayramm/shared/api/vendor";
import { type CategoryConfig, priceUnitLabel } from "@bayramm/shared/categories";
import { type MouseEvent, type ReactNode, useId } from "react";
import { AttributeFacts } from "./Attributes";
import { formatMoney, formatPhone } from "./format";
import { fill, textOf, type VendorDict } from "./i18n";
import { groupTitle } from "./ListingEdit";
import { type EditGroup, hasCapacity, hasDistrict, touchedGroups } from "./listing-edit";
import { type Location, type Navigate, pathOf } from "./router";

/** Ссылка на раздел без перезагрузки (новая вкладка, окно — как решит браузер) */
export function SectionLink({
  to,
  navigate,
  className,
  children,
}: {
  to: Location;
  navigate: Navigate;
  className: string;
  children: ReactNode;
}) {
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(to);
  };
  return (
    <a className={className} href={pathOf(to)} onClick={onClick}>
      {children}
    </a>
  );
}

/** Вместимость словами: «50–300 гостей», «до 300 гостей», пусто — «не указано» */
export function capacityText(min: number | null, max: number | null, t: VendorDict): string {
  if (max === null) return t.notSet;
  return min !== null ? fill(t.capRange, { min, max }) : fill(t.capUpTo, { max });
}

interface GroupsProps {
  readonly listing: VendorListing;
  readonly category: CategoryConfig | undefined;
  readonly t: VendorDict;
  readonly lang: Lang;
  readonly vendorCode: string;
  readonly navigate: Navigate;
  /** Открытое предложение: что оно меняет — у карточек метка и «Предложено» */
  readonly pending: VendorRevision | undefined;
  /** Открыть окно «Изменить»; нет — кнопок нет (сотрудник площадки, предложение уже открыто) */
  readonly onEdit: ((group: EditGroup) => void) | undefined;
}

/** «Предложено: …» под значением строки, которую меняет открытое предложение */
function Proposed({ children, t, lang }: { children: ReactNode; t: VendorDict; lang?: Lang }) {
  return (
    <span className="fact-sub fact-note">
      {t.proposedLabel} <span lang={lang}>{children}</span>
    </span>
  );
}

function Group({
  group,
  title,
  t,
  onEdit,
  review,
  children,
}: {
  group: EditGroup;
  title: string;
  t: VendorDict;
  onEdit: GroupsProps["onEdit"];
  /** Открытое предложение меняет эту карточку */
  review: boolean;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section className="panel group" aria-labelledby={id} data-group={group}>
      <div className="group-head">
        <h3 className="panel-title" id={id}>
          {title}
        </h3>
        {review ? <span className="chip chip-wait">{t.chipReview}</span> : null}
        {onEdit ? (
          <button
            type="button"
            className="btn btn-ghost group-edit"
            aria-label={`${t.edit}: ${title}`}
            onClick={() => onEdit(group)}
          >
            {t.edit}
          </button>
        ) : null}
      </div>
      {children}
    </section>
  );
}

export function VenueGroups({
  listing,
  category,
  t,
  lang,
  vendorCode,
  navigate,
  pending,
  onEdit,
}: GroupsProps) {
  const touched = touchedGroups(pending?.payload);
  const proposal: ListingRevisionPayload = pending?.payload ?? {};
  const districtName = (code: string) => textOf(t, `dist_${code}`);
  const showDistrict = hasDistrict(category) || listing.districtCode !== null;
  const showCapacity = hasCapacity(category);

  return (
    <>
      <Group
        group="basics"
        title={groupTitle("basics", t)}
        t={t}
        onEdit={onEdit}
        review={touched.has("basics")}
      >
        <dl className="detail-rows">
          {proposal.name !== undefined ? (
            <div>
              <dt>{t.nameLabel}</dt>
              <dd>
                {listing.name}
                <Proposed t={t}>{proposal.name}</Proposed>
              </dd>
            </div>
          ) : null}
          <div>
            <dt>{t.description}</dt>
            <dd className="description-row">
              <span className="description">{listing.description[lang] || t.notSet}</span>
              {proposal.description_ru !== undefined ? (
                <Proposed t={t} lang="ru">
                  {proposal.description_ru}
                </Proposed>
              ) : null}
              {proposal.description_uz !== undefined ? (
                <Proposed t={t} lang="uz">
                  {proposal.description_uz}
                </Proposed>
              ) : null}
            </dd>
          </div>
          <div>
            <dt>{t.priceLabel}</dt>
            <dd>
              {listing.priceFromUzs !== null
                ? `${fill(t.priceFrom, { price: formatMoney(listing.priceFromUzs, t, lang) })} ${priceUnitLabel(
                    lang,
                    listing.priceUnit,
                  )}`
                : t.notSet}
              <SectionLink to={{ route: "services" }} navigate={navigate} className="btn btn-ghost fact-link">
                {t.toServices}
              </SectionLink>
            </dd>
          </div>
          <div>
            <dt>{t.phoneLabel}</dt>
            <dd className="fact-phone">{listing.phone ? formatPhone(listing.phone) : t.notSet}</dd>
          </div>
        </dl>
        <p className="note">{fill(t.managerFacts, { code: vendorCode })}</p>
      </Group>

      <Group group="place" title={groupTitle("place", t)} t={t} onEdit={onEdit} review={touched.has("place")}>
        <dl className="detail-rows">
          {showDistrict ? (
            <div>
              <dt>{t.district}</dt>
              <dd>
                {listing.districtCode ? districtName(listing.districtCode) : t.notSet}
                {proposal.district_code !== undefined ? (
                  <Proposed t={t}>{districtName(proposal.district_code)}</Proposed>
                ) : null}
              </dd>
            </div>
          ) : null}
          <div>
            <dt>{t.address}</dt>
            <dd>
              {listing.address[lang] || t.notSet}
              {proposal.address_ru !== undefined ? (
                <Proposed t={t} lang="ru">
                  {proposal.address_ru || t.notSet}
                </Proposed>
              ) : null}
              {proposal.address_uz !== undefined ? (
                <Proposed t={t} lang="uz">
                  {proposal.address_uz || t.notSet}
                </Proposed>
              ) : null}
            </dd>
          </div>
          {showCapacity ? (
            <div>
              <dt>{t.capacity}</dt>
              <dd>
                {capacityText(listing.capMin, listing.capMax, t)}
                {proposal.cap_min !== undefined || proposal.cap_max !== undefined ? (
                  <Proposed t={t}>
                    {capacityText(proposal.cap_min ?? listing.capMin, proposal.cap_max ?? listing.capMax, t)}
                  </Proposed>
                ) : null}
              </dd>
            </div>
          ) : null}
        </dl>
      </Group>

      {category && category.attributes.length > 0 ? (
        <Group
          group="attributes"
          title={groupTitle("attributes", t)}
          t={t}
          onEdit={onEdit}
          review={touched.has("attributes")}
        >
          {Object.keys(listing.attributes).length === 0 ? (
            <p className="note">{t.notSet}</p>
          ) : (
            <AttributeFacts category={category} attributes={listing.attributes} t={t} lang={lang} />
          )}
          {proposal.attributes !== undefined ? (
            <div className="proposed-block">
              <span className="fact-sub">{t.proposedLabel}</span>
              <AttributeFacts category={category} attributes={proposal.attributes} t={t} lang={lang} />
            </div>
          ) : null}
        </Group>
      ) : null}

      {(category?.maxVideoLinks ?? 0) > 0 || listing.videoLinks.length > 0 ? (
        <Group
          group="videos"
          title={groupTitle("videos", t)}
          t={t}
          onEdit={onEdit}
          review={touched.has("videos")}
        >
          {listing.videoLinks.length === 0 ? (
            <p className="note">{t.notSet}</p>
          ) : (
            <ul className="video-list">
              {listing.videoLinks.map((link) => (
                <li key={link}>{link}</li>
              ))}
            </ul>
          )}
          {proposal.video_links !== undefined ? (
            <div className="proposed-block">
              <span className="fact-sub">{t.proposedLabel}</span>
              {proposal.video_links.length === 0 ? (
                <p className="note">{t.notSet}</p>
              ) : (
                <ul className="video-list">
                  {proposal.video_links.map((link) => (
                    <li key={link}>{link}</li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}
        </Group>
      ) : null}
    </>
  );
}
