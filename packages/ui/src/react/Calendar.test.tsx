// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addDays,
  addMonths,
  Calendar,
  type CalendarTexts,
  daysInMonth,
  monthOf,
  weekdayMon,
} from "./Calendar";
import { DateField } from "./DateField";
import { cleanup, click, labelledBy, press, render, setViewport } from "./test/harness";

const MONTHS = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
const TEXTS: CalendarTexts = {
  prev: "Предыдущий месяц",
  next: "Следующий месяц",
  weekdays: ["пн", "вт", "ср", "чт", "пт", "сб", "вс"],
  monthTitle: (month) => `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`,
  dayLabel: (date) => `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]}`,
  free: "свободно",
  busy: "занято",
  selected: "ваша дата",
  summary: (n) => (n ? `занято ${n}` : "весь месяц свободен"),
};
const BUSY: ReadonlySet<string> = new Set(["2026-10-08"]);

const day = (label: string) =>
  document.querySelector<HTMLButtonElement>(`.ui-cal-day[aria-label^="${label}"]`);

beforeEach(() => setViewport(1024));
afterEach(cleanup);

describe("даты", () => {
  it("месяцы, дни и недели без часовых поясов", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addMonths("2026-12-01", 1)).toBe("2027-01-01");
    expect(daysInMonth("2028-02-01")).toBe(29);
    expect(monthOf("2026-10-15")).toBe("2026-10-01");
    expect(weekdayMon("2026-10-05")).toBe(0);
    expect(weekdayMon("2026-10-04")).toBe(6);
  });
});

describe("Calendar", () => {
  function Picker() {
    const [selected, setSelected] = useState<string | null>(null);
    return (
      <Calendar
        label="Дата праздника"
        min="2026-10-02"
        max="2027-01-31"
        busy={BUSY}
        selected={selected}
        onSelect={setSelected}
        texts={TEXTS}
      />
    );
  }

  it("месяц с понедельника; вне диапазона и занятые — aria-disabled и не выбираются", () => {
    render(<Picker />);
    expect(document.querySelector('[role="group"]')?.getAttribute("aria-label")).toBe("Дата праздника");
    expect(document.querySelector(".ui-cal-title")?.textContent).toBe("окт 2026занято 1");
    // 1 октября 2026 — четверг: три пустые клетки
    expect(document.querySelectorAll(".ui-cal-pad")).toHaveLength(3);
    expect(day("1 окт")?.getAttribute("aria-label")).toBe("1 окт");
    expect(day("1 окт")?.getAttribute("aria-disabled")).toBe("true");
    expect(day("8 окт")?.getAttribute("aria-label")).toBe("8 окт, занято");
    expect(day("8 окт")?.getAttribute("aria-disabled")).toBe("true");
    click(day("8 окт"));
    expect(day("8 окт")?.getAttribute("aria-pressed")).toBe("false");
    click(day("15 окт"));
    expect(day("15 окт")?.getAttribute("aria-pressed")).toBe("true");
    expect(day("15 окт")?.classList.contains("is-selected")).toBe(true);
  });

  it("один день в порядке Tab; стрелки, Home/End и PageDown ходят по дням", () => {
    render(<Picker />);
    const stops = [...document.querySelectorAll<HTMLButtonElement>(".ui-cal-day")].filter(
      (b) => b.tabIndex === 0,
    );
    expect(stops.map((b) => b.getAttribute("aria-label"))).toEqual(["2 окт, свободно"]);
    stops[0]?.focus();
    press(document.activeElement, "ArrowDown");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("9 окт, свободно");
    // Занятый день получает фокус: диктор прочтёт «занято»
    press(document.activeElement, "ArrowLeft");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("8 окт, занято");
    press(document.activeElement, "Home");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("5 окт, свободно");
    press(document.activeElement, "End");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("11 окт, свободно");
    press(document.activeElement, "PageDown");
    expect(document.querySelector(".ui-cal-title span")?.textContent).toBe("ноя 2026");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("11 ноя, свободно");
  });

  it("месяцы не уходят за min и max; недоступная кнопка отдаёт фокус соседней", () => {
    render(<Picker />);
    const prev = document.querySelector<HTMLButtonElement>('button[aria-label="Предыдущий месяц"]');
    const next = document.querySelector<HTMLButtonElement>('button[aria-label="Следующий месяц"]');
    expect(prev?.disabled).toBe(true);
    next?.focus();
    click(next);
    click(next);
    click(next);
    expect(document.querySelector(".ui-cal-title span")?.textContent).toBe("янв 2027");
    expect(next?.disabled).toBe(true);
    expect(document.activeElement).toBe(prev);
  });

  it("фильтр дат: открывается на defaultMonth, без пометок «свободно/занято» и легенды", () => {
    render(
      <Calendar
        label="С"
        min="2024-10-01"
        max="2026-10-01"
        defaultMonth="2026-10-01"
        selected={null}
        onSelect={() => {}}
        legend={false}
        texts={{ ...TEXTS, free: "", busy: "", selected: "", summary: undefined }}
      />,
    );
    expect(document.querySelector(".ui-cal-title")?.textContent).toBe("окт 2026");
    expect(day("1 окт")?.getAttribute("aria-label")).toBe("1 окт");
    expect(day("2 окт")?.getAttribute("aria-disabled")).toBe("true");
    expect(document.querySelector(".ui-cal-legend")).toBeNull();
  });

  it("без onSelect — только показывает занятость, кнопок нет", () => {
    render(
      <Calendar
        label="Занятость"
        min="2026-10-01"
        max="2026-12-31"
        busy={BUSY}
        selected={null}
        texts={TEXTS}
      />,
    );
    expect(document.querySelectorAll("button.ui-cal-day")).toHaveLength(0);
    expect(document.querySelector(".ui-cal")?.classList.contains("is-view")).toBe(true);
    expect(document.querySelector("span.ui-cal-day.is-busy .ui-sr-only")?.textContent).toBe("8 окт, занято");
  });
});

