/* Вендоры: поиск, фильтры по статусу и категории витрин, таблица. Строка ведёт на страницу
   вендора; у каждой витрины — её категория. */

import type { ListingStatus, VendorList } from "@bayramm/shared/api/staff";
import { Dialog, RadioGroup, SearchField, Select } from "@bayramm/ui/react";
import { useEffect, useState } from "react";
import { useCan, useLoad } from "../api";
import { CategoryChip, categoryName, categoryOptions } from "../categories";
import { usePhone } from "../layout";
import { t } from "../texts";
import { ActionBar, ActiveFilter, FilterButton, Link, LoadedView, StatusPill } from "../ui";

const FILTERS: readonly (ListingStatus | null)[] = [
  null,
  "lead",
  "draft",
  "review",
  "active",
  "suspended",
  "rejected",
];

/** Значение с задержкой: запрос к API — когда человек перестал печатать */
function useDebounced<T>(value: T, ms = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

export function VendorsPage() {
  const can = useCan();
  const phone = usePhone();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<ListingStatus | null>(null);
  const [category, setCategory] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const query = useDebounced(q.trim());
  const params = new URLSearchParams({ limit: "100" });
  if (query) params.set("q", query);
  if (status) params.set("listingStatus", status);
  if (category) params.set("category", category);
  const { loaded, reload } = useLoad<VendorList>(`/staff/vendors?${params}`);

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
                onClick={() => {
                  setStatus(null);
                  setCategory(null);
                }}
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
            label={t.listingFields.status ?? ""}
            value={status ?? "all"}
            onChange={(value) => setStatus(value === "all" ? null : value)}
            options={FILTERS.map((filter) => ({
              value: filter ?? "all",
              label: filter ? t.status[filter] : t.all,
            }))}
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
        <fieldset className="chips">
          <legend className="visually-hidden">{t.listingFields.status}</legend>
          {FILTERS.map((filter) => (
            <button
              key={filter ?? "all"}
              type="button"
              className="chip"
              aria-pressed={status === filter}
              onClick={() => setStatus(filter)}
            >
              {filter ? t.status[filter] : t.all}
            </button>
          ))}
        </fieldset>
      )}
      {/* Телефон: «Новый вендор» — в панели действий внизу, под большим пальцем */}
      {can("vendors.write") && phone ? (
        <ActionBar label={t.vendors}>
          <Link to={{ name: "vendorNew" }} className="btn btn-primary">
            {t.newVendor}
          </Link>
        </ActionBar>
      ) : null}
      <LoadedView loaded={loaded} onRetry={reload}>
        {(list) =>
          list.items.length === 0 ? (
            <p className="empty">{query || status || category ? t.vendorsEmpty : t.vendorsEmptyAll}</p>
          ) : phone ? (
            <>
              <ul className="rcards">
                {list.items.map((vendor) => {
                  const done = Object.values(vendor.checklist).filter(Boolean).length;
                  return (
                    <li key={vendor.id} className="rcard rcard-tap">
                      <div className="rcard-head">
                        <Link to={{ name: "vendor", id: vendor.id }} className="rcard-link">
                          {vendor.name ?? vendor.legalName ?? vendor.code}
                        </Link>
                        <span className={`ring${done === 4 ? " ring-done" : ""}`}>
                          <span className="visually-hidden">{t.colChecklist}: </span>
                          {done}/4
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
              <p className="muted small">{t.total(list.total)}</p>
            </>
          ) : (
            <>
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
                    {list.items.map((vendor) => {
                      const done = Object.values(vendor.checklist).filter(Boolean).length;
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
                                    <CategoryChip code={listing.categoryCode} />{" "}
                                    <StatusPill status={listing.status} />
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
              <p className="muted small">{t.total(list.total)}</p>
            </>
          )
        }
      </LoadedView>
    </div>
  );
}
