// Ввод суммы в сумах: цифры, разряды по мере набора и положение курсора после переформатирования.
// Один разбор для полей панели (apps/admin/src/fields.tsx) и кабинета (apps/vendor/src/MoneyInput.tsx);
// сами поля — свои у каждого приложения, здесь только чистые функции.

/** Узкий неразрывный пробел между разрядами: сумма не переносится и не путается с двумя числами */
const THIN = " ";

/** Только цифры, без ведущих нулей и не длиннее предела */
export function moneyDigits(raw: string, maxDigits: number): string {
  return raw
    .replace(/\D+/g, "")
    .replace(/^0+(?=\d)/, "")
    .slice(0, maxDigits);
}

/** «1500000» → «1 500 000» (разряды — узким неразрывным пробелом) */
export function groupDigits(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, THIN);
}

/** Знаков в поле под сумму не длиннее maxDigits цифр: разрядов на треть больше цифр */
export function groupedLength(maxDigits: number): number {
  return maxDigits + Math.floor((maxDigits - 1) / 3);
}

/**
 * Курсор после переформатирования — после той же по счёту цифры, а не в конце поля: иначе
 * правка в середине суммы уводит курсор и следующая цифра встаёт не туда
 */
export function caretAfterDigits(display: string, digits: number): number {
  let pos = 0;
  for (let seen = 0; pos < display.length && seen < digits; pos++) if (/\d/.test(display[pos] ?? "")) seen++;
  return pos;
}
