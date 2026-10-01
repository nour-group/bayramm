/* Разделы кабинета — отдельными частями сборки (code splitting). Первый экран — заявки
   (и вход) — в основной части; календарь, площадка (с формой правок и сжатием фото) и
   аккаунт грузятся при первом переходе. Пока человек смотрит на заявки, оболочка
   подгружает их заранее (preloadScreens): переход мгновенный, а пропавшая потом связь
   раздел уже не сломает.

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
  calendar: part(() => import("./Calendar")),
  venue: part(() => import("./Venue")),
  account: part(() => import("./AccountPage")),
} as const;

/** Подгрузить разделы заранее; ошибку не показываем — раздел загрузится при переходе */
export function preloadScreens(): void {
  for (const screen of Object.values(SCREENS)) void screen.load().catch(() => {});
}

/** Все разделы сразу (тесты: переход не ждёт загрузки куска) */
export function preloadAll(): Promise<unknown> {
  return Promise.all(Object.values(SCREENS).map((screen) => screen.load()));
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
