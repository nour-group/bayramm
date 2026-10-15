// @vitest-environment jsdom
import { act, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { fitSuggest, SearchSuggest, type SuggestGroup, type SuggestOption } from "./SearchSuggest";
import { cleanup, click, labelledBy, mouseDown, press, render, type } from "./test/harness";

/* Поиск с подсказками: подсказки подбирает приложение (здесь — по началу подписи, как ответ
   API); поле — combobox, фокус в нём всегда, подсказки — группами. */

const ALL: readonly SuggestGroup[] = [
  { id: "sections", label: "Разделы", options: [{ id: "c:car", label: "Кортеж" }] },
  {
    id: "districts",
    label: "Районы",
    options: [{ id: "d:chilonzor:hall", label: "Чиланзар — тойханы" }],
  },
  {
    id: "listings",
    label: "Витрины",
    options: [
      { id: "l:versal", label: "Versal", hint: "Тойхона · Чиланзар", media: <img alt="" src="x.webp" /> },
      { id: "l:korona", label: "Korona", hint: "Тойхона" },
    ],
  },
];

let picked: string[] = [];
let submitted: string[] = [];

function Field({
  groups = ALL,
  status = "4 подсказки",
}: {
  groups?: readonly SuggestGroup[];
  status?: string;
}) {
  const [value, setValue] = useState("");
  return (
    <form>
      <SearchSuggest
        id="q"
        label="Поиск"
        placeholder="Тойхона, кортеж, район"
        value={value}
        onChange={setValue}
        groups={value.length >= 2 ? groups : []}
        status={value.length >= 2 ? status : ""}
        onPick={(option: SuggestOption, group: SuggestGroup) => picked.push(`${group.id}/${option.id}`)}
        onSubmit={(text) => submitted.push(text)}
      />
      <button type="button">Дальше</button>
    </form>
  );
}

const input = () => document.getElementById("q") as HTMLInputElement;
const listbox = () => document.querySelector<HTMLElement>('[role="listbox"]');
const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];
const active = () => document.getElementById(input().getAttribute("aria-activedescendant") ?? "");
const live = () => document.querySelector<HTMLElement>('[aria-live="polite"]');

function focusField() {
  act(() => input().focus());
}

afterEach(() => {
  cleanup();
  picked = [];
  submitted = [];
});

