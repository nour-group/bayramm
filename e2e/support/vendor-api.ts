import type {
  BusyDay,
  RequestTab,
  VendorCalendar,
  VendorListing,
  VendorMe,
  VendorRequestDetail,
  VendorRequestItem,
  VendorRequestPatch,
} from "@bayramm/shared/api/vendor";
import { TAB_STATUSES } from "@bayramm/shared/api/vendor";
import type { Page, Route } from "@playwright/test";

/* API кабинета вендора в памяти теста: page.route перехватывает /api/* до сети.
   Контракт — @bayramm/shared/api/vendor. Заявки и календарь меняются по PATCH/PUT/DELETE,
   как у настоящего API; всё незнакомое — 404 и запись в unexpected (тест это проверит). */

export const NOW = new Date("2026-10-01T07:00:00Z");
const HOUR = 3_600_000;
const at = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * HOUR).toISOString();
const due = (hoursAgo: number) => new Date(NOW.getTime() + (12 - hoursAgo) * HOUR).toISOString();

export const LISTING_ID = "00000000-0000-4000-8100-000000000001";
const PHOTO = "http://localhost:8790";

export const REQUEST_NEW = "00000000-0000-4000-8300-000000000001";
export const REQUEST_LATE = "00000000-0000-4000-8300-000000000002";

export type SignIn = "ok" | "not_linked" | "disabled" | "expired" | "error";

export interface VendorApi {
  readonly unexpected: string[];
  readonly patches: { readonly id: string; readonly body: VendorRequestPatch }[];
  readonly calls: string[];
  readonly busy: Map<string, BusyDay>;
}

function item(
  id: string,
  publicNo: number,
  hoursAgo: number,
  overrides: Partial<VendorRequestItem> = {},
): VendorRequestItem {
  return {
    id,
    publicNo,
    status: "new",
    declineReason: null,
    listing: { id: LISTING_ID, name: "Lola zali" },
    occasionCode: "toy",
    eventDate: "2026-10-24",
    guests: 180,
    budgetMinUzs: 30_000_000,
    budgetMaxUzs: 50_000_000,
    createdAt: at(hoursAgo),
    sla: { dueAt: due(hoursAgo), firstResponseAt: null, breached: hoursAgo > 12 },
    contactName: "Азиза",
    ...overrides,
  };
}

export function vendorMe(locale: "ru" | "uz" = "ru"): VendorMe {
  return {
    user: { id: "00000000-0000-4000-8200-000000000001", locale, fullName: "Шахло Каримова" },
    vendor: { id: "00000000-0000-4000-8400-000000000001", code: "V101", name: "Lola" },
    listings: [{ id: LISTING_ID, name: "Lola zali", status: "active" }],
  };
}

const LISTING: VendorListing = {
  id: LISTING_ID,
  slug: "lola-zali",
  name: "Lola zali",
  status: "active",
  statusReason: null,
  categoryCode: "hall",
  districtCode: "yunusobod",
  address: { ru: "Ташкент, Юнусабад, 4-й квартал", uz: "Toshkent, Yunusobod, 4-mavze" },
  description: { ru: "Зал на 300 гостей, своя кухня.", uz: "300 mehmonga zal, oshxona bor." },
  priceFromUzs: 25_000_000,
  priceUnit: "per_event",
  capMin: 80,
  capMax: 300,
  packages: [
    {
      kind: "weekday",
      name: { ru: "Будни", uz: "Ish kunlari" },
      priceUzs: 25_000_000,
      priceUnit: "per_event",
    },
    {
      kind: "weekend",
      name: { ru: "Выходные", uz: "Dam olish kunlari" },
      priceUzs: 30_000_000,
      priceUnit: "per_event",
    },
  ],
  photos: [1, 2, 3].map((n) => ({
    id: `00000000-0000-4000-8500-00000000000${n}`,
    width: 1600,
    height: 1067,
    moderation: n === 3 ? ("pending" as const) : ("approved" as const),
    isCover: n === 1,
    src: `${PHOTO}/640/listings/${LISTING_ID}/p${n}.webp`,
    srcSet: `${PHOTO}/320/listings/${LISTING_ID}/p${n}.webp 320w, ${PHOTO}/640/listings/${LISTING_ID}/p${n}.webp 640w`,
  })),
  phone: "+998000000001",
  blockers: [],
};

export const isApi = (url: URL) => url.hostname === "localhost" && url.pathname.startsWith("/api/");

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const fail = (route: Route, status: number, code: string) =>
  json(route, status, { error: { code, message: code } });

