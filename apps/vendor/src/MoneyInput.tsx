/* Цена в сумах: только цифры, разряды по мере набора (узкий неразрывный пробел), «сум» у поля.
   Разбор и положение курсора — общие с панелью (@bayramm/shared: moneyDigits, groupDigits,
   caretAfterDigits); поле — своё, на стилях кабинета. В родителя уходит строка цифр без
   разрядов: serviceInput / serviceErrors разбирают её так же, как раньше. */

import { caretAfterDigits, groupDigits, groupedLength, moneyDigits } from "@bayramm/shared";
import { type RefObject, useLayoutEffect, useRef } from "react";
import type { VendorDict } from "./i18n";

/**
 * Курсор после переформатирования — после той же по счёту цифры, а не в конце поля: иначе
 * правка в середине суммы уводит курсор и следующая цифра встаёт не туда
 */
function useDigitCaret(input: RefObject<HTMLInputElement | null>, display: string) {
  const want = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = input.current;
    const digits = want.current;
    want.current = null;
    if (!el || digits === null || el.ownerDocument.activeElement !== el) return;
    const pos = caretAfterDigits(display, digits);
    try {
      el.setSelectionRange(pos, pos);
    } catch {
      // Старый движок без выделения в этом поле: курсор останется в конце
    }
  });
  return (el: HTMLInputElement) => {
    const at = el.selectionStart ?? el.value.length;
    want.current = el.value.slice(0, at).replace(/\D+/g, "").length;
  };
}

interface MoneyInputProps {
  readonly id: string;
  /** Цифры (разряды и «сум» допустимы — поле их уберёт) */
  readonly value: string;
  /** Только цифры: «1500000» */
  readonly onChange: (digits: string) => void;
  /** Больше этого поле не принимает: по числу цифр */
  readonly max: number;
  readonly t: VendorDict;
  readonly "aria-invalid"?: boolean | undefined;
  readonly "aria-describedby"?: string | undefined;
}

export function MoneyInput({
  id,
  value,
  onChange,
  max,
  t,
  "aria-invalid": invalid,
  "aria-describedby": describedBy,
}: MoneyInputProps) {
  const input = useRef<HTMLInputElement>(null);
  const maxDigits = String(max).length;
  const display = groupDigits(moneyDigits(value, maxDigits));
  const keepCaret = useDigitCaret(input, display);
  return (
    <span className="money">
      <input
        ref={input}
        id={id}
        className="field money-input"
        inputMode="numeric"
        autoComplete="off"
        enterKeyHint="done"
        maxLength={groupedLength(maxDigits)}
        value={display}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        onChange={(event) => {
          keepCaret(event.target);
          onChange(moneyDigits(event.target.value, maxDigits));
        }}
      />
      <span className="money-post">{t.sumSuffix}</span>
    </span>
  );
}
