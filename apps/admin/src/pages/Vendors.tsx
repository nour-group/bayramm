/* Вендоры: поиск, фильтр по статусу карточек, таблица. Строка ведёт на страницу вендора. */

import type { ListingStatus, VendorList } from "@bayramm/shared/api/staff";
import { useEffect, useState } from "react";
import { useCan, useLoad } from "../api";
import { t } from "../texts";
import { Link, LoadedView, StatusPill } from "../ui";

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
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<ListingStatus | null>(null);
  const query = useDebounced(q.trim());
  const params = new URLSearchParams({ limit: "100" });
  if (query) params.set("q", query);
  if (status) params.set("listingStatus", status);
  const { loaded, reload } = useLoad<VendorList>(`/staff/vendors?${params}`);

  return (
    <div className="stack">
      <div className="toolbar">
        <input
          className="input search"
          type="search"
          value={q}
          onChange={(event) => setQ(event.target.value)}
          placeholder={t.vendorsSearch}
          aria-label={t.search}
          maxLength={100}
        />
        {can("vendors.write") && (
          <Link to={{ name: "vendorNew" }} className="btn btn-primary">
            {t.newVendor}
          </Link>
        )}
      </div>
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
      <LoadedView loaded={loaded} onRetry={reload}>
        {(list) =>
          list.items.length === 0 ? (
            <p className="empty">{query || status ? t.vendorsEmpty : t.vendorsEmptyAll}</p>
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
