// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { Checkbox, RadioGroup, type RadioOption, Switch } from "./choices";
import { cleanup, click, render } from "./test/harness";

afterEach(cleanup);

function Consent({ onChange }: { onChange?: (checked: boolean) => void }) {
  const [checked, setChecked] = useState(false);
  return (
    <Checkbox
      id="consent"
      checked={checked}
      aria-invalid
      aria-describedby="consent-error"
      onChange={(next) => {
        setChecked(next);
        onChange?.(next);
      }}
    >
      Разрешаю передать заявку
    </Checkbox>
  );
}

describe("Checkbox", () => {
  it("настоящая галочка под рисунком: не отмечена, связана с подписью и ошибкой", () => {
    render(<Consent />);
    const input = document.getElementById("consent") as HTMLInputElement;
    expect(input.type).toBe("checkbox");
    expect(input.checked).toBe(false);
    expect(input.defaultChecked).toBe(false);
    expect(input.closest("label")?.textContent).toBe("Разрешаю передать заявку");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe("consent-error");
    // Рисунок — для глаз, диктору он не нужен
    expect(input.nextElementSibling?.getAttribute("aria-hidden")).toBe("true");
  });

  it("нажатие на подпись переключает", () => {
    const seen: boolean[] = [];
    render(<Consent onChange={(checked) => seen.push(checked)} />);
    const label = document.querySelector("label");
    click(label);
    expect((document.getElementById("consent") as HTMLInputElement).checked).toBe(true);
    click(label);
    expect(seen).toEqual([true, false]);
  });

  it("недоступная не переключается", () => {
    const seen: boolean[] = [];
    render(
      <Checkbox checked={false} disabled onChange={(checked) => seen.push(checked)}>
        Нельзя
      </Checkbox>,
    );
    click(document.querySelector("input"));
    expect(seen).toEqual([]);
    expect(document.querySelector("label")?.classList.contains("is-disabled")).toBe(true);
  });
});

describe("Switch", () => {
  it("галочка с role=switch", () => {
    const seen: boolean[] = [];
    render(
      <Switch checked={false} onChange={(checked) => seen.push(checked)}>
        Уведомления
      </Switch>,
    );
    const input = document.querySelector("input");
    expect(input?.getAttribute("role")).toBe("switch");
    click(input);
    expect(seen).toEqual([true]);
  });
});

type Occasion = "toy" | "sunnat" | "birthday";
const OCCASIONS: readonly RadioOption<Occasion>[] = [
  { value: "toy", label: "Свадьба" },
  { value: "sunnat", label: "Суннат" },
  { value: "birthday", label: "День рождения", disabled: true },
];

function Occasions({ label }: { label?: string }) {
  const [value, setValue] = useState<Occasion | null>(null);
  return (
    <RadioGroup
      id="occasion"
      label={label}
      value={value}
      options={OCCASIONS}
      onChange={setValue}
      aria-invalid
      aria-describedby="occasion-error"
    />
  );
}

describe("RadioGroup", () => {
  it("настоящие радиокнопки с общим name; выбор — нажатием на пилюлю", () => {
    render(<Occasions />);
    const radios = [...document.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios).toHaveLength(3);
    expect(new Set(radios.map((r) => r.name)).size).toBe(1);
    expect(radios.every((r) => !r.checked)).toBe(true);
    expect(radios[0]?.id).toBe("occasion");
    click(radios[1]?.closest("label"));
    expect(radios[1]?.checked).toBe(true);
    expect(radios[1]?.closest("label")?.classList.contains("is-on")).toBe(true);
    expect(radios[2]?.disabled).toBe(true);
  });

  it("внутри fieldset — без своей роли, ошибка на каждой радиокнопке", () => {
    render(<Occasions />);
    const group = document.querySelector(".ui-radios");
    expect(group?.hasAttribute("role")).toBe(false);
    const radio = document.querySelector('input[type="radio"]');
    expect(radio?.getAttribute("aria-invalid")).toBe("true");
    expect(radio?.getAttribute("aria-describedby")).toBe("occasion-error");
  });

  it("с подписью — role=radiogroup с именем, ошибка на группе", () => {
    render(<Occasions label="Повод" />);
    const group = document.querySelector('[role="radiogroup"]');
    expect(group?.getAttribute("aria-label")).toBe("Повод");
    expect(group?.getAttribute("aria-invalid")).toBe("true");
    expect(group?.getAttribute("aria-describedby")).toBe("occasion-error");
    expect(document.querySelector('input[type="radio"]')?.hasAttribute("aria-invalid")).toBe(false);
  });

  it("строки — с кружком, сегменты — без", () => {
    render(<RadioGroup variant="row" value="toy" options={OCCASIONS} onChange={() => {}} />);
    expect(document.querySelectorAll(".ui-radio-dot")).toHaveLength(3);
    cleanup();
    render(<RadioGroup variant="segmented" value="toy" options={OCCASIONS} onChange={() => {}} />);
    expect(document.querySelectorAll(".ui-radio-dot")).toHaveLength(0);
    expect(document.querySelector(".ui-radios-segmented .is-on")?.textContent).toBe("Свадьба");
  });
});