describe("DateField вместо input type=date", () => {
  let changes: (string | null)[] = [];
  function Field({ initial = null }: { initial?: string | null }) {
    const [value, setValue] = useState<string | null>(initial);
    return (
      <DateField
        id="date"
        label="Дата праздника"
        placeholder="Выберите дату"
        value={value}
        min="2026-10-02"
        max="2027-01-31"
        busy={BUSY}
        texts={TEXTS}
        clearLabel="Любая дата"
        format={(date) => TEXTS.dayLabel(date)}
        onChange={(next) => {
          changes.push(next);
          setValue(next);
        }}
      />
    );
  }
  const trigger = () => document.getElementById("date") as HTMLButtonElement;
  const panel = () => document.querySelector<HTMLElement>('.ui-layer [role="dialog"]');

  beforeEach(() => {
    changes = [];
  });

  it("кнопка поля: aria-haspopup=dialog, имя — подпись и значение", () => {
    render(<Field />);
    expect(trigger().getAttribute("aria-haspopup")).toBe("dialog");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(labelledBy(trigger())).toBe("Дата праздника Выберите дату");
    expect(document.querySelector('input[type="date"]')).toBeNull();
  });

  it("открытие ставит фокус на выбранный день; выбор закрывает и возвращает фокус полю", () => {
    render(<Field initial="2026-10-20" />);
    click(trigger());
    expect(panel()?.getAttribute("aria-label")).toBe("Дата праздника");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("20 окт, свободно");
    click(day("22 окт"));
    expect(changes).toEqual(["2026-10-22"]);
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(trigger());
    expect(labelledBy(trigger())).toBe("Дата праздника 22 окт");
  });

  it("«Любая дата» сбрасывает; Esc закрывает без изменений", () => {
    render(<Field initial="2026-10-20" />);
    click(trigger());
    press(document.activeElement, "Escape");
    expect(panel()).toBeNull();
    expect(changes).toEqual([]);
    expect(document.activeElement).toBe(trigger());
    click(trigger());
    click([...document.querySelectorAll(".ui-date-actions button")][0]);
    expect(changes).toEqual([null]);
  });

  it("на телефоне — шторка с заголовком", () => {
    setViewport(360);
    render(<Field />);
    click(trigger());
    const sheet = document.querySelector('[role="dialog"][aria-modal="true"]');
    expect(labelledBy(sheet)).toBe("Дата праздника");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("2 окт, свободно");
  });
});
