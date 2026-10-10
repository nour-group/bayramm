/* Вендоры: поиск, фильтры по статусу и категории витрин, таблица. Строка ведёт на страницу
   вендора; у каждой витрины — её категория. Поиск, фильтры и страница — в адресе (?q=&status=
   &category=&page=): «назад» из вендора возвращает тот же список. Список — страницами: на
   компьютере листается, на телефоне «Показать ещё» дописывает следующую. */

import type { ListingStatus, VendorList, VendorListItem } from "@bayramm/shared/api/staff";
import { Dialog, RadioGroup, type RadioOption, SearchField, Select } from "@bayramm/ui/react";
import { useState } from "react";
import { useCan } from "../api";
import { CategoryChip, categoryName, categoryOptions, knownCategory } from "../categories";
import { usePhone } from "../layout";
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
  StatusPill,
  useListSearch,
  usePagedList,
} from "../ui";

const STATUSES: readonly ListingStatus[] = ["lead", "draft", "review", "active", "suspended", "rejected"];

/** Вендоров на странице */
const PAGE = 50;

const KEYS = ["q", "status", "category", "page"] as const;

const statusOf = (value: string | undefined): ListingStatus | null =>
  STATUSES.find((status) => status === value) ?? null;

/** Варианты статуса витрины; в шторке у «Лида» — подсказка, что это значит */
const statusOptions = (hints: boolean): RadioOption<ListingStatus | "all">[] => [
  { value: "all", label: t.all },
  ...STATUSES.map((status) => {
    const hint = hints ? t.statusHints[status] : undefined;
    return { value: status, label: t.status[status], ...(hint ? { hint } : {}) };
  }),
];

export function VendorsPage() {
  const can = useCan();
  const phone = usePhone();
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
          <Select
            size="compact"
            label={t.colCategory}
            value={category ?? ""}
            onChange={(code) => setCategory(code === "" ? null : code)}
            options={[{ value: "", label: t.allCategories }, ...categoryOptions()]}
          />
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
            options={statusOptions(true)}
          />
          <RadioGroup<string>
            variant="row"
            label={t.colCategory}
            value={category ?? "all"}
            onChange={(value) => setCategory(value === "all" ? null : value)}
            options={[{ value: "all", label: t.allCategories }, ...categoryOptions()]}
          />
        </Dialog>
      ) : (
        <div className="filter-row">
          <RadioGroup<ListingStatus | "all">
            variant="pill"
            label={t.vendorsListingStatus}
            name="vendors-status"
            value={status ?? "all"}
            onChange={(value) => setStatus(value === "all" ? null : value)}
            options={statusOptions(false)}
          />
          {status === "lead" ? <p className="muted small">{t.statusHints.lead}</p> : null}
        </div>
      )}
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
              {phone ? <VendorCards items={list.items} /> : <VendorTable items={list.items} />}
              <ListFooter list={list} offset={offset} size={PAGE} onPage={onPage} />
            </>
          )
        }
      </LoadedView>
    </div>
  );
}

const checksDone = (vendor: VendorListItem) => Object.values(vendor.checklist).filter(Boolean).length;

function VendorCards({ items }: { items: readonly VendorListItem[] }) {
  return (
    <ul className="rcards">
      {items.map((vendor) => {
        const done = checksDone(vendor);
        return (
          <li key={vendor.id} className="rcard rcard-tap">
            <div className="rcard-head">
              <Link to={{ name: "vendor", id: vendor.id }} className="rcard-link">
                {vendor.name ?? vendor.legalName ?? vendor.code}
              </Link>
              {/* Что значит «0/4» — словами и на виду: на телефоне заголовка столбца нет */}
              <span className={`ring${done === 4 ? " ring-done" : ""}`}>
                {t.colChecklist} {done}/4
              </span>
            </div>
            <p className="rcard-meta">
              {vendor.code}
              {vendor.managerName ? ` · ${vendor.managerName}` : ""}
            </p>
            <dl className="rcard-facts">
              <dt>{t.colContact}</dt>
              <dd>
                {vendor.contactPerson ?? t.none}
                {vendor.legalName ? ` · ${vendor.legalName}` : ""}
              </dd>
              <dt>{t.colCabinet}</dt>
              <dd>{t.cabinetUsers(vendor.users, vendor.linkedUsers)}</dd>
            </dl>
            {vendor.listings.length === 0 ? (
              <p className="rcard-meta">{t.noListings}</p>
            ) : (
              <ul className="rcard-tags" aria-label={t.colListings}>
                {vendor.listings.map((listing) => (
                  <li key={listing.id}>
                    {listing.name} <CategoryChip code={listing.categoryCode} />{" "}
                    <StatusPill status={listing.status} />
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
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th scope="col">{t.colVendor}</th>
            <th scope="col">{t.colContact}</th>
            <th scope="col">{t.colListings}</th>
            <th scope="col">{t.colChecklist}</th>
            <th scope="col">{t.colCabinet}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((vendor) => {
            const done = checksDone(vendor);
            return (
              <tr key={vendor.id}>
                <td>
                  <Link to={{ name: "vendor", id: vendor.id }} className="row-link">
                    {vendor.name ?? vendor.legalName ?? vendor.code}
                  </Link>
                  <span className="sub">
                    {vendor.code}
                    {vendor.managerName ? ` · ${vendor.managerName}` : ""}
                  </span>
                </td>
                <td>
                  {vendor.contactPerson ?? t.none}
                  {vendor.legalName && <span className="sub">{vendor.legalName}</span>}
                </td>
                <td>
                  {vendor.listings.length === 0 ? (
                    <span className="muted">{t.noListings}</span>
                  ) : (
                    <ul className="plain">
                      {vendor.listings.map((listing) => (
                        <li key={listing.id}>
                          <Link to={{ name: "listing", id: listing.id }}>{listing.name}</Link>{" "}
                          <CategoryChip code={listing.categoryCode} /> <StatusPill status={listing.status} />
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
                <td>
                  <span className={`ring${done === 4 ? " ring-done" : ""}`}>{done}/4</span>
                </td>
                <td>{t.cabinetUsers(vendor.users, vendor.linkedUsers)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
