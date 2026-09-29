// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Select, type SelectOption } from "./Select";
import {
  cleanup,
  click,
  labelledBy,
  mouseDown,
  press,
  render,
  restoreSpies,
  setViewport,
  spyFocus,
} from "./test/harness";

type District = "" | "chilonzor" | "yunusobod" | "yakkasaroy" | "mirobod" | "sergeli";

const OPTIONS: readonly SelectOption<District>[] = [
  { value: "", label: "Любой район" },
  { value: "chilonzor", label: "Чиланзар" },
  { value: "yunusobod", label: "Юнусабад", disabled: true },
  { value: "yakkasaroy", label: "Яккасарай" },
  { value: "mirobod", label: "Мирабад", hint: "центр" },
  { value: "sergeli", label: "Сергели" },
];

let changes: string[] = [];

function Field({ initial = "chilonzor", disabled = false }: { initial?: District; disabled?: boolean }) {
  const [value, setValue] = useState<District>(initial);
  return (
    <form>
      <label htmlFor="district">Район</label>
      <Select
        id="district"
        label="Район"
        value={value}
        options={OPTIONS}
        disabled={disabled}
        onChange={(next) => {
          changes.push(next);
          setValue(next);
        }}
      />
      <button type="button">Дальше</button>
    </form>
  );
}

const trigger = () => document.getElementById("district") as HTMLButtonElement;
const listbox = () => document.querySelector<HTMLElement>('[role="listbox"]');
const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];
const active = () => document.getElementById(listbox()?.getAttribute("aria-activedescendant") ?? "");

beforeEach(() => {
  changes = [];
  setViewport(1024);
});

afterEach(() => {
  cleanup();
  restoreSpies();
});

describe("Select: закрытый", () => {
  it("кнопка с aria-haspopup=listbox; имя — подпись и значение; списка в DOM нет", () => {
    render(<Field />);
    const button = trigger();
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("type")).toBe("button");
    expect(button.getAttribute("aria-haspopup")).toBe("listbox");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.hasAttribute("aria-controls")).toBe(false);
    expect(labelledBy(button)).toBe("Район Чиланзар");
    expect(listbox()).toBeNull();
    expect(document.querySelector("select")).toBeNull();
  });

  it("без значения — плейсхолдер", () => {
    render(
      <Select label="Сортировка" value={null} placeholder="Выберите" options={OPTIONS} onChange={() => {}} />,
    );
    const button = document.querySelector("button");
    expect(button?.textContent).toBe("Выберите");
    expect(button?.querySelector(".ui-select-value.is-placeholder")).not.toBeNull();
  });

  it("недоступный не открывается", () => {
    render(<Field disabled />);
    click(trigger());
    expect(listbox()).toBeNull();
    press(trigger(), "ArrowDown");
    expect(listbox()).toBeNull();
  });
});

