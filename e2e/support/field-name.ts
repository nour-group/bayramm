import type { Locator, Page } from "@playwright/test";

/* Поле по подписи. У подписи бывает пометка («обязательно», «по желанию»): имя поля — подпись
   целиком или подпись с одной из пометок. Точные строки, а не регулярное выражение из текста. */

const names = (label: string, marks: readonly string[]) => [
  label,
  ...marks.map((mark) => `${label} ${mark}`),
];

/** Поле с подписью label (getByLabel) */
export function labelled(scope: Page | Locator, label: string, marks: readonly string[]): Locator {
  const [first, ...rest] = names(label, marks).map((name) => scope.getByLabel(name, { exact: true }));
  return rest.reduce((all, one) => all.or(one), first as Locator);
}

/** Числовое поле с подписью label (getByRole spinbutton) */
export function spinbutton(scope: Page | Locator, label: string, marks: readonly string[]): Locator {
  const [first, ...rest] = names(label, marks).map((name) =>
    scope.getByRole("spinbutton", { name, exact: true }),
  );
  return rest.reduce((all, one) => all.or(one), first as Locator);
}
