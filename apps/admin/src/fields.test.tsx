// @vitest-environment jsdom
// Поля под свои данные (fields.tsx, reason.tsx): телефон с маской, Telegram, деньги, адрес
// витрины, число с границами, выбор, готовые причины. Разбор — функциями, поведение — в DOM.
import { UiTextsProvider } from "@bayramm/ui/react";
import { act, type ReactNode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ChipsField,
  formatMoney,
  formatPhone,
  MoneyField,
  moneyDigits,
  NumberField,
  PhoneField,
  readPhone,
  SlugField,
  TelegramField,
  telegramProblem,
} from "./fields";
import { enumControl } from "./pages/AttributeFields";
import { ReasonField, togglePreset } from "./reason";
import { t } from "./texts";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("телефон: разбор и маска", () => {
  it.each([
    ["+998 90 111-22-33", "901112233"],
    ["998901112233", "901112233"],
    ["90 111 22 33", "901112233"],
    ["(90) 111", "90111"],
    ["", ""],
    // Код страны по привычке — уже стоит у поля
    ["+", ""],
    ["+99", ""],
    ["+998", ""],
    // Набирают с кодом без «+»: на десятой цифре код уходит
    ["9989011122", "9011122"],
  ])("%j → %j", (raw, digits) => {
    expect(readPhone(raw)).toBe(digits);
  });

  it.each(["+7 912 000 00 00", "+1 555", "9011122334"])("%j — не номер Узбекистана", (raw) => {
    expect(readPhone(raw)).toBeNull();
  });

  it("маска «XX XXX XX XX» — по мере набора", () => {
    expect(formatPhone("")).toBe("");
    expect(formatPhone("9")).toBe("9");
    expect(formatPhone("901")).toBe("90 1");
    expect(formatPhone("90111")).toBe("90 111");
    expect(formatPhone("901112")).toBe("90 111 2");
    expect(formatPhone("901112233")).toBe("90 111 22 33");
  });
});

describe("деньги и Telegram: разбор", () => {
  it("сумма — только цифры, без ведущих нулей, разряды — узким неразрывным пробелом", () => {
    expect(moneyDigits("1 500 000 сум", 11)).toBe("1500000");
    expect(moneyDigits("007", 11)).toBe("7");
    expect(moneyDigits("0", 11)).toBe("0");
    expect(moneyDigits("123456789012345", 11)).toBe("12345678901");
    expect(formatMoney("1500000")).toBe("1 500 000");
    expect(formatMoney("999")).toBe("999");
  });

  it("имя Telegram: не тот знак — сразу, длина и края — когда ушли из поля", () => {
    expect(telegramProblem("", true)).toBeUndefined();
    expect(telegramProblem("lola hall", false)).toBe(t.input.telegramChars);
    expect(telegramProblem("lola-hall", false)).toBe(t.input.telegramChars);
    expect(telegramProblem("abc", false)).toBeUndefined();
    expect(telegramProblem("abc", true)).toBe(t.input.telegramRule);
    expect(telegramProblem("lola_", true)).toBe(t.input.telegramRule);
    expect(telegramProblem("a".repeat(33), false)).toBe(t.input.telegramRule);
    expect(telegramProblem("Lola_Hall", true)).toBeUndefined();
  });

  it("готовая причина вписывается через «; » и убирается повторным нажатием", () => {
    expect(togglePreset("", "Жалоба")).toBe("Жалоба");
    expect(togglePreset("Своя причина", "Жалоба")).toBe("Своя причина; Жалоба");
    expect(togglePreset("Своя причина; Жалоба", "Жалоба")).toBe("Своя причина");
  });

  it("выбор одного: немного коротких — сегменты, длинных — пилюли, много — список", () => {
    expect(enumControl(["ООО", "ЯТТ", "Самозанятый"])).toBe("segmented");
    expect(enumControl(["Своя кухня", "Можно свой кейтеринг", "Своя кухня или свой кейтеринг"])).toBe("pill");
    expect(enumControl(["a", "b", "c", "d", "e"])).toBe("select");
  });
});

