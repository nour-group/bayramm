// @vitest-environment jsdom
import { act, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { accepts, FileDrop } from "./FileDrop";
import { NumberStepper } from "./NumberStepper";
import { SearchField } from "./SearchField";
import { TimeField, timeOptions } from "./TimeField";
import { ToastProvider, useToast } from "./Toast";
import { Tooltip } from "./Tooltip";
import { cleanup, click, press, render, type } from "./test/harness";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function Guests({ initial = "" }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <NumberStepper
      id="guests"
      value={value}
      onChange={setValue}
      min={1}
      max={300}
      step={20}
      decrementLabel="Гостей −20"
      incrementLabel="Гостей +20"
    />
  );
}

const guests = () => document.getElementById("guests") as HTMLInputElement;

describe("NumberStepper вместо input type=number", () => {
  it("текстовое поле с цифровой клавиатурой и role=spinbutton", () => {
    render(<Guests initial="100" />);
    const input = guests();
    expect(input.type).toBe("text");
    expect(input.inputMode).toBe("numeric");
    expect(input.getAttribute("role")).toBe("spinbutton");
    expect(input.getAttribute("aria-valuenow")).toBe("100");
    expect(input.getAttribute("aria-valuemin")).toBe("1");
    expect(input.getAttribute("aria-valuemax")).toBe("300");
  });

  it("в поле только цифры", () => {
    render(<Guests />);
    type(guests(), "1e2-");
    expect(guests().value).toBe("12");
  });

  it("стрелки — шаг, PageUp — десять шагов, границы держатся", () => {
    render(<Guests initial="100" />);
    press(guests(), "ArrowUp");
    expect(guests().value).toBe("120");
    press(guests(), "ArrowDown");
    press(guests(), "ArrowDown");
    expect(guests().value).toBe("80");
    press(guests(), "PageUp");
    expect(guests().value).toBe("280");
    press(guests(), "PageUp");
    expect(guests().value).toBe("300");
  });

  it("кнопки «−» и «+» подписаны, вне порядка Tab, у границы недоступны", () => {
    render(<Guests />);
    const [minus, plus] = [...document.querySelectorAll<HTMLButtonElement>("button")];
    expect(minus?.getAttribute("aria-label")).toBe("Гостей −20");
    expect(plus?.getAttribute("aria-label")).toBe("Гостей +20");
    expect(minus?.tabIndex).toBe(-1);
    click(plus);
    expect(guests().value).toBe("20");
    click(minus);
    expect(guests().value).toBe("1");
    expect(minus?.disabled).toBe(true);
  });

  it("без подписей кнопок — только поле", () => {
    render(<NumberStepper value="" onChange={() => {}} aria-label="Гостей" placeholder="Любое" />);
    expect(document.querySelectorAll("button")).toHaveLength(0);
    expect(document.querySelector("input")?.getAttribute("aria-label")).toBe("Гостей");
  });
});

const file = (name: string, type: string) => new File(["x"], name, { type });

describe("FileDrop вместо голого input type=file", () => {
  it("input остаётся: в порядке Tab, подписан лицом, принимает только нужное", () => {
    const got: string[][] = [];
    render(
      <FileDrop
        title="Добавить фото"
        hint="JPEG, PNG или WebP"
        accept="image/jpeg,image/png,.webp"
        multiple
        onFiles={(files) => got.push(files.map((f) => f.name))}
      />,
    );
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    expect(input?.tabIndex).toBe(0);
    const face = document.querySelector(`label[for="${input?.id}"]`);
    expect(face?.textContent).toBe("Добавить фото" + "JPEG, PNG или WebP");

    const files = [file("a.jpg", "image/jpeg"), file("b.pdf", "application/pdf"), file("c.webp", "")];
    Object.defineProperty(input, "files", { value: files, configurable: true });
    act(() => {
      input?.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(got).toEqual([["a.jpg", "c.webp"]]);
  });

  it("перетаскивание: рамка подсвечена, файлы уходят в onFiles; недоступный — ничего", () => {
    const got: string[] = [];
    render(
      <FileDrop title="Фото" accept="image/*" onFiles={(files) => got.push(...files.map((f) => f.name))} />,
    );
    const zone = document.querySelector(".ui-drop") as HTMLElement;
    const drag = (name: string, files: File[] = []) => {
      const event = new Event(name, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: { files, dropEffect: "none" } });
      act(() => {
        zone.dispatchEvent(event);
      });
    };
    drag("dragenter");
    expect(zone.classList.contains("is-dragging")).toBe(true);
    drag("drop", [file("x.png", "image/png"), file("y.txt", "text/plain")]);
    expect(zone.classList.contains("is-dragging")).toBe(false);
    expect(got).toEqual(["x.png"]);

    cleanup();
    got.length = 0;
    render(<FileDrop title="Фото" disabled onFiles={(files) => got.push(...files.map((f) => f.name))} />);
    const off = document.querySelector(".ui-drop") as HTMLElement;
    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: { files: [file("x.png", "image/png")] } });
    act(() => {
      off.dispatchEvent(event);
    });
    expect(got).toEqual([]);
    expect(document.querySelector<HTMLInputElement>('input[type="file"]')?.disabled).toBe(true);
  });

  it("accepts: MIME, группа и расширение", () => {
    expect(accepts(file("a.heic", ""), "image/jpeg,.heic")).toBe(true);
    expect(accepts(file("a.png", "image/png"), "image/*")).toBe(true);
    expect(accepts(file("a.png", "image/png"), "image/jpeg")).toBe(false);
    expect(accepts(file("a.png", "image/png"), undefined)).toBe(true);
  });
});

