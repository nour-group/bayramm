// @vitest-environment jsdom
import { useRef, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { ConfirmSheet, Dialog } from "./Dialog";
import { cleanup, click, labelledBy, press, render, restoreSpies, spyFocus } from "./test/harness";

afterEach(() => {
  cleanup();
  restoreSpies();
});

let log: string[] = [];

function Withdraw({
  busy = false,
  error,
  confirmDisabled,
}: {
  busy?: boolean;
  error?: string;
  confirmDisabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={opener} type="button" onClick={() => setOpen(true)}>
        Отозвать
      </button>
      <ConfirmSheet
        open={open}
        title="Отозвать заявку?"
        text="Вендор увидит, что заявка отозвана."
        confirmLabel="Отозвать"
        cancelLabel="Оставить"
        tone="danger"
        busy={busy}
        error={error}
        confirmDisabled={confirmDisabled}
        returnFocus={opener}
        onConfirm={() => {
          log.push("confirm");
          setOpen(false);
        }}
        onCancel={() => {
          log.push("cancel");
          setOpen(false);
        }}
      />
    </>
  );
}

const opener = () => document.querySelector<HTMLButtonElement>("#root > button");
const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]');
const buttons = () => [...(dialog()?.querySelectorAll<HTMLButtonElement>(".ui-dialog-actions button") ?? [])];

describe("ConfirmSheet вместо window.confirm", () => {
  it("alertdialog с именем и описанием; фокус на отмене без прокрутки; кнопки одной сетки", () => {
    log = [];
    const focus = spyFocus();
    const root = render(<Withdraw />);
    click(opener());
    const box = dialog();
    expect(box?.getAttribute("aria-modal")).toBe("true");
    expect(labelledBy(box)).toBe("Отозвать заявку?");
    expect(document.getElementById(box?.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      "Вендор увидит, что заявка отозвана.",
    );
    expect(buttons().map((b) => b.textContent)).toEqual(["Оставить", "Отозвать"]);
    expect(buttons().map((b) => b.className)).toEqual(["ui-btn ui-btn-secondary", "ui-btn ui-btn-danger"]);
    expect(document.activeElement).toBe(buttons()[0]);
    expect(focus.calls.at(-1)?.options).toEqual({ preventScroll: true });
    expect(root.hasAttribute("inert")).toBe(true);
  });

  it("подтверждение: onConfirm, диалог закрыт, фокус вернулся на кнопку", () => {
    log = [];
    const root = render(<Withdraw />);
    click(opener());
    click(buttons()[1]);
    expect(log).toEqual(["confirm"]);
    expect(dialog()).toBeNull();
    expect(root.hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(opener());
  });

  it("Esc и подложка — отмена", () => {
    log = [];
    render(<Withdraw />);
    click(opener());
    press(dialog(), "Escape");
    expect(log).toEqual(["cancel"]);
    click(opener());
    click(document.querySelector(".ui-scrim"));
    expect(log).toEqual(["cancel", "cancel"]);
    expect(document.activeElement).toBe(opener());
  });

  it("Tab ходит по кругу внутри", () => {
    render(<Withdraw />);
    click(opener());
    const [cancel, confirm] = buttons();
    confirm?.focus();
    press(confirm, "Tab");
    expect(document.activeElement).toBe(cancel);
    press(cancel, "Tab", { shiftKey: true });
    expect(document.activeElement).toBe(confirm);
  });

  it("идёт запрос — кнопки недоступны, Esc не закрывает; ошибка — role=alert", () => {
    log = [];
    render(<Withdraw busy error="Не получилось" />);
    click(opener());
    expect(buttons().every((b) => b.disabled)).toBe(true);
    press(dialog(), "Escape");
    expect(log).toEqual([]);
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe("Не получилось");
  });

  it("подтвердить пока нельзя — недоступна только кнопка подтверждения; отмена работает", () => {
    log = [];
    render(<Withdraw confirmDisabled />);
    click(opener());
    expect(buttons().map((b) => b.disabled)).toEqual([false, true]);
    click(buttons()[0]);
    expect(log).toEqual(["cancel"]);
  });
});

describe("Dialog", () => {
  it("закрыт — ничего в DOM; открыт — фокус на самом диалоге, если не задан другой", () => {
    render(
      <Dialog open={false} title="Скрыт" onClose={() => {}}>
        x
      </Dialog>,
    );
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    cleanup();
    render(
      <Dialog open title="Открыт" onClose={() => {}}>
        Текст
      </Dialog>,
    );
    const box = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(document.activeElement).toBe(box);
    expect(box?.querySelector("h2")?.textContent).toBe("Открыт");
  });
});
