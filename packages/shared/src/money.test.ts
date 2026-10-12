import { describe, expect, it } from "vitest";
import { caretAfterDigits, groupDigits, groupedLength, moneyDigits } from "./money";

describe("ввод суммы", () => {
  it("moneyDigits: только цифры, без ведущих нулей, не длиннее предела", () => {
    expect(moneyDigits("1 500 000 сум", 11)).toBe("1500000");
    expect(moneyDigits("007", 11)).toBe("7");
    expect(moneyDigits("0", 11)).toBe("0");
    expect(moneyDigits("123456789012345", 11)).toBe("12345678901");
    expect(moneyDigits("", 11)).toBe("");
  });

  it("groupDigits: разряды узким неразрывным пробелом", () => {
    expect(groupDigits("1500000")).toBe("1 500 000");
    expect(groupDigits("999")).toBe("999");
    expect(groupDigits("")).toBe("");
  });

  it("groupedLength: цифры и разряды между ними", () => {
    expect(groupedLength(11)).toBe(14);
    expect(groupedLength(3)).toBe(3);
    expect(groupedLength(4)).toBe(5);
  });

  it("caretAfterDigits: после той же по счёту цифры", () => {
    expect(caretAfterDigits("1 500 000", 0)).toBe(0);
    expect(caretAfterDigits("1 500 000", 1)).toBe(1);
    expect(caretAfterDigits("1 500 000", 2)).toBe(3);
    expect(caretAfterDigits("1 500 000", 7)).toBe(9);
    expect(caretAfterDigits("150", 9)).toBe(3);
  });
});
