/* Вендоры: поиск, фильтры по статусу и категории витрин, таблица. Строка ведёт на страницу
   вендора; у каждой витрины — её категория. Поиск, фильтры и страница — в адресе (?q=&status=
   &category=&page=): «назад» из вендора возвращает тот же список. Список — страницами: на
   компьютере листается, на телефоне «Показать ещё» дописывает следующую.

   В строке — только то, что нужно, чтобы найти вендора и понять, куда идти: название, под ним код,
   контактное лицо и юрназвание; витрины — статус только у тех, что не на сайте. «Что не так» —
   плашки только в проблемных состояниях: проверка ниже 4/4, нет входа в кабинет или уведомления
   никому не приходят (ни у кого не привязан Telegram). У всего в порядке — пусто. */

import type { ListingStatus, VendorList, VendorListItem } from "@bayramm/shared/api/staff";
import { Dialog, RadioGroup, type RadioOption, SearchField, Select } from "@bayramm/ui/react";
import { useState } from "react";
import { useCan } from "../api";
import { CategoryChip, categoryName, categoryOptions, knownCategory } from "../categories";
import { useLayout, usePhone } from "../layout";
import { useQueryState } from "../router";
import { t } from "../texts";
import {
  ActionBar,
  ActiveFilter,
  EmptyList,
  FilterButton,
  Link,
  ListFooter,
  LoadedView,
  offsetOf,
  Pill,
  StatusPill,
  TableWrap,
  useListSearch,
  usePagedList,
} from "../ui";

const STATUSES: readonly ListingStatus[] = ["lead", "draft", "review", "active", "suspended", "rejected"];

/** Вендоров на странице */
const PAGE = 50;

const KEYS = ["q", "status", "category", "page"] as const;

const statusOf = (value: string | undefined): ListingStatus | null =>
  STATUSES.find((status) => status === value) ?? null;

/** Варианты статуса витрины для шторки на телефоне */
const statusOptions = (): RadioOption<ListingStatus | "all">[] => [
  { value: "all", label: t.all },
  ...STATUSES.map((status) => ({ value: status, label: t.status[status] })),
];

export function VendorsPage() {
  const can = useCan();
  const phone = usePhone();
  // Уже компьютера таблица не помещается — карточками, как на телефоне
  const cards = useLayout() !== "desktop";
  const [query, setQuery] = useQueryState(KEYS);
  // Поиск — в адрес, когда перестали печатать; новый поиск — с первой страницы
  const [q, setQ] = useListSearch(query.q ?? "", (search) => setQuery({ q: search, page: null }));
  const status = statusOf(query.status);
  const category = knownCategory(query.category);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const offset = phone ? 0 : offsetOf(query.page, PAGE);
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (status) params.set("listingStatus", status);
  if (category) params.set("category", category);
  const list = usePagedList<VendorListItem, VendorList>(`/staff/vendors?${params}`, {
    size: PAGE,
    offset,
    append: phone,
  });
  const filtered = Boolean(query.q || status || category);
  const setStatus = (next: ListingStatus | null) => setQuery({ status: next, page: null });
  const setCategory = (next: string | null) => setQuery({ category: next, page: null });
  const reset = () => {
    setQ("");
    setQuery({ q: null, status: null, category: null, page: null });
  };
  const onPage = (next: number) => {
    setQuery({ page: next > 0 ? String(next / PAGE + 1) : null });
    window.scrollTo?.(0, 0);
  };

  return (
    <div className="stack">
      <div className="toolbar">
        <SearchField
          className="search"
          value={q}
          onChange={setQ}
          placeholder={t.vendorsSearch}
          aria-label={t.search}
          maxLength={100}
        />
        {phone ? (
          <FilterButton
            count={(status ? 1 : 0) + (category ? 1 : 0)}
            open={filtersOpen}
            onOpen={() => setFiltersOpen(true)}
          />
        ) : (
          <>
            <Select
              size="compact"
              label={t.vendorsListingStatus}
              value={status ?? ""}
              onChange={(value) => setStatus(statusOf(value))}
              options={[
                { value: "", label: t.allStatuses },
                ...STATUSES.map((s) => ({ value: s, label: t.status[s] })),
              ]}
            />
            <Select
              size="compact"
              label={t.colCategory}
              value={category ?? ""}
              onChange={(code) => setCategory(code === "" ? null : code)}
              options={[{ value: "", label: t.allCategories }, ...categoryOptions()]}
            />
          </>
        )}
        {can("vendors.write") && !phone && (
          <Link to={{ name: "vendorNew" }} className="btn btn-primary">
            {t.newVendor}
          </Link>
        )}
      </div>
      {phone && status ? <ActiveFilter label={t.status[status]} onClear={() => setStatus(null)} /> : null}
      {phone && category ? (
        <ActiveFilter label={categoryName(category)} onClear={() => setCategory(null)} />
      ) : null}
      {phone ? (
        <Dialog
          open={filtersOpen}
          title={t.filters}
          onClose={() => setFiltersOpen(false)}
          actions={
            <>
              <button
                type="button"
                className="ui-btn ui-btn-secondary"
                onClick={() => setQuery({ status: null, category: null, page: null })}
              >
                {t.reset}
              </button>
              <button type="button" className="ui-btn ui-btn-primary" onClick={() => setFiltersOpen(false)}>
                {t.done}
              </button>
            </>
          }
        >
          <RadioGroup<ListingStatus | "all">
            variant="row"
            label={t.vendorsListingStatus}
            value={status ?? "all"}
            onChange={(value) => setStatus(value === "all" ? null : value)}
            options={statusOptions()}
          />
          <RadioGroup<string>
            variant="row"
            label={t.colCategory}
            value={category ?? "all"}
            onChange={(value) => setCategory(value === "all" ? null : value)}
            options={[{ value: "all", label: t.allCategories }, ...categoryOptions()]}
          />
        </Dialog>
      ) : null}
      {/* Телефон: «Новый вендор» — в панели действий внизу, под большим пальцем */}
      {can("vendors.write") && phone ? (
        <ActionBar label={t.vendors}>
          <Link to={{ name: "vendorNew" }} className="btn btn-primary">
            {t.newVendor}
          </Link>
        </ActionBar>
      ) : null}
      <LoadedView loaded={list.loaded} onRetry={list.reload}>
        {() =>
          list.items.length === 0 ? (
            filtered ? (
              <EmptyList text={t.vendorsFilteredEmpty} onReset={reset} />
            ) : (
              <EmptyList text={t.vendorsEmptyAll} />
            )
          ) : (
            <>
              {cards ? <VendorCards items={list.items} /> : <VendorTable items={list.items} />}
              <ListFooter list={list} offset={offset} size={PAGE} onPage={onPage} />
            </>
          )
        }
      </LoadedView>
    </div>
  );
}

