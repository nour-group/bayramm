import type {
  BusyDay,
  ListingRevisionPayload,
  RequestTab,
  VendorCalendar,
  VendorCalendarChange,
  VendorListing,
  VendorMe,
  VendorPhoto,
  VendorRequestDetail,
  VendorRequestItem,
  VendorRequestPatch,
  VendorRevision,
  VendorRole,
} from "@bayramm/shared/api/vendor";
import { TAB_STATUSES } from "@bayramm/shared/api/vendor";
import type { Page, Route } from "@playwright/test";
import { APPS, accountMe, BOT, type HubWatch, METHODS, VENDOR_MEMBERSHIP } from "./account";

/* API кабинета вендора в памяти теста: page.route перехватывает /api/* до сети.
   Контракт — @bayramm/shared/api/vendor. Заявки, календарь и фото меняются по
   PATCH/PUT/POST/DELETE, как у настоящего API; всё незнакомое — 404 и запись в unexpected
   (тест это проверит). Вход — по initData (внутри Telegram) или кодом хаба входа на сайте (hub).

   Как у API: правка календаря — только с If-Match от текущей версии (нет — 428, устарела —
   409 calendar_conflict); карточку (фото, правки) меняет только владелец кабинета — сотруднику
   площадки (role: "member") 403 vendor_owner_required. */

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
  /**
   * Версия календаря площадки: растёт на каждой правке. Тест может поднять её сам —
   * «календарь изменил кто-то другой», следующая правка кабинета получит 409
   */
  readonly calendar: { version: number };
  /** Правки календаря, как пришли: «PUT 2026-10-20 If-Match: 1» */
  readonly calendarWrites: string[];
  /** Фото площадки, как в базе (порядок — порядок показа) */
  readonly photos: VendorPhoto[];
  /** Что пришло в POST /photos: тип, размер и подтверждение «лиц нет» */
  readonly uploads: { readonly contentType: string; readonly bytes: number; readonly noFaces: string }[];
  /** Предложения правок карточки, новые первыми */
  readonly revisions: VendorRevision[];
  /** Чем входили: тело POST /auth/telegram */
  readonly signIns: unknown[];
  /** Запросы, которым API отказало по роли (vendor_owner_required) */
  readonly ownerOnly: string[];
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

export function vendorMe(locale: "ru" | "uz" = "ru", role: VendorRole = "owner"): VendorMe {
  return {
    user: { id: "00000000-0000-4000-8200-000000000001", locale, fullName: "Шахло Каримова", role },
    vendor: {
      id: VENDOR_MEMBERSHIP.vendorId,
      code: VENDOR_MEMBERSHIP.code,
      name: VENDOR_MEMBERSHIP.name ?? "",
    },
    listings: [{ id: LISTING_ID, name: "Lola zali", status: "active" }],
  };
}

const photoOf = (n: number, moderation: VendorPhoto["moderation"], isCover = false): VendorPhoto => ({
  id: `00000000-0000-4000-8500-${String(n).padStart(12, "0")}`,
  width: 1600,
  height: 1067,
  moderation,
  isCover,
  src: `${PHOTO}/640/listings/${LISTING_ID}/p${n}.webp`,
  srcSet: `${PHOTO}/320/listings/${LISTING_ID}/p${n}.webp 320w, ${PHOTO}/640/listings/${LISTING_ID}/p${n}.webp 640w`,
});

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
  photos: [
    photoOf(1, "approved", true),
    photoOf(2, "approved"),
    photoOf(3, "approved"),
    photoOf(4, "pending"),
  ],
  phone: "+998000000001",
  blockers: [],
  photoLimits: { min: 3, max: 10 },
};

export const isApi = (url: URL) => url.hostname === "localhost" && url.pathname.startsWith("/api/");
const TOKEN = "e2e-vendor-token";

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const fail = (route: Route, status: number, code: string) =>
  json(route, status, { error: { code, message: code } });