describe("TimeField вместо input type=time", () => {
  it("сетка с шагом, 24 часа; время вне сетки — на своём месте", () => {
    expect(timeOptions(60, null)).toHaveLength(24);
    expect(timeOptions(30, null).slice(0, 3)).toEqual(["00:00", "00:30", "01:00"]);
    expect(timeOptions(60, "22:15")).toContain("22:15");
    expect(timeOptions(60, "22:15").indexOf("22:15")).toBe(timeOptions(60, "22:15").indexOf("22:00") + 1);
    expect(timeOptions(60, "25:99")).toHaveLength(24);
  });

  it("выпадающий список набора: выбор уходит строкой «ЧЧ:ММ»", () => {
    const seen: string[] = [];
    function Quiet() {
      const [value, setValue] = useState<string | null>("22:00");
      return (
        <TimeField
          id="from"
          label="С"
          value={value}
          step={60}
          onChange={(next) => {
            seen.push(next);
            setValue(next);
          }}
        />
      );
    }
    render(<Quiet />);
    const button = document.getElementById("from") as HTMLButtonElement;
    expect(button.getAttribute("aria-haspopup")).toBe("listbox");
    expect(button.textContent).toBe("22:00");
    expect(document.querySelector('input[type="time"]')).toBeNull();
    click(button);
    click([...document.querySelectorAll('[role="option"]')].find((o) => o.textContent === "07:00"));
    expect(seen).toEqual(["07:00"]);
    expect(button.textContent).toBe("07:00");
  });
});

describe("SearchField", () => {
  it("type=search без системного крестика; свой крестик чистит и возвращает фокус", () => {
    function Search() {
      const [q, setQ] = useState("");
      return <SearchField value={q} onChange={setQ} aria-label="Поиск" placeholder="Название" />;
    }
    render(<Search />);
    const input = document.querySelector("input") as HTMLInputElement;
    expect(input.type).toBe("search");
    expect(input.getAttribute("aria-label")).toBe("Поиск");
    expect(document.querySelector("button")).toBeNull();
    type(input, "Oqsaroy");
    const clear = document.querySelector("button");
    expect(clear?.getAttribute("aria-label")).toBe("Очистить");
    click(clear);
    expect(input.value).toBe("");
    expect(document.activeElement).toBe(input);
    expect(document.querySelector("button")).toBeNull();
  });
});

describe("Toast вместо alert", () => {
  function Saver() {
    const toast = useToast();
    return (
      <>
        <button type="button" onClick={() => toast("Сохранено")}>
          ok
        </button>
        <button type="button" onClick={() => toast("Не сохранилось", { tone: "error" })}>
          fail
        </button>
      </>
    );
  }

  it("живые области есть заранее; обычное — status и само уходит, ошибка — alert и висит", () => {
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <Saver />
      </ToastProvider>,
    );
    const status = document.querySelector('[role="status"]');
    const alert = document.querySelector('[role="alert"]');
    expect(status?.textContent).toBe("");
    expect(alert?.textContent).toBe("");
    const [ok, fail] = [...document.querySelectorAll<HTMLButtonElement>("#root button")];
    click(ok);
    click(fail);
    expect(status?.textContent).toBe("Сохранено");
    expect(alert?.textContent).toBe("Не сохранилось");
    act(() => {
      vi.advanceTimersByTime(6000);
    });
    expect(status?.textContent).toBe("");
    expect(alert?.textContent).toBe("Не сохранилось");
    click(alert?.querySelector('button[aria-label="Закрыть"]'));
    expect(alert?.textContent).toBe("");
  });

  it("без провайдера — ошибка, а не тишина", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Saver />)).toThrow(/ToastProvider/);
    spy.mockRestore();
  });
});

describe("Tooltip вместо title", () => {
  function Lang() {
    return (
      <Tooltip text="Русский">
        {(trigger) => (
          <button type="button" {...trigger}>
            RU
          </button>
        )}
      </Tooltip>
    );
  }

  const pointer = (target: Element, name: string, pointerType: string) => {
    const event = new MouseEvent(name, { bubbles: true });
    Object.defineProperty(event, "pointerType", { value: pointerType });
    act(() => {
      target.dispatchEvent(event);
    });
  };

  it("текст связан через aria-describedby; атрибута title нет", () => {
    render(<Lang />);
    const button = document.querySelector("button");
    expect(button?.hasAttribute("title")).toBe(false);
    expect(document.getElementById(button?.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      "Русский",
    );
  });

  it("describe={false} — без aria-describedby: текст уже в имени элемента", () => {
    render(
      <Tooltip text="12 октября — занято" describe={false}>
        {(trigger) => (
          <button type="button" aria-label="12 октября — занято" {...trigger}>
            12
          </button>
        )}
      </Tooltip>,
    );
    expect(document.querySelector("button")?.hasAttribute("aria-describedby")).toBe(false);
    expect(document.querySelector("[hidden]")).toBeNull();
  });

  it("мышь — показывает с задержкой, Esc прячет; касание — не показывает", () => {
    vi.useFakeTimers();
    render(<Lang />);
    const button = document.querySelector("button") as HTMLElement;
    pointer(button, "pointerover", "touch");
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(document.querySelector(".ui-tooltip")).toBeNull();
    pointer(button, "pointerover", "mouse");
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(document.querySelector(".ui-tooltip")?.textContent).toBe("Русский");
    press(document.body, "Escape");
    expect(document.querySelector(".ui-tooltip")).toBeNull();
  });
});
