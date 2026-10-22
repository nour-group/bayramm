// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearDrafts, DRAFT_TTL_MS, saveDrafts, useDraft } from "./drafts";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/* Сессия кончилась посреди правки: несохранённое — во вкладку, после входа того же сотрудника
   форма его забирает; чужое, старое и формы только для чтения — нет. */

let root: Root | null = null;
let container: HTMLDivElement;
let restored: unknown[] = [];

function Form({
  initial,
  dirty,
  staffId = "staff-1",
  enabled = true,
}: {
  initial: string;
  dirty: boolean;
  staffId?: string;
  enabled?: boolean;
}) {
  const [value, setValue] = useState(initial);
  const back = useDraft(
    "listing:1",
    value,
    dirty,
    (draft) => {
      restored.push(draft);
      if (typeof draft !== "string") return false;
      setValue(draft);
      return true;
    },
    { staffId, enabled },
  );
  return (
    <p>
      {value}
      {back ? " · вернули" : ""}
    </p>
  );
}

function mount(node: React.ReactNode) {
  if (root) act(() => root?.unmount());
  container?.remove();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
  window.sessionStorage.clear();
  restored = [];
  vi.useRealTimers();
});

describe("черновики форм на конец сессии", () => {
  it("несохранённое — во вкладку; та же форма того же сотрудника после входа его забирает", () => {
    mount(<Form initial="Моё описание" dirty />);
    expect(saveDrafts("staff-1")).toBe(1);
    mount(<Form initial="Из базы" dirty={false} />);
    expect(container.textContent).toBe("Моё описание · вернули");
    // Забрали один раз: черновика во вкладке больше нет
    mount(<Form initial="Из базы" dirty={false} />);
    expect(container.textContent).toBe("Из базы");
  });

  it("вошёл другой сотрудник — чужое не возвращается и стирается при входе", () => {
    mount(<Form initial="Чужое описание" dirty />);
    saveDrafts("staff-1");
    clearDrafts("staff-2");
    expect(window.sessionStorage.length).toBe(0);
    mount(<Form initial="Из базы" dirty={false} staffId="staff-2" />);
    expect(container.textContent).toBe("Из базы");
  });

  it("старое (дольше срока) и форма только для чтения — не возвращаются", () => {
    vi.useFakeTimers();
    mount(<Form initial="Давнее" dirty />);
    saveDrafts("staff-1");
    vi.advanceTimersByTime(DRAFT_TTL_MS + 1);
    mount(<Form initial="Из базы" dirty={false} />);
    expect(restored).toEqual([]);
    expect(container.textContent).toBe("Из базы");

    // Модератор: его форма ничего не кладёт и ничего не забирает
    mount(<Form initial="Видит" dirty enabled={false} />);
    expect(saveDrafts("staff-1")).toBe(0);
  });

  it("выход стирает все черновики", () => {
    mount(<Form initial="Моё" dirty />);
    saveDrafts("staff-1");
    clearDrafts();
    mount(<Form initial="Из базы" dirty={false} />);
    expect(restored).toEqual([]);
  });
});
