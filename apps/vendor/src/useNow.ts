import { useNow as useKitNow } from "@bayramm/ui/react";

/** Текущее время раз в полминуты (и сразу при возврате во вкладку) — для счётчиков 12 часов */
export function useNow(intervalMs = 30_000): number {
  return useKitNow(intervalMs);
}
