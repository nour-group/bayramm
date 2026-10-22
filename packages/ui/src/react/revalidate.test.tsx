// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useNow, useRevalidate } from "./revalidate";
import { cleanup, render } from "./test/harness";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});

const setVisibility = (state: "visible" | "hidden") => {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
};

describe("useRevalidate", () => {
  it("вернулись во вкладку, связь, таймер — перечитать; скрытая вкладка в API не ходит; подряд — не чаще minGap", () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    function List() {
      useRevalidate(refresh, { interval: 60_000, minGap: 5_000 });
      return null;
    }
    render(<List />);
    expect(refresh).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    // Сразу после — возврат во вкладку не дублирует запрос
    setVisibility("hidden");
    setVisibility("visible");
    expect(refresh).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(6_000);
    });
    setVisibility("visible");
    expect(refresh).toHaveBeenCalledTimes(2);
    // Скрыта — таймер не перечитывает
    setVisibility("hidden");
    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    expect(refresh).toHaveBeenCalledTimes(2);
    setVisibility("visible");
    expect(refresh).toHaveBeenCalledTimes(3);
    act(() => {
      vi.advanceTimersByTime(6_000);
      window.dispatchEvent(new Event("online"));
    });
    expect(refresh).toHaveBeenCalledTimes(4);
  });

  it("Telegram: Mini App снова на экране (activated) — перечитать", () => {
    const handlers = new Map<string, () => void>();
    Object.assign(window, {
      Telegram: {
        WebApp: {
          onEvent: (name: string, handler: () => void) => handlers.set(name, handler),
          offEvent: (name: string) => handlers.delete(name),
        },
      },
    });
    const refresh = vi.fn();
    function List() {
      useRevalidate(refresh, { minGap: 0 });
      return null;
    }
    render(<List />);
    act(() => handlers.get("activated")?.());
    expect(refresh).toHaveBeenCalledTimes(1);
    cleanup();
    expect(handlers.has("activated")).toBe(false);
    Reflect.deleteProperty(window, "Telegram");
  });
});

describe("useNow", () => {
  it("тикает, пока вкладка видна", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-22T05:00:00Z"));
    const seen: number[] = [];
    function Clock() {
      seen.push(useNow(60_000));
      return null;
    }
    render(<Clock />);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(seen.at(-1)).toBe(new Date("2026-10-22T05:01:00Z").getTime());
  });
});