/** Подменить /api кабинета. signIn — чем ответит вход по initData */
export async function mockVendorApi(
  page: Page,
  { signIn = "ok" }: { signIn?: SignIn } = {},
): Promise<VendorApi> {
  const state: VendorApi = { unexpected: [], patches: [], calls: [], busy: new Map() };
  let locale: "ru" | "uz" = "ru";
  const requests = new Map<string, VendorRequestDetail>([
    [
      REQUEST_NEW,
      {
        ...item(REQUEST_NEW, 1051, 3),
        declineNote: null,
        contact: { name: "Азиза", phone: "+998901234567", comment: "Нужен детский стол" },
        history: [{ status: "new", at: at(3), by: "client" }],
      },
    ],
    [
      REQUEST_LATE,
      {
        ...item(REQUEST_LATE, 1047, 15, { status: "viewed", eventDate: "2026-11-07", contactName: "Бекзод" }),
        declineNote: null,
        contact: { name: "Бекзод", phone: "+998907654321", comment: null },
        history: [
          { status: "new", at: at(15), by: "client" },
          { status: "viewed", at: at(14), by: "vendor_user" },
        ],
      },
    ],
  ]);
  state.busy.set("2026-10-10", { day: "2026-10-10", source: "vendor", requestId: null });
  state.busy.set("2026-10-17", { day: "2026-10-17", source: "staff", requestId: null });

  const tabOf = (status: VendorRequestItem["status"]): RequestTab =>
    (Object.keys(TAB_STATUSES) as RequestTab[]).find((tab) => TAB_STATUSES[tab].includes(status)) ?? "closed";
  const listItem = (detail: VendorRequestDetail): VendorRequestItem => {
    const { declineNote: _n, contact: _c, history: _h, ...rest } = detail;
    return rest;
  };

  // Только /api/* своего origin: исходники в разработке тоже бывают по путям с «/api/»
  await page.route(isApi, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api/, "");
    const method = request.method();
    const key = `${method} ${path}`;

    if (key === "GET /telegram/bot")
      return json(route, 200, { username: "bayramm_demo_bot", miniAppUrl: "http://localhost:4310" });
    if (key === "POST /auth/vendor/telegram") {
      if (signIn === "not_linked") return fail(route, 403, "vendor_not_linked");
      if (signIn === "disabled") return fail(route, 403, "vendor_disabled");
      if (signIn === "expired") return fail(route, 401, "invalid_init_data");
      if (signIn === "error") return fail(route, 503, "service_unavailable");
      return json(route, 200, {
        token: "e2e-vendor-token",
        expiresAt: new Date(NOW.getTime() + 12 * HOUR).toISOString(),
      });
    }
    if (request.headers().authorization !== "Bearer e2e-vendor-token")
      return fail(route, 401, "unauthorized");

    if (key === "GET /vendor/me") return json(route, 200, vendorMe(locale));
    if (key === "PATCH /vendor/me") {
      locale = (request.postDataJSON() as { locale: "ru" | "uz" }).locale;
      return json(route, 200, vendorMe(locale));
    }
    if (key === "GET /vendor/requests") {
      const tab = (url.searchParams.get("tab") ?? "new") as RequestTab;
      const all = [...requests.values()];
      const counts = { new: 0, active: 0, closed: 0 };
      for (const r of all) counts[tabOf(r.status)]++;
      const items = all.filter((r) => tabOf(r.status) === tab).map(listItem);
      return json(route, 200, { items, nextCursor: null, counts });
    }
    const requestMatch = /^\/vendor\/requests\/([0-9a-f-]{36})(\/call)?$/.exec(path);
    if (requestMatch?.[1]) {
      const id = requestMatch[1];
      const current = requests.get(id);
      if (!current) return fail(route, 404, "not_found");
      if (requestMatch[2] && method === "POST") {
        state.calls.push(id);
        return route.fulfill({ status: 204 });
      }
      if (method === "GET") {
        // Открытие новой отмечает её просмотренной — как API
        if (current.status === "new") {
          const viewed: VendorRequestDetail = {
            ...current,
            status: "viewed",
            history: [...current.history, { status: "viewed", at: NOW.toISOString(), by: "vendor_user" }],
          };
          requests.set(id, viewed);
          return json(route, 200, viewed);
        }
        return json(route, 200, current);
      }
      if (method === "PATCH") {
        const body = request.postDataJSON() as VendorRequestPatch;
        state.patches.push({ id, body });
        const next: VendorRequestDetail = {
          ...current,
          status: body.status,
          declineReason: body.declineReason ?? null,
          sla: { ...current.sla, firstResponseAt: current.sla.firstResponseAt ?? NOW.toISOString() },
          history: [...current.history, { status: body.status, at: NOW.toISOString(), by: "vendor_user" }],
        };
        requests.set(id, next);
        return json(route, 200, listItem(next));
      }
    }
    if (key === `GET /vendor/listings/${LISTING_ID}`) return json(route, 200, LISTING);
    if (key === `GET /vendor/listings/${LISTING_ID}/calendar`) {
      const month = url.searchParams.get("month") ?? "2026-10";
      const calendar: VendorCalendar = {
        listingId: LISTING_ID,
        month,
        today: "2026-10-01",
        maxDay: "2027-09-30",
        busy: [...state.busy.values()].filter((b) => b.day.startsWith(month)),
        requestDays: [...requests.values()].map((r) => r.eventDate).filter((d) => d.startsWith(month)),
      };
      return json(route, 200, calendar);
    }
    const dayMatch = new RegExp(`^/vendor/listings/${LISTING_ID}/calendar/(\\d{4}-\\d{2}-\\d{2})$`).exec(
      path,
    );
    if (dayMatch?.[1]) {
      const day = dayMatch[1];
      if (state.busy.get(day)?.source === "staff") return fail(route, 403, "forbidden_for_actor");
      if (method === "PUT") {
        const busy: BusyDay = { day, source: "vendor", requestId: null };
        state.busy.set(day, busy);
        return json(route, 200, busy);
      }
      if (method === "DELETE") {
        state.busy.delete(day);
        return route.fulfill({ status: 204 });
      }
    }

    state.unexpected.push(key);
    return fail(route, 404, "not_found");
  });
  return state;
}
