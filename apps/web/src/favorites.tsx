import { FAVORITES_MAX, type ListingCard } from "@bayramm/shared/api";
import { useToast } from "@bayramm/ui/react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { isApiError } from "./api/errors";
import { canSignIn, useAccount, useLang, useServices } from "./context";
import { chromeOf } from "./nav";
import { localGetJson, localRemove, localSetJson } from "./storage";

/* Избранное — площадки с сердечком (в прототипе «Сохранённое»).

   Гость (сайт без входа) — список id в браузере: localStorage, без личных данных, не
   больше FAVORITES_MAX; карточки — публичным GET /catalog/cards. Вошедший клиент
   (Telegram, сайт со входом, демо) — в аккаунте: /me/favorites. При входе гостевой список
   один раз сливается с аккаунтом (POST /me/favorites) и из браузера стирается: на общем
   компьютере после выхода чужое избранное не остаётся.

   Снятая с публикации площадка просто пропадает из списка: сервер её не отдаёт, ошибки
   нет. Отметка сразу меняется на экране; не сохранилась — возвращается, и уведомление. */

export const FAVORITES_KEY = "bayramm.web.favorites";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isIdList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((id) => typeof id === "string" && UUID_RE.test(id));

/** Гостевой список из браузера: последние отмеченные — первыми */
export function guestFavorites(): string[] {
  return (localGetJson(FAVORITES_KEY, isIdList) ?? []).slice(0, FAVORITES_MAX);
}

/** Список с сервера плюс правки, которые ещё в пути: ответ загрузки их не отменяет */
function withPending(ids: readonly string[], pending: ReadonlyMap<string, boolean>): string[] {
  const out = ids.filter((id) => pending.get(id) !== false);
  for (const [id, adding] of pending) if (adding && !out.includes(id)) out.unshift(id);
  return out;
}

function saveGuestFavorites(ids: readonly string[]): void {
  if (ids.length === 0) localRemove(FAVORITES_KEY);
  else localSetJson(FAVORITES_KEY, ids);
}

export interface FavoritesValue {
  /** guest — список в браузере; account — в аккаунте */
  readonly mode: "guest" | "account";
  /** Отмеченные id; у аккаунта — после загрузки (до неё — пусто) */
  readonly ids: ReadonlySet<string>;
  /** ids уже знают список: у гостя — сразу, у аккаунта — после загрузки */
  readonly ready: boolean;
  /** Отметить или снять */
  readonly toggle: (listing: { readonly id: string; readonly name: string }) => void;
  /** Карточки избранного для экрана «Сохранённое»: снятых с публикации в них нет */
  readonly cards: (signal: AbortSignal) => Promise<readonly ListingCard[]>;
}

const FavoritesContext = createContext<FavoritesValue | null>(null);

export function useFavorites(): FavoritesValue {
  const value = useContext(FavoritesContext);
  if (!value) throw new Error("FavoritesContext не задан");
  return value;
}

export function FavoritesProvider({ children }: { children: ReactNode }) {
  const { api, identity, webApp } = useServices();
  const { deleted } = useAccount();
  const { t } = useLang();
  const toast = useToast();
  const mode = canSignIn(identity) && !deleted ? "account" : "guest";
  // Где искать список — по оболочке (nav.ts): у приложения это вкладка, у гостя сайта —
  // раздел в шапке (на телефоне — в меню)
  const savedText = chromeOf(identity, webApp !== null, deleted) === "app" ? t.savedApp : t.savedGuest;
  const [guest, setGuest] = useState<string[]>(guestFavorites);
  const [account, setAccount] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  // Правки аккаунта в пути (id → добавить/убрать): загрузка, пришедшая позже, их не затирает
  const pending = useRef(new Map<string, boolean>());

  // Аккаунт: гостевой список — в него (один раз), затем весь список с сервера
  useEffect(() => {
    if (mode !== "account") return;
    const controller = new AbortController();
    const local = guestFavorites();
    // Слияние не удалось — гостевой список остаётся в браузере до следующего открытия
    const load =
      local.length > 0
        ? api.mergeFavorites(local).then(
            (merged) => {
              saveGuestFavorites([]);
              setGuest([]);
              return merged;
            },
            () => api.favorites(controller.signal),
          )
        : api.favorites(controller.signal);
    load.then(
      (list) => {
        if (controller.signal.aborted) return;
        setAccount(
          withPending(
            list.items.map((card) => card.id),
            pending.current,
          ),
        );
        setLoaded(true);
      },
      // Не загрузилось — сердечки пустые, экран «Сохранённое» покажет ошибку с повтором
      () => {},
    );
    return () => controller.abort();
  }, [api, mode]);

  // Удалили аккаунт — в этой вкладке его избранного больше нет
  useEffect(() => {
    if (deleted) setAccount([]);
  }, [deleted]);

  const ids = useMemo(() => new Set(mode === "account" ? account : guest), [mode, account, guest]);

  const toggle = useCallback(
    ({ id }: { readonly id: string; readonly name: string }) => {
      const adding = !ids.has(id);
      if (mode === "guest") {
        if (adding && guest.length >= FAVORITES_MAX) {
          toast(t.favFull, { tone: "error" });
          return;
        }
        const next = adding ? [id, ...guest] : guest.filter((item) => item !== id);
        saveGuestFavorites(next);
        setGuest(next);
        if (adding) toast(savedText);
        return;
      }
      pending.current.set(id, adding);
      setAccount((list) =>
        adding ? [id, ...list.filter((item) => item !== id)] : list.filter((i) => i !== id),
      );
      (adding ? api.addFavorite(id) : api.removeFavorite(id)).then(
        () => {
          pending.current.delete(id);
          if (adding) toast(savedText);
        },
        (error: unknown) => {
          pending.current.delete(id);
          // Не сохранилось — отметка как была
          setAccount((list) => (adding ? list.filter((item) => item !== id) : [id, ...list]));
          const full = isApiError(error) && error.code === "favorites_full";
          toast(full ? t.favFull : t.favErr, { tone: "error" });
        },
      );
    },
    [api, ids, mode, guest, toast, t, savedText],
  );

  const cards = useCallback(
    async (signal: AbortSignal) => {
      if (mode === "account") return (await api.favorites(signal)).items;
      return (await api.listingCards(guestFavorites(), signal)).items;
    },
    [api, mode],
  );

  const ready = mode === "guest" || loaded;
  const value = useMemo<FavoritesValue>(
    () => ({ mode, ids, ready, toggle, cards }),
    [mode, ids, ready, toggle, cards],
  );
  return <FavoritesContext.Provider value={value}>{children}</FavoritesContext.Provider>;
}
