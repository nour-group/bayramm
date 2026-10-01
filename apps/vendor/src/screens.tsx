/* Разделы кабинета — отдельными частями сборки (code splitting). В основной части — только
   вход и оболочка: экран «что это за кабинет» из браузера не тянет за собой ни заявок, ни
   конфигурации категорий. Заявки (с категориями: подписи, поля заявки, услуги) грузятся,
   как только ясно, что вход будет (warmInbox — параллельно с запросами входа), календарь,
   витрина (с формой правок и сжатием фото), услуги и аккаунт — после входа, пока человек
   смотрит на заявки (preloadScreens): переход мгновенный, а пропавшая потом связь раздел
   уже не сломает.

   Без React.lazy: отказ import() у него запоминается навсегда, а здесь кусок, который не
   загрузился (нет связи), показывает «Не удалось загрузить» с повтором и сам грузится
   снова, когда связь вернётся. Загруженный кусок отдаётся сразу, без мигания «Загрузка…». */

import { useOnReconnect } from "@bayramm/ui/react";
import { type ReactNode, useEffect, useState } from "react";
import type { VendorDict } from "./i18n";
import { LoadError, Loading } from "./ui";

export interface Part<T> {
  /** Модуль, если уже загружен */
  peek(): T | undefined;
  /** Загрузить (один раз; после отказа — заново) */
  load(): Promise<T>;
}

function part<T>(importer: () => Promise<T>): Part<T> {
  let value: T | undefined;
  let running: Promise<T> | null = null;
  return {
    peek: () => value,
    load() {
      running ??= importer().then(
        (module) => {
          value = module;
          return module;
        },
        (error: unknown) => {
          running = null;
          throw error;
        },
      );
      return running;
    },
  };
}

export const SCREENS = {
  inbox: part(() => import("./Inbox")),
  calendar: part(() => import("./Calendar")),
  venue: part(() => import("./Venue")),
  services: part(() => import("./Services")),
  account: part(() => import("./AccountPage")),
} as const;

/**
 * Категории глазами кабинета (подписи категорий для боковой панели) — своей частью: она
 * общая у всех разделов и в основную часть не попадает
 */
export const CATEGORY_KIT = part(() => import("./category"));

/** Заявки — первый экран после входа: грузить, пока идёт вход. Ошибка — покажет сам раздел */
export function warmInbox(): void {
  void SCREENS.inbox.load().catch(() => {});
}

/**
 * Модуль части, когда загрузится (до того — undefined): для мелочей, которые можно показать
 * чуть позже, не задерживая экран (подпись категории у витрины)
 */
export function usePart<T>(piece: Part<T>): T | undefined {
  const [, setLoaded] = useState(0);
  const module = piece.peek();
  useEffect(() => {
    if (piece.peek() !== undefined) return;
    let active = true;
    piece.load().then(
      () => active && setLoaded((n) => n + 1),
      () => {},
    );
    return () => {
      active = false;
    };
  }, [piece]);
  return module;
}

/** Подгрузить разделы заранее; ошибку не показываем — раздел загрузится при переходе */
export function preloadScreens(): void {
  for (const screen of Object.values(SCREENS)) void screen.load().catch(() => {});
}

/** Все разделы сразу (тесты: переход не ждёт загрузки куска) */
export function preloadAll(): Promise<unknown> {
  return Promise.all([...Object.values(SCREENS), CATEGORY_KIT].map((screen) => screen.load()));
}

interface LazyProps<T> {
  readonly part: Part<T>;
  readonly t: VendorDict;
  readonly children: (module: T) => ReactNode;
}

/** Раздел из своей части сборки: загрузка, отказ с повтором, затем сам раздел */
export function Lazy<T>({ part, t, children }: LazyProps<T>) {
  const [, setLoaded] = useState(0);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const module = part.peek();

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt — повтор по «Повторить» и по возврату связи
  useEffect(() => {
    if (part.peek() !== undefined) return;
    let active = true;
    setFailed(false);
    part.load().then(
      () => active && setLoaded((n) => n + 1),
      () => active && setFailed(true),
    );
    return () => {
      active = false;
    };
  }, [part, attempt]);

  useOnReconnect(() => {
    if (failed) setAttempt((n) => n + 1);
  });

  if (module !== undefined) return <>{children(module)}</>;
  if (failed) return <LoadError t={t} onRetry={() => setAttempt((n) => n + 1)} />;
  return <Loading t={t} />;
}