describe("SearchSuggest", () => {
  it("поле — combobox поиска: роль, enterkeyhint, имя; закрыт — списка нет и ссылаться не на что", () => {
    render(<Field />);
    expect(input().getAttribute("role")).toBe("combobox");
    expect(input().getAttribute("type")).toBe("search");
    expect(input().getAttribute("enterkeyhint")).toBe("search");
    expect(input().getAttribute("aria-label")).toBe("Поиск");
    expect(input().getAttribute("aria-autocomplete")).toBe("list");
    expect(input().getAttribute("aria-expanded")).toBe("false");
    expect(input().hasAttribute("aria-controls")).toBe(false);
    expect(listbox()).toBeNull();
  });

  it("с двух символов — подсказки группами; число — вслух вежливо", () => {
    render(<Field />);
    focusField();
    type(input(), "к");
    expect(listbox()).toBeNull();
    type(input(), "ко");
    expect(input().getAttribute("aria-expanded")).toBe("true");
    expect(input().getAttribute("aria-controls")).toBe(listbox()?.id);
    const groups = [...document.querySelectorAll<HTMLElement>('[role="group"]')];
    expect(groups.map((g) => labelledBy(g))).toEqual(["Разделы", "Районы", "Витрины"]);
    expect(options().map((o) => o.textContent)).toEqual([
      "Кортеж",
      "Чиланзар — тойханы",
      "VersalТойхона · Чиланзар",
      "KoronaТойхона",
    ]);
    expect(live()?.textContent).toBe("4 подсказки");
    expect(input().getAttribute("aria-describedby")).toBe(live()?.id);
  });

  it("стрелки ходят по всем группам по кругу; Enter выбирает активную", () => {
    render(<Field />);
    focusField();
    type(input(), "ko");
    expect(input().hasAttribute("aria-activedescendant")).toBe(false);
    press(input(), "ArrowDown");
    expect(active()?.textContent).toBe("Кортеж");
    expect(active()?.getAttribute("aria-selected")).toBe("true");
    press(input(), "ArrowDown");
    press(input(), "ArrowDown");
    expect(active()?.textContent).toBe("VersalТойхона · Чиланзар");
    press(input(), "ArrowUp");
    expect(active()?.textContent).toBe("Чиланзар — тойханы");
    press(input(), "ArrowUp");
    press(input(), "ArrowUp");
    expect(active()?.textContent).toBe("KoronaТойхона");
    press(input(), "Enter");
    expect(picked).toEqual(["listings/l:korona"]);
    expect(listbox()).toBeNull();
    expect(submitted).toEqual([]);
  });

  it("Enter без активной подсказки — поиск по тексту, список закрывается", () => {
    render(<Field />);
    focusField();
    type(input(), "kortej");
    press(input(), "Enter");
    expect(submitted).toEqual(["kortej"]);
    expect(listbox()).toBeNull();
  });

  it("Esc закрывает список, второй Esc очищает поле; фокус остаётся в поле", () => {
    render(<Field />);
    focusField();
    type(input(), "ko");
    press(input(), "Escape");
    expect(listbox()).toBeNull();
    expect(input().value).toBe("ko");
    press(input(), "Escape");
    expect(input().value).toBe("");
    expect(document.activeElement).toBe(input());
  });

  it("нажатие на подсказку: фокус не уходит из поля до выбора, выбор — по нажатию", () => {
    render(<Field />);
    focusField();
    type(input(), "ko");
    const versal = options()[2] as HTMLElement;
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    act(() => {
      versal.dispatchEvent(down);
    });
    expect(down.defaultPrevented).toBe(true);
    click(versal);
    expect(picked).toEqual(["listings/l:versal"]);
  });

  it("ушли из поля — список закрывается", () => {
    render(<Field />);
    focusField();
    type(input(), "ko");
    expect(listbox()).not.toBeNull();
    // Крестик «Очистить» — внутри поиска: фокус на нём список не закрывает
    const clear = document.querySelector<HTMLButtonElement>(".ui-search-clear");
    act(() => clear?.focus());
    expect(listbox()).not.toBeNull();
    const next = [...document.querySelectorAll("button")].find((b) => b.textContent === "Дальше");
    act(() => next?.focus());
    expect(listbox()).toBeNull();
    expect(input().getAttribute("aria-expanded")).toBe("false");
  });

  it("подсказок нет — виден только статус, combobox закрыт; новые подсказки — активной нет", () => {
    const { rerender } = renderWith([]);
    focusField();
    type(input(), "zz");
    expect(listbox()).toBeNull();
    expect(document.querySelector(".ui-suggest-note")?.textContent).toBe("Ничего не нашлось");
    expect(input().getAttribute("aria-expanded")).toBe("false");
    rerender(ALL);
    expect(options()).toHaveLength(4);
    expect(input().hasAttribute("aria-activedescendant")).toBe(false);
  });

  it("высота панели — до видимой части экрана над клавиатурой и Telegram", () => {
    const field = document.createElement("span");
    const panel = document.createElement("div");
    field.getBoundingClientRect = () => ({ bottom: 200 }) as DOMRect;
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
    Object.defineProperty(window, "visualViewport", {
      value: { height: 500, offsetTop: 0, addEventListener() {}, removeEventListener() {} },
      configurable: true,
    });
    fitSuggest(field, panel);
    // 500 − 200 − 6 − 8
    expect(panel.style.maxHeight).toBe("286px");
    document.documentElement.style.setProperty("--tg-viewport-stable-height", "420px");
    fitSuggest(field, panel);
    expect(panel.style.maxHeight).toBe("206px");
    document.documentElement.style.removeProperty("--tg-viewport-stable-height");
    Object.defineProperty(window, "visualViewport", { value: undefined, configurable: true });
    fitSuggest(field, panel);
    expect(panel.style.maxHeight).toBe("586px");
    // Тесно — не меньше полутора строк: лучше прокрутить страницу
    field.getBoundingClientRect = () => ({ bottom: 780 }) as DOMRect;
    fitSuggest(field, panel);
    expect(panel.style.maxHeight).toBe("132px");
  });
});

/** Поле с подсказками, которые тест меняет сам (ответ API пришёл позже) */
function renderWith(initial: readonly SuggestGroup[]) {
  let set: (groups: readonly SuggestGroup[]) => void = () => {};
  function Holder() {
    const [groups, setGroups] = useState(initial);
    set = setGroups;
    return <Field groups={groups} status={groups.length === 0 ? "Ничего не нашлось" : "4 подсказки"} />;
  }
  render(<Holder />);
  return { rerender: (groups: readonly SuggestGroup[]) => act(() => set(groups)) };
}

describe("SearchSuggest: мышь", () => {
  it("наведение делает подсказку активной", () => {
    render(<Field />);
    focusField();
    type(input(), "ko");
    const korona = options()[3] as HTMLElement;
    act(() => {
      korona.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    });
    expect(active()).toBe(korona);
    mouseDown(korona);
    expect(document.activeElement).toBe(input());
  });
});