describe("Select: открытие и выбор", () => {
  it("нажатие открывает список: фокус в списке без прокрутки, активен выбранный", () => {
    const focus = spyFocus();
    render(<Field />);
    click(trigger());
    const list = listbox();
    expect(list).not.toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(trigger().getAttribute("aria-controls")).toBe(list?.id);
    expect(document.activeElement).toBe(list);
    expect(focus.calls.at(-1)).toEqual({ element: list, options: { preventScroll: true } });
    expect(labelledBy(list)).toBe("Район");
    expect(active()?.textContent).toBe("Чиланзар");
    expect(options().map((o) => o.getAttribute("aria-selected"))).toEqual([
      "false",
      "true",
      "false",
      "false",
      "false",
      "false",
    ]);
    expect(options()[2]?.getAttribute("aria-disabled")).toBe("true");
    // Список — в портале body, не внутри формы: его не обрежет overflow предков
    expect(list?.closest("form")).toBeNull();
  });

  it("стрелки пропускают недоступный вариант; Home/End; Enter выбирает и возвращает фокус", () => {
    const focus = spyFocus();
    render(<Field />);
    click(trigger());
    press(listbox(), "ArrowDown");
    expect(active()?.textContent).toBe("Яккасарай");
    press(listbox(), "ArrowUp");
    expect(active()?.textContent).toBe("Чиланзар");
    press(listbox(), "End");
    expect(active()?.textContent).toBe("Сергели");
    press(listbox(), "ArrowDown");
    expect(active()?.textContent).toBe("Сергели");
    press(listbox(), "Home");
    expect(active()?.textContent).toBe("Любой район");
    press(listbox(), "PageDown");
    expect(active()?.textContent).toBe("Сергели");
    press(listbox(), "ArrowUp");
    press(listbox(), "Enter");
    expect(changes).toEqual(["mirobod"]);
    expect(listbox()).toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger());
    expect(focus.calls.at(-1)).toEqual({ element: trigger(), options: { preventScroll: true } });
    expect(labelledBy(trigger())).toBe("Район Мирабад");
  });

  it("пробел выбирает; тот же вариант — без onChange", () => {
    render(<Field />);
    click(trigger());
    press(listbox(), " ");
    expect(changes).toEqual([]);
    expect(listbox()).toBeNull();
  });

  it("нажатие на вариант выбирает; на недоступный — ничего", () => {
    render(<Field />);
    click(trigger());
    click(options()[2]);
    expect(changes).toEqual([]);
    expect(listbox()).not.toBeNull();
    click(options()[5]);
    expect(changes).toEqual(["sergeli"]);
    expect(listbox()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("поиск по буквам: начало подписи, повтор буквы — по кругу, недоступные мимо", () => {
    render(<Field initial="" />);
    click(trigger());
    press(listbox(), "я");
    expect(active()?.textContent).toBe("Яккасарай");
    press(listbox(), "с");
    // «яс» ни с чего не начинается — активный не меняется
    expect(active()?.textContent).toBe("Яккасарай");
  });

  it("буква на закрытом поле открывает список на найденном варианте", () => {
    render(<Field initial="" />);
    trigger().focus();
    press(trigger(), "м");
    expect(listbox()).not.toBeNull();
    expect(active()?.textContent).toMatch(/^Мирабад/);
  });

  it("стрелка вниз на закрытом поле открывает список", () => {
    render(<Field />);
    press(trigger(), "ArrowDown");
    expect(listbox()).not.toBeNull();
    expect(active()?.textContent).toBe("Чиланзар");
  });
});

describe("Select: закрытие", () => {
  it("Esc закрывает без выбора, фокус — на поле", () => {
    render(<Field />);
    click(trigger());
    press(listbox(), "ArrowDown");
    press(listbox(), "Escape");
    expect(listbox()).toBeNull();
    expect(changes).toEqual([]);
    expect(document.activeElement).toBe(trigger());
  });

  it("Esc не всплывает к диалогу вокруг", () => {
    let outer = 0;
    render(
      // biome-ignore lint/a11y/noStaticElementInteractions: тестовая обёртка ловит всплывший Esc
      <div
        onKeyDown={(event) => {
          if (event.key === "Escape") outer++;
        }}
      >
        <Field />
      </div>,
    );
    click(trigger());
    press(listbox(), "Escape");
    expect(outer).toBe(0);
  });

  it("Tab закрывает и оставляет фокус на поле — браузер уведёт его на следующее", () => {
    render(<Field />);
    click(trigger());
    press(listbox(), "Tab");
    expect(listbox()).toBeNull();
    expect(changes).toEqual([]);
    expect(document.activeElement).toBe(trigger());
  });

  it("нажатие мимо закрывает и не тянет фокус на поле", () => {
    render(<Field />);
    click(trigger());
    const next = document.querySelector<HTMLButtonElement>("form > button:last-child");
    next?.focus();
    mouseDown(next as HTMLElement);
    expect(listbox()).toBeNull();
    expect(document.activeElement).toBe(next);
  });

  it("повторное нажатие на поле закрывает", () => {
    render(<Field />);
    click(trigger());
    click(trigger());
    expect(listbox()).toBeNull();
  });
});

describe("Select: телефон — шторка снизу", () => {
  it("модальный диалог с заголовком и «Закрыть»; страница inert и не прокручивается", () => {
    setViewport(375);
    const root = render(<Field />);
    click(trigger());
    const sheet = document.querySelector('[role="dialog"]');
    expect(sheet?.getAttribute("aria-modal")).toBe("true");
    expect(labelledBy(sheet)).toBe("Район");
    expect(sheet?.querySelector('[role="listbox"]')).toBe(listbox());
    expect(document.activeElement).toBe(listbox());
    expect(root.hasAttribute("inert")).toBe(true);
    expect(root.getAttribute("aria-hidden")).toBe("true");
    expect(document.documentElement.classList.contains("ui-lock")).toBe(true);

    click(sheet?.querySelector('button[aria-label="Закрыть"]'));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(root.hasAttribute("inert")).toBe(false);
    expect(root.hasAttribute("aria-hidden")).toBe(false);
    expect(document.documentElement.classList.contains("ui-lock")).toBe(false);
    // Фокус вернулся после снятия inert
    expect(document.activeElement).toBe(trigger());
  });

  it("подложка закрывает; Tab ходит внутри шторки", () => {
    setViewport(375);
    render(<Field />);
    click(trigger());
    press(listbox(), "Tab");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Закрыть");
    // С первого элемента назад — на последний (вперёд между ними ходит сам браузер)
    press(document.activeElement, "Tab", { shiftKey: true });
    expect(document.activeElement).toBe(listbox());
    click(document.querySelector(".ui-scrim"));
    expect(listbox()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("выбор в шторке", () => {
    setViewport(375);
    render(<Field />);
    click(trigger());
    click(options()[3]);
    expect(changes).toEqual(["yakkasaroy"]);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});

describe("Select: тема и язык поля", () => {
  it("портал берёт data-theme и lang у поля", () => {
    render(
      <div data-theme="lux" lang="uz">
        <Field />
      </div>,
    );
    click(trigger());
    const layer = listbox()?.closest(".ui-layer");
    expect(layer?.getAttribute("data-theme")).toBe("lux");
    expect(layer?.getAttribute("lang")).toBe("uz");
  });
});