export interface VendorApiOptions {
  /** Чем ответит вход по initData */
  readonly signIn?: SignIn;
  /** У аккаунта есть и роль сотрудника: в кабинете видна ссылка на панель */
  readonly staff?: boolean;
  /** Обмен кода хаба (POST /auth/hub/exchange) сверяется с навигациями страницы */
  readonly hub?: HubWatch;
  /** Какие запросы перехватывать: по умолчанию /api любого localhost */
  readonly match?: (url: URL) => boolean;
  /** Роль в кабинете: owner (по умолчанию) меняет карточку, member — только заявки и календарь */
  readonly role?: VendorRole;
}

/** Подменить /api кабинета */
export async function mockVendorApi(
  page: Page,
  { signIn = "ok", staff = false, hub, match = isApi, role = "owner" }: VendorApiOptions = {},
): Promise<VendorApi> {
  const state: VendorApi = {
    unexpected: [],
    patches: [],
    calls: [],
    busy: new Map(),
    calendar: { version: 1 },
    calendarWrites: [],
    photos: [...LISTING.photos],
    uploads: [],
    revisions: [],
    signIns: [],
    ownerOnly: [],
  };
  let photoNo = state.photos.length;
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
  await page.route(match, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api/, "");
    const method = request.method();
    const key = `${method} ${path}`;

    if (key === "GET /telegram/bot") return json(route, 200, { username: BOT, miniAppUrl: APPS.web });
    if (key === "GET /auth/methods") return json(route, 200, METHODS);
    if (key === "POST /auth/hub/exchange") {
      const ok = hub?.exchange(url.origin, "vendor", request.postDataJSON()) ?? false;
      return ok
        ? json(route, 200, { token: TOKEN, expiresAt: new Date(NOW.getTime() + 7 * 24 * HOUR).toISOString() })
        : fail(route, 400, "invalid_code");
    }
    // Кабинет входит общим адресом с app: "vendor"; устаревший /auth/vendor/telegram — в unexpected
    if (key === "POST /auth/telegram") {
      const body = request.postDataJSON() as { app?: unknown };
      state.signIns.push(body);
      if (body.app !== "vendor") return fail(route, 400, "invalid_request");
      if (signIn === "not_linked") return fail(route, 403, "vendor_not_linked");
      if (signIn === "disabled") return fail(route, 403, "vendor_disabled");
      if (signIn === "expired") return fail(route, 401, "invalid_init_data");
      if (signIn === "error") return fail(route, 503, "service_unavailable");
      return json(route, 200, {
        token: TOKEN,
        expiresAt: new Date(NOW.getTime() + 12 * HOUR).toISOString(),
      });
    }
    if (request.headers().authorization !== `Bearer ${TOKEN}`) return fail(route, 401, "unauthorized");

    if (key === "GET /me")
      return json(
        route,
        200,
        accountMe({ vendors: [{ ...VENDOR_MEMBERSHIP, role }], staff }, { kind: "account", app: "vendor" }),
      );
    if (key === "POST /auth/logout") return route.fulfill({ status: 204 });

    if (key === "GET /vendor/me") return json(route, 200, vendorMe(locale, role));
    if (key === "PATCH /vendor/me") {
      locale = (request.postDataJSON() as { locale: "ru" | "uz" }).locale;
      return json(route, 200, vendorMe(locale, role));
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
    if (key === `GET /vendor/listings/${LISTING_ID}`)
      return json(route, 200, { ...LISTING, photos: state.photos });

    // Карточку меняет только владелец кабинета — как vendor/access.ts
    const revisions = `/vendor/listings/${LISTING_ID}/revisions`;
    const photosPath = `/vendor/listings/${LISTING_ID}/photos`;
    const changesCard = method !== "GET" && (path.startsWith(revisions) || path.startsWith(photosPath));
    if (changesCard && role !== "owner") {
      state.ownerOnly.push(key);
      return fail(route, 403, "vendor_owner_required");
    }

    if (key === `POST ${photosPath}`) {
      const noFaces = request.headers()["x-no-faces"] ?? "";
      if (noFaces !== "1") return fail(route, 422, "no_faces_ack_required");
      if (state.photos.length >= LISTING.photoLimits.max) return fail(route, 409, "too_many_photos");
      state.uploads.push({
        contentType: request.headers()["content-type"] ?? "",
        bytes: request.postDataBuffer()?.length ?? 0,
        noFaces,
      });
      photoNo += 1;
      const photo = photoOf(photoNo, "pending");
      state.photos.push(photo);
      return json(route, 201, photo);
    }
    const photoMatch = new RegExp(`^${photosPath}/([0-9a-f-]{36})$`).exec(path);
    if (photoMatch && method === "DELETE") {
      const index = state.photos.findIndex((p) => p.id === photoMatch[1]);
      const photo = state.photos[index];
      if (!photo) return fail(route, 404, "not_found");
      // Опубликованная площадка не останется без минимума одобренных фото
      const approved = state.photos.filter((p) => p.moderation === "approved").length;
      if (photo.moderation === "approved" && approved <= LISTING.photoLimits.min) {
        return json(route, 422, { error: { code: "publish_blocked", message: "x", details: ["photos"] } });
      }
      state.photos.splice(index, 1);
      return route.fulfill({ status: 204 });
    }

    if (key === `GET ${revisions}`) return json(route, 200, { items: state.revisions });
    if (key === `POST ${revisions}`) {
      if (state.revisions.some((r) => r.status === "pending")) return fail(route, 409, "revision_pending");
      const revision: VendorRevision = {
        id: `00000000-0000-4000-8700-00000000000${state.revisions.length + 1}`,
        status: "pending",
        submittedAt: NOW.toISOString(),
        decidedAt: null,
        decisionReason: null,
        payload: request.postDataJSON() as ListingRevisionPayload,
        byTeam: false,
      };
      state.revisions.unshift(revision);
      return json(route, 201, revision);
    }
    const withdraw = new RegExp(`^${revisions}/([0-9a-f-]{36})/withdraw$`).exec(path);
    if (withdraw && method === "POST") {
      const index = state.revisions.findIndex((r) => r.id === withdraw[1]);
      const current = state.revisions[index];
      if (!current) return fail(route, 404, "not_found");
      if (current.status !== "pending") return fail(route, 409, "illegal_transition");
      if (current.byTeam) return fail(route, 403, "forbidden_for_actor");
      const next: VendorRevision = { ...current, status: "withdrawn" };
      state.revisions[index] = next;
      return json(route, 200, next);
    }
    if (key === `GET /vendor/listings/${LISTING_ID}/calendar`) {
      const month = url.searchParams.get("month") ?? "2026-10";
      const calendar: VendorCalendar = {
        listingId: LISTING_ID,
        month,
        today: "2026-10-01",
        maxDay: "2027-09-30",
        busy: [...state.busy.values()].filter((b) => b.day.startsWith(month)),
        requestDays: [...requests.values()].map((r) => r.eventDate).filter((d) => d.startsWith(month)),
        version: state.calendar.version,
      };
      return json(route, 200, calendar);
    }
    const dayPrefix = `/vendor/listings/${LISTING_ID}/calendar/`;
    const day = path.startsWith(dayPrefix) ? path.slice(dayPrefix.length) : "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(day) && (method === "PUT" || method === "DELETE")) {
      // Правка — от версии, которую видел человек: как calendar/version.ts в API
      const ifMatch = request.headers()["if-match"];
      state.calendarWrites.push(`${method} ${day} If-Match: ${ifMatch ?? "—"}`);
      if (ifMatch === undefined || ifMatch.trim() === "") return fail(route, 428, "version_required");
      if (Number(ifMatch.replace(/^(?:W\/)?"?|"$/g, "")) !== state.calendar.version) {
        return fail(route, 409, "calendar_conflict");
      }
      if (state.busy.get(day)?.source === "staff") return fail(route, 403, "forbidden_for_actor");
      if (method === "PUT" && !state.busy.has(day))
        state.busy.set(day, { day, source: "vendor", requestId: null });
      if (method === "DELETE") state.busy.delete(day);
      state.calendar.version += 1;
      const change: VendorCalendarChange = {
        day,
        busy: state.busy.get(day) ?? null,
        version: state.calendar.version,
      };
      return json(route, 200, change);
    }

    state.unexpected.push(key);
    return fail(route, 404, "not_found");
  });
  return state;
}
