import { createHash } from "node:crypto";
import type { AccountMe, AuthMethods, HubExchange, VendorMembership } from "@bayramm/shared/api/account";
import type { Page } from "@playwright/test";

/* Один аккаунт Bayramm на три приложения — общее для подмен /api кабинета и панели:
   адреса приложений окружения (GET /auth/methods), GET /me аккаунта и проверка обмена
   одноразового кода хаба. Код выдаёт демо-API клиента (VITE_API=mock) в своей вкладке, поэтому
   подмены сверяют обмен с тем, что видел браузер: запрос хаба (app, state, challenge) и
   адрес возврата (code, state) — из навигаций страницы. */

export const PORTS = { web: 4310, vendor: 4311, admin: 4312 } as const;
export const APPS = {
  web: `http://localhost:${PORTS.web}`,
  vendor: `http://localhost:${PORTS.vendor}`,
  admin: `http://localhost:${PORTS.admin}`,
} as const;

export const BOT = "bayramm_demo_bot";

export const METHODS: AuthMethods = {
  // Домен виджета — не localhost: виджет Telegram в тестах не грузится
  telegram: { bot: BOT, loginDomain: null },
  phone: false,
  apps: APPS,
};

/** /api своего приложения: подмена кабинета не должна отвечать за панель и наоборот */
export const apiOf = (origin: string) => (url: URL) =>
  url.origin === origin && url.pathname.startsWith("/api/");

export const VENDOR_MEMBERSHIP: VendorMembership = {
  vendorUserId: "00000000-0000-4000-8200-000000000001",
  vendorId: "00000000-0000-4000-8400-000000000001",
  code: "V101",
  name: "Lola",
  role: "owner",
};

/** GET /me аккаунта с этими ролями (клиентской нет: в кабинете и панели она не нужна) */
export function accountMe(
  roles: { readonly vendors?: readonly VendorMembership[]; readonly staff?: boolean },
  session: AccountMe["session"],
): AccountMe {
  return {
    account: { id: "00000000-0000-4000-8b00-000000000001", locale: "ru", createdAt: "2026-09-01T07:00:00Z" },
    profile: { firstName: "Шахло", lastName: null, username: null },
    identities: [{ kind: "telegram", verifiedAt: "2026-09-01T07:00:00Z" }],
    roles: {
      client: null,
      vendors: roles.vendors ?? [],
      staff: roles.staff ? { role: "admin" } : null,
    },
    session,
  };
}

interface HubRequest {
  readonly app: string;
  readonly state: string;
  readonly challenge: string;
}

interface HubCallback {
  readonly origin: string;
  readonly code: string;
  readonly state: string;
  used: boolean;
}

export interface HubWatch {
  /** Запросы в хаб на сайте: /auth?app=…&state=…&challenge=… */
  readonly requests: readonly HubRequest[];
  /** Возвраты из хаба: <приложение>/auth/callback?code=…&state=… */
  readonly callbacks: readonly HubCallback[];
  /** Обмены кода (кто и чем ответил) */
  readonly exchanges: { readonly origin: string; readonly ok: boolean }[];
  /**
   * Обмен кода как у API: код — из возврата в это приложение и один раз, state — тот же,
   * S256(verifier) = challenge запроса хаба, app — этого приложения
   */
  exchange(origin: string, app: "vendor" | "admin", body: HubExchange): boolean;
}

const s256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

/** Следить за навигациями страницы через хаб */
export function watchHub(page: Page): HubWatch {
  const requests: HubRequest[] = [];
  const callbacks: HubCallback[] = [];
  const exchanges: { origin: string; ok: boolean }[] = [];
  page.on("request", (request) => {
    if (!request.isNavigationRequest()) return;
    const url = new URL(request.url());
    const q = url.searchParams;
    if (url.origin === APPS.web && url.pathname === "/auth" && q.get("app")) {
      requests.push({
        app: q.get("app") ?? "",
        state: q.get("state") ?? "",
        challenge: q.get("challenge") ?? "",
      });
    } else if (url.pathname === "/auth/callback" && q.get("code")) {
      callbacks.push({
        origin: url.origin,
        code: q.get("code") ?? "",
        state: q.get("state") ?? "",
        used: false,
      });
    }
  });
  return {
    requests,
    callbacks,
    exchanges,
    exchange(origin, app, body) {
      const callback = callbacks.find((c) => c.origin === origin && c.code === body.code && !c.used);
      const request = requests.find((r) => r.app === app && r.state === body.state);
      const ok =
        body.app === app &&
        callback !== undefined &&
        callback.state === body.state &&
        request !== undefined &&
        s256(body.codeVerifier) === request.challenge;
      // Код одноразовый: сгорает и на неудачной попытке
      if (callback) callback.used = true;
      exchanges.push({ origin, ok });
      return ok;
    },
  };
}
