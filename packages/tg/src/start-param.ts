// Deep links Mini App: t.me/<бот>/<приложение>?startapp=vendor_<id> открывает карточку вендора.
// start_param — только маршрут. Он приходит от пользователя и не даёт никаких прав.

/** Куда открыть Mini App по ссылке. */
export type StartRoute = { kind: "vendor"; id: string };

// Telegram пропускает в startapp только [A-Za-z0-9_-] и не больше 512 символов
const START_PARAM_RE = /^[A-Za-z0-9_-]{1,512}$/;

// id вендора: строчная латиница, цифры, дефис — подходит и для uuid, и для slug.
// Подчёркивание запрещено: оно разделяет префикс и id.
const VENDOR_ID_RE = /^[a-z0-9-]{1,64}$/;

const VENDOR_PREFIX = "vendor_";

/** Разбирает start_param в маршрут. Всё незнакомое или подозрительное — null: открываем главную. */
export function parseStartParam(startParam: string | null | undefined): StartRoute | null {
  if (typeof startParam !== "string" || !START_PARAM_RE.test(startParam)) return null;
  if (startParam.startsWith(VENDOR_PREFIX)) {
    const id = startParam.slice(VENDOR_PREFIX.length);
    return VENDOR_ID_RE.test(id) ? { kind: "vendor", id } : null;
  }
  return null;
}

/** Собирает start_param для ссылки «поделиться». Бросает, если id не пройдёт parseStartParam. */
export function buildStartParam(route: StartRoute): string {
  if (!VENDOR_ID_RE.test(route.id)) {
    throw new RangeError("@bayramm/tg: id вендора должен быть из [a-z0-9-], от 1 до 64 символов");
  }
  return `${VENDOR_PREFIX}${route.id}`;
}