// ── в DOM ──────────────────────────────────────────────────────────────────

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(node: ReactNode) {
  act(() =>
    root.render(<UiTextsProvider texts={{ close: t.close, clear: t.clear }}>{node}</UiTextsProvider>),
  );
}

/** Поле с состоянием, как в форме: последнее значение — в value */
function Stateful<V>({
  initial,
  children,
  onValue,
}: {
  initial: V;
  children: (value: V, set: (v: V) => void) => ReactNode;
  onValue?: (value: V) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <>
      {children(value, (next) => {
        onValue?.(next);
        setValue(next);
      })}
    </>
  );
}

function type(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const input = () => container.querySelector("input") as HTMLInputElement;
const note = () => container.querySelector(".field-error, .field-hint")?.textContent;

describe("PhoneField", () => {
  it("«+998» у поля, цифровая клавиатура; вставка номера заменяет поле; родителю — цифры", () => {
    let last = "";
    render(
      <Stateful initial="" onValue={(v: string) => (last = v)}>
        {(value, set) => <PhoneField label="Телефон" value={value} onChange={set} />}
      </Stateful>,
    );
    expect(container.querySelector(".affix-pre")?.textContent).toBe("+998");
    expect(input().inputMode).toBe("numeric");
    expect(input().type).toBe("tel");
    type(input(), "90 1");
    expect(input().value).toBe("90 1");
    // Вставили номер целиком — он заменяет набранное и встаёт в маску
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.assign(paste, { clipboardData: { getData: () => "+998 (91) 222-33-44" } });
    act(() => {
      input().dispatchEvent(paste);
    });
    expect(paste.defaultPrevented).toBe(true);
    expect(input().value).toBe("91 222 33 44");
    expect(last).toBe("912223344");
  });

  it("неполный — «9 цифр после +998», когда ушли из поля; чужой код — сразу", () => {
    render(
      <Stateful initial="">
        {(value, set) => <PhoneField label="Телефон" value={value} onChange={set} />}
      </Stateful>,
    );
    type(input(), "90 11");
    expect(container.querySelector(".field-error")).toBeNull();
    act(() => {
      input().focus();
      input().blur();
    });
    expect(container.querySelector(".field-error")?.textContent).toBe(t.input.phoneShort);
    type(input(), "+7 900 000 00 00");
    expect(container.querySelector(".field-error")?.textContent).toBe(t.input.phoneForeign);
    // Номер в поле не сменился — чужой не обрезан в похожий
    expect(input().value).toBe("90 11");
    type(input(), "901112233");
    expect(container.querySelector(".field-error")).toBeNull();
  });

  it("ошибка формы важнее своей", () => {
    render(<PhoneField label="Телефон" value="" onChange={() => {}} error="С сервера" />);
    expect(note()).toBe("С сервера");
    expect(input().getAttribute("aria-invalid")).toBe("true");
  });
});

describe("TelegramField", () => {
  it("ссылка t.me и «@» снимаются сразу; «@» стоит у поля", () => {
    render(
      <Stateful initial="">
        {(value, set) => <TelegramField label="Telegram" value={value} onChange={set} />}
      </Stateful>,
    );
    expect(container.querySelector(".affix-pre")?.textContent).toBe("@");
    type(input(), "https://t.me/Lola_Hall/");
    expect(input().value).toBe("Lola_Hall");
    type(input(), "@lola");
    expect(input().value).toBe("lola");
    type(input(), "lola hall");
    expect(note()).toBe(t.input.telegramChars);
  });
});

describe("MoneyField", () => {
  it("разряды по мере набора, «сум» у поля, только цифры", () => {
    let last = "";
    render(
      <Stateful initial="150000" onValue={(v: string) => (last = v)}>
        {(value, set) => <MoneyField label="Цена" value={value} onChange={set} max={99_999_999_999} />}
      </Stateful>,
    );
    expect(input().value).toBe("150 000");
    expect(container.querySelector(".affix-post")?.textContent).toBe(t.input.sum);
    type(input(), "1 500 000 сум");
    expect(input().value).toBe("1 500 000");
    expect(last).toBe("1500000");
  });

  it("больше предела — ошибка", () => {
    render(<MoneyField label="Цена" value="1500" onChange={() => {}} max={1000} />);
    expect(note()).toBe(t.input.moneyMax("1 000"));
  });
});

describe("SlugField", () => {
  it("латиница по мере набора, края — когда ушли; «Из названия» — как сервер", () => {
    render(
      <Stateful initial="">
        {(value, set) => <SlugField label="Адрес" value={value} onChange={set} source="Тойхона «Хумо»" />}
      </Stateful>,
    );
    expect(container.querySelector(".affix-pre")?.textContent).toBe(t.input.slugPrefix);
    type(input(), "Oq Saroy ");
    expect(input().value).toBe("oq-saroy-");
    act(() => {
      input().focus();
      input().blur();
    });
    expect(input().value).toBe("oq-saroy");
    act(() => (container.querySelector("button") as HTMLButtonElement).click());
    expect(input().value).toBe("toyxona-xumo");
    // Собран из названия — кнопка больше ничего не изменит
    expect((container.querySelector("button") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("NumberField", () => {
  it("границы — подсказкой заранее, «−» и «+» за них не уводят, единица — после поля", () => {
    render(
      <Stateful initial="20">
        {(value, set) => (
          <NumberField label="Залов" value={value} onChange={set} min={1} max={20} unit="шт." />
        )}
      </Stateful>,
    );
    expect(note()).toBe(t.input.range(1, 20));
    expect(input().getAttribute("aria-valuemax")).toBe("20");
    expect(input().maxLength).toBe(2);
    const more = container.querySelector<HTMLButtonElement>(`button[aria-label="Залов: ${t.input.more}"]`);
    expect(more?.disabled).toBe(true);
    expect(container.querySelector(".num-unit")?.textContent).toBe("шт.");
  });
});

describe("ChipsField", () => {
  it("несколько вариантов — чипами с настоящими галочками; порядок — как в списке", () => {
    let last: string[] = [];
    render(
      <Stateful initial={["b"] as string[]} onValue={(v: string[]) => (last = v)}>
        {(value, set) => (
          <ChipsField
            label="Кухня"
            value={value}
            onChange={set}
            options={[
              { value: "a", label: "А" },
              { value: "b", label: "Б" },
            ]}
          />
        )}
      </Stateful>,
    );
    const boxes = [...container.querySelectorAll<HTMLInputElement>("input[type=checkbox]")];
    expect(boxes.map((b) => b.checked)).toEqual([false, true]);
    act(() => boxes[0]?.click());
    expect(last).toEqual(["a", "b"]);
    expect(container.querySelector("legend")?.textContent).toBe("Кухня");
  });
});

describe("ReasonField", () => {
  it("чипы готовых причин над полем: вписывают и снимают, отмечены нажатыми", () => {
    render(
      <Stateful initial="">
        {(value, set) => (
          <ReasonField label="Причина" value={value} onChange={set} presets={["Спам", "Оскорбления"]} />
        )}
      </Stateful>,
    );
    const chips = [...container.querySelectorAll<HTMLButtonElement>(".reason-chip")];
    expect(container.querySelector('[role="group"]')?.getAttribute("aria-label")).toBe(t.input.reasonPresets);
    act(() => chips[1]?.click());
    expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe("Оскорбления");
    expect(chips[1]?.getAttribute("aria-pressed")).toBe("true");
    act(() => chips[0]?.click());
    expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe("Оскорбления; Спам");
    // Поле подписано: подпись связана с textarea
    expect((container.querySelector("textarea") as HTMLTextAreaElement).labels?.[0]?.textContent).toBe(
      "Причина",
    );
  });
});
