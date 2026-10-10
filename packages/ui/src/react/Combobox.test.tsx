// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Combobox } from "./Combobox";
import type { SelectOption } from "./Select";
import {
  cleanup,
  click,
  labelledBy,
  press,
  render,
  restoreSpies,
  setViewport,
  spyFocus,
  type,
} from "./test/harness";

/* Список с поиском: варианты подбирает приложение по введённому (здесь — фильтр по началу
   подписи, как ответ API), выбранное может не входить в найденное. */

const VENDORS: readonly SelectOption[] = [
  { value: "v1", label: "Lola · V101" },
  { value: "v2", label: "Oqsaroy · V102", hint: "Тойхона" },
  { value: "v3", label: "Navruz · V103", disabled: true },
  { value: "v4", label: "Bogʻ zali · V104" },
];

let searches: string[] = [];
let changes: (string | null)[] = [];

function Field({ initial = null, loading = false }: { initial?: string | null; loading?: boolean }) {
  const [value, setValue] = useState<string | null>(initial);
  const [options, setOptions] = useState<readonly SelectOption[]>(VENDORS);
  return (
    <form>
      <label htmlFor="object">Вендор</label>
      <Combobox
        id="object"
        label="Вендор"
        value={value}
        valueLabel={value === "far" ? "Далёкий · V900" : undefined}
        options={options}
        anyLabel="Любой"
        loading={loading}
        loadingText="Ищем…"
        emptyText="Ничего не нашлось"
        searchPlaceholder="Название или код"
        onSearch={(query) => {
          searches.push(query);
          setOptions(VENDORS.filter((v) => v.label.toLowerCase().startsWith(query.toLowerCase())));
        }}
        onChange={(next) => {
          changes.push(next);
          setValue(next);
        }}
      />
      <button type="button">Дальше</button>
    </form>
  );
}

const trigger = () => document.getElementById("object") as HTMLButtonElement;
const input = () => document.querySelector<HTMLInputElement>('[role="combobox"]');
const listbox = () => document.querySelector<HTMLElement>('[role="listbox"]');
const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];
const active = () => document.getElementById(input()?.getAttribute("aria-activedescendant") ?? "");

beforeEach(() => {
  searches = [];
  changes = [];
  setViewport(1024);
});

afterEach(() => {
  cleanup();
  restoreSpies();
});

describe("Combobox: закрытый", () => {
  it("кнопка: имя — подпись и выбранное; ничего не выбрано — «Любой»; списка нет", () => {
    render(<Field />);
    expect(trigger().tagName).toBe("BUTTON");
    expect(trigger().getAttribute("aria-haspopup")).toBe("listbox");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(labelledBy(trigger())).toBe("Вендор Любой");
    expect(listbox()).toBeNull();
  });

  it("выбранное не из найденного — подпись приходит отдельно", () => {
    render(<Field initial="far" />);
    expect(labelledBy(trigger())).toBe("Вендор Далёкий · V900");
  });
});

describe("Combobox: поиск и выбор", () => {
  it("открытие: фокус в поле поиска без прокрутки, поле — combobox, поиск с пустой строки", () => {
    const focus = spyFocus();
    render(<Field />);
    click(trigger());
    const field = input();
    expect(field).not.toBeNull();
    expect(document.activeElement).toBe(field);
    expect(focus.calls.at(-1)).toEqual({ element: field, options: { preventScroll: true } });
    expect(field?.getAttribute("aria-controls")).toBe(listbox()?.id);
    expect(field?.getAttribute("aria-expanded")).toBe("true");
    expect(field?.getAttribute("aria-autocomplete")).toBe("list");
    expect(field?.getAttribute("placeholder")).toBe("Название или код");
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(searches).toEqual([""]);
    expect(options().map((o) => o.textContent)).toEqual([
      "Любой",
      "Lola · V101",
      "Oqsaroy · V102Тойхона",
      "Navruz · V103",
      "Bogʻ zali · V104",
    ]);
    // Список — в портале body, не внутри формы
    expect(document.querySelector("form [role='listbox']")).toBeNull();
  });

  it("ввод — запрос вариантов; стрелки ходят по ним мимо недоступных, Enter выбирает и возвращает фокус", () => {
    const focus = spyFocus();
    render(<Field />);
    click(trigger());
    type(input() as HTMLInputElement, "o");
    expect(searches).toEqual(["", "o"]);
    expect(options().map((o) => o.textContent)).toEqual(["Любой", "Oqsaroy · V102Тойхона"]);
    press(input(), "ArrowDown");
    expect(active()?.textContent).toBe("Любой");
    press(input(), "ArrowDown");
    expect(active()?.textContent).toBe("Oqsaroy · V102Тойхона");
    press(input(), "Enter");
    expect(changes).toEqual(["v2"]);
    expect(listbox()).toBeNull();
    expect(labelledBy(trigger())).toBe("Вендор Oqsaroy · V102");
    expect(document.activeElement).toBe(trigger());
    expect(focus.calls.at(-1)).toEqual({ element: trigger(), options: { preventScroll: true } });
  });

  it("недоступный вариант не выбирается; «Любой» снимает выбор (null)", () => {
    render(<Field initial="v1" />);
    click(trigger());
    click(options()[3]);
    expect(changes).toEqual([]);
    expect(listbox()).not.toBeNull();
    click(options()[0]);
    expect(changes).toEqual([null]);
    expect(labelledBy(trigger())).toBe("Вендор Любой");
  });

  it("ничего не нашлось и пока ищем — словами под полем (живая область)", () => {
    render(<Field />);
    click(trigger());
    type(input() as HTMLInputElement, "zzz");
    const note = document.querySelector(".ui-combo-note");
    expect(note?.textContent).toBe("Ничего не нашлось");
    expect(note?.getAttribute("aria-live")).toBe("polite");
    expect(input()?.getAttribute("aria-describedby")).toBe(note?.id);
    cleanup();
    render(<Field loading />);
    click(trigger());
    expect(document.querySelector(".ui-combo-note")?.textContent).toBe("Ищем…");
  });

  it("Esc закрывает без выбора и возвращает фокус кнопке", () => {
    render(<Field />);
    click(trigger());
    press(input(), "ArrowDown");
    press(input(), "Escape");
    expect(listbox()).toBeNull();
    expect(changes).toEqual([]);
    expect(document.activeElement).toBe(trigger());
  });

  it("стрелка вниз на кнопке открывает список", () => {
    render(<Field />);
    press(trigger(), "ArrowDown");
    expect(listbox()).not.toBeNull();
  });

  it("телефон: шторка-диалог с заголовком — подписью поля", () => {
    setViewport(390);
    render(<Field />);
    click(trigger());
    const sheet = document.querySelector('[role="dialog"]');
    expect(sheet).not.toBeNull();
    expect(labelledBy(sheet)).toBe("Вендор");
    expect(sheet?.contains(input())).toBe(true);
  });
});
