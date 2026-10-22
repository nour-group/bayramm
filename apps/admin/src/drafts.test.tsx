// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { clearDrafts, saveDrafts, useDraft } from "./drafts";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/* Сессия кончилась посреди правки: несохранённое — во вкладку, после входа форма его забирает. */

let root: Root;
let container: HTMLDivElement;
let restored: unknown[] = [];

function Form({ initial, dirty }: { initial: string; dirty: boolean }) {
  const [value, setValue] = useState(initial);
  const back = useDraft("listing:1", value, dirty, (draft) => {
    restored.push(draft);
    if (typeof draft !== "string") return false;
    setValue(draft);
    return true;
  });
  return (
    <p>
      {value}
      {back ? " · вернули" : ""}
    </p>
  );
}

function mount(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(node));
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.sessionStorage.clear();
  restored = [];
});

describe("черновики форм на конец сессии", () => {
  it("несохранённое — во вкладку; та же форма после входа его забирает и говорит об этом", () => {
    mount(<Form initial="Моё описание" dirty />);
    expect(saveDrafts()).toBe(1);
    act(() => root.unmount());
    container.remove();
    mount(<Form initial="Из базы" dirty={false} />);
    expect(container.textContent).toBe("Моё описание · вернули");
    // Забрали один раз: черновика во вкладке больше нет
    act(() => root.unmount());
    container.remove();
    mount(<Form initial="Из базы" dirty={false} />);
    expect(container.textContent).toBe("Из базы");
  });

  it("сохранённая форма черновика не оставляет; выход стирает прежние", () => {
    mount(<Form initial="Без правок" dirty={false} />);
    expect(saveDrafts()).toBe(0);
    window.sessionStorage.setItem("bayramm.admin.draft:listing:1", JSON.stringify("старое"));
    clearDrafts();
    act(() => root.unmount());
    container.remove();
    mount(<Form initial="Из базы" dirty={false} />);
    expect(restored).toEqual([]);
    expect(container.textContent).toBe("Из базы");
  });
});
