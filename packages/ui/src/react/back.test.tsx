// @vitest-environment jsdom
import { act, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type BackButtonLike, backLayerOpen, resetBackLayers, setBackButton } from "./back";
import { Dialog } from "./Dialog";
import { cleanup, click, render } from "./test/harness";

afterEach(() => {
  cleanup();
  resetBackLayers();
  setBackButton(null);
  vi.useRealTimers();
});

let closes = 0;

function Sheet({ keep = false }: { keep?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="opener" onClick={() => setOpen(true)}>
        День
      </button>
      <Dialog
        open={open}
        title="15 октября"
        onClose={() => {
          closes += 1;
          if (!keep) setOpen(false);
        }}
      >
        <button type="button" className="inside">
          Закрыть весь день
        </button>
      </Dialog>
    </>
  );
}

const opener = () => document.querySelector<HTMLButtonElement>(".opener");
const dialog = () => document.querySelector('[role="dialog"]');
const tick = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 5)));

/** Кнопка «Назад» Telegram: обработчики по порядку, как у SDK */
function fakeButton() {
  const handlers: (() => void)[] = [];
  const button: BackButtonLike & { visible: boolean; press: () => void } = {
    visible: false,
    get isVisible() {
      return this.visible;
    },
    show() {
      button.visible = true;
    },
    hide() {
      button.visible = false;
    },
    onClick(handler) {
      handlers.push(handler);
    },
    offClick(handler) {
      handlers.splice(handlers.indexOf(handler), 1);
    },
    press() {
      for (const handler of [...handlers]) handler();
    },
  };
  return button;
}

describe("«назад» закрывает открытый слой", () => {
  it("Telegram: пока шторка открыта, кнопка видна и закрывает её тем же путём, что крестик", async () => {
    const button = fakeButton();
    setBackButton(() => button);
    closes = 0;
    render(<Sheet />);
    await click(opener());
    expect(button.visible).toBe(true);
    expect(backLayerOpen()).toBe(true);
    await act(() => button.press());
    expect(closes).toBe(1);
    expect(dialog()).toBeNull();
    await tick();
    expect(button.visible).toBe(false);
    expect(backLayerOpen()).toBe(false);
  });

  it("Telegram: кнопку вложенного экрана под шторкой не прячет", async () => {
    const button = fakeButton();
    button.visible = true;
    setBackButton(() => button);
    render(<Sheet />);
    await click(opener());
    await act(() => button.press());
    await tick();
    expect(button.visible).toBe(true);
  });

  it("браузер: открытая шторка — запись истории; «назад» закрывает шторку, экран её popstate не видит", async () => {
    const screen = vi.fn();
    window.addEventListener("popstate", screen);
    const before = window.history.length;
    closes = 0;
    render(<Sheet />);
    await click(opener());
    expect(window.history.length).toBe(before + 1);
    await act(async () => {
      window.history.back();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(closes).toBe(1);
    expect(dialog()).toBeNull();
    expect(screen).not.toHaveBeenCalled();
    window.removeEventListener("popstate", screen);
  });

  it("браузер: закрыли крестиком — запись шторки уходит из истории без перехода экрана", async () => {
    const screen = vi.fn();
    window.addEventListener("popstate", screen);
    window.history.replaceState({ idx: 3 }, "", "/requests?tab=closed");
    render(<Sheet />);
    await click(opener());
    expect(window.history.state).toMatchObject({ idx: 3, uiLayer: 1 });
    await click(document.querySelector<HTMLButtonElement>(".ui-dialog-close"));
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(window.history.state).toEqual({ idx: 3 });
    expect(window.location.pathname + window.location.search).toBe("/requests?tab=closed");
    expect(screen).not.toHaveBeenCalled();
    window.removeEventListener("popstate", screen);
  });

  it("слой не закрылся (спросили о несохранённом) — запись возвращается", async () => {
    render(<Sheet keep />);
    await click(opener());
    await act(async () => {
      window.history.back();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(dialog()).not.toBeNull();
    expect(window.history.state).toMatchObject({ uiLayer: 1 });
  });
});

describe("фокус не выпадает из диалога", () => {
  it("кнопка под фокусом стала недоступной — фокус возвращается в диалог; Esc с body закрывает", async () => {
    closes = 0;
    render(<Sheet />);
    click(opener());
    const inside = document.querySelector<HTMLButtonElement>(".inside");
    act(() => inside?.focus());
    act(() => inside?.blur());
    expect(document.activeElement).toBe(document.body);
    await tick();
    expect(document.activeElement).toBe(dialog());
    act(() => (document.activeElement as HTMLElement).blur());
    act(() => {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    expect(closes).toBe(1);
    expect(dialog()).toBeNull();
  });
});