const checksDone = (vendor: VendorListItem) => Object.values(vendor.checklist).filter(Boolean).length;

const nameOf = (vendor: VendorListItem) => vendor.name ?? vendor.legalName ?? vendor.code;

/** «Шахло Каримова · ООО «Лола Холл»» — кого и с кем искать; пусто — строки нет */
const whoOf = (vendor: VendorListItem) =>
  [vendor.contactPerson, vendor.legalName].filter((part): part is string => Boolean(part)).join(" · ");

/** Что не так у вендора — только проблемные состояния; всё в порядке — ничего */
function Attention({ vendor }: { vendor: VendorListItem }) {
  const done = checksDone(vendor);
  // Уведомления не приходят, когда Telegram не привязан ни у кого из действующих пользователей
  const cabinet = vendor.users === 0 ? t.cabinetNone : vendor.linkedUsers === 0 ? t.cabinetNoNotify : null;
  if (done === 4 && cabinet === null) return null;
  return (
    <span className="attention">
      {done < 4 ? <Pill tone="outline">{t.checksShort(done)}</Pill> : null}
      {cabinet !== null ? <Pill tone="warn">{cabinet}</Pill> : null}
    </span>
  );
}

/** Витрина в строке вендора: статус — только у тех, что не на сайте */
function ListingTag({ listing }: { listing: VendorListItem["listings"][number] }) {
  return (
    <>
      {listing.name} <CategoryChip code={listing.categoryCode} />
      {listing.status === "active" ? null : (
        <>
          {" "}
          <StatusPill status={listing.status} />
        </>
      )}
    </>
  );
}

function VendorCards({ items }: { items: readonly VendorListItem[] }) {
  return (
    <ul className="rcards">
      {items.map((vendor) => {
        const who = whoOf(vendor);
        return (
          <li key={vendor.id} className="rcard rcard-tap">
            <Link to={{ name: "vendor", id: vendor.id }} className="rcard-link">
              {nameOf(vendor)}
            </Link>
            <p className="rcard-meta">
              {vendor.code}
              {vendor.managerName ? ` · ${vendor.managerName}` : ""}
            </p>
            {who ? <p className="rcard-meta">{who}</p> : null}
            <Attention vendor={vendor} />
            {vendor.listings.length === 0 ? (
              <p className="rcard-meta">{t.noListings}</p>
            ) : (
              <ul className="rcard-tags" aria-label={t.colListings}>
                {vendor.listings.map((listing) => (
                  <li key={listing.id}>
                    <ListingTag listing={listing} />
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function VendorTable({ items }: { items: readonly VendorListItem[] }) {
  return (
    <TableWrap label={t.vendors}>
      <table className="table">
        <thead>
          <tr>
            <th scope="col">{t.colVendor}</th>
            <th scope="col">{t.colListings}</th>
            <th scope="col">{t.colAttention}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((vendor) => {
            const who = whoOf(vendor);
            return (
              <tr key={vendor.id}>
                <td>
                  <Link to={{ name: "vendor", id: vendor.id }} className="row-link">
                    {nameOf(vendor)}
                  </Link>
                  <span className="sub">
                    {vendor.code}
                    {vendor.managerName ? ` · ${vendor.managerName}` : ""}
                  </span>
                  {who ? <span className="sub">{who}</span> : null}
                </td>
                <td>
                  {vendor.listings.length === 0 ? (
                    <span className="muted">{t.noListings}</span>
                  ) : (
                    <ul className="plain">
                      {vendor.listings.map((listing) => (
                        <li key={listing.id}>
                          <Link to={{ name: "listing", id: listing.id }}>{listing.name}</Link>{" "}
                          <CategoryChip code={listing.categoryCode} />
                          {listing.status === "active" ? null : (
                            <>
                              {" "}
                              <StatusPill status={listing.status} />
                            </>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
                <td>
                  <Attention vendor={vendor} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </TableWrap>
  );
}
