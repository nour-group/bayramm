import { describe, expect, it } from "vitest";
import { isDay, tashkentToday } from "./availability";
import { Input, likePattern, paging } from "./input";

function parse<T>(body: Record<string, unknown>, read: (input: Input) => T): { value: T; errors: string[] } {
  const input = new Input(body);
  const value = read(input);
  try {
    input.done();
    return { value, errors: [] };
  } catch (err) {
    return { value, errors: (err as { details: string[] }).details };
  }
}

describe("Input: три состояния поля правки", () => {
  it("нет поля — undefined (не менять), null или пустая строка — null (очистить)", () => {
    expect(parse({}, (i) => i.text("a", { max: 10 })).value).toBeUndefined();
    expect(parse({ a: null }, (i) => i.text("a", { max: 10 })).value).toBeNull();
    expect(parse({ a: "   " }, (i) => i.text("a", { max: 10 })).value).toBeNull();
    expect(parse({ a: "  x  " }, (i) => i.text("a", { max: 10 })).value).toBe("x");
  });

  it("обязательное поле: нет, null или пусто — ошибка", () => {
    for (const body of [{}, { a: null }, { a: " " }]) {
      expect(parse(body, (i) => i.text("a", { max: 10, required: true })).errors).toEqual(["a"]);
    }
  });

  it("длина — в символах, как в Postgres; управляющие символы — ошибка", () => {
    expect(parse({ a: "ʻʻʻ" }, (i) => i.text("a", { max: 3 })).errors).toEqual([]);
    expect(parse({ a: "abcd" }, (i) => i.text("a", { max: 3 })).errors).toEqual(["a"]);
    expect(parse({ a: "a\u0000b" }, (i) => i.text("a", { max: 10 })).errors).toEqual(["a"]);
    expect(parse({ a: "a\nb" }, (i) => i.text("a", { max: 10 })).errors).toEqual(["a"]);
    expect(parse({ a: "a\r\nb" }, (i) => i.text("a", { max: 10, multiline: true })).value).toBe("a\nb");
  });

  it("числа — только целые в пределах", () => {
    expect(parse({ n: 5 }, (i) => i.int("n", { min: 1, max: 10 })).value).toBe(5);
    for (const n of [0, 11, 1.5, "5", Number.NaN]) {
      expect(parse({ n }, (i) => i.int("n", { min: 1, max: 10 })).errors).toEqual(["n"]);
    }
  });

  it("телефон приводится к +998XXXXXXXXX", () => {
    expect(parse({ p: "00 123 45 67" }, (i) => i.phone("p")).value).toBe("+998001234567");
    expect(parse({ p: "" }, (i) => i.phone("p")).value).toBeNull();
    expect(parse({ p: "+7 900 000 00 00" }, (i) => i.phone("p")).errors).toEqual(["p"]);
    expect(parse({ p: 998001234567 }, (i) => i.phone("p")).errors).toEqual(["p"]);
  });

  it("список: ошибки вложенных полей — с номером элемента", () => {
    const { value, errors } = parse({ items: [{ n: 1 }, { n: "x" }, 5] }, (i) =>
      i.list("items", 5, (item) => item.int("n", { min: 1, max: 9, required: true })),
    );
    expect(value).toEqual([1]);
    expect(errors).toEqual(["items.1.n", "items.2"]);
    expect(parse({ items: [1, 2, 3] }, (i) => i.list("items", 2, () => 1)).errors).toEqual(["items"]);
  });

  it("ошибки — все сразу и без повторов", () => {
    const { errors } = parse({ a: 1, b: 2 }, (i) => {
      i.text("a", { max: 1 });
      i.text("b", { max: 1 });
      i.fail("a");
    });
    expect(errors).toEqual(["a", "b"]);
  });
});

describe("поиск и страницы", () => {
  it("спецсимволы ILIKE экранируются", () => {
    expect(likePattern("50%_off\\")).toBe("%50\\%\\_off\\\\%");
  });

  it("limit и offset — в пределах", () => {
    const q = (values: Record<string, string>) => (key: string) => values[key];
    expect(paging(q({}))).toEqual({ limit: 50, offset: 0 });
    expect(paging(q({ limit: "500", offset: "10" }))).toEqual({ limit: 100, offset: 10 });
    expect(paging(q({ limit: "-1", offset: "x" }))).toEqual({ limit: 50, offset: 0 });
  });
});

describe("дни занятости", () => {
  it("только настоящие даты YYYY-MM-DD", () => {
    expect(isDay("2027-02-28")).toBe(true);
    expect(isDay("2028-02-29")).toBe(true);
    for (const day of ["2027-02-29", "2027-13-01", "27-01-01", "2027-1-1", 20270101, null]) {
      expect(isDay(day), String(day)).toBe(false);
    }
  });

  it("«сегодня» — по Ташкенту (UTC+5)", () => {
    expect(tashkentToday(new Date("2026-09-29T18:59:59Z"))).toBe("2026-09-29");
    expect(tashkentToday(new Date("2026-09-29T19:00:00Z"))).toBe("2026-09-30");
  });
});

// Сам разбор имени — normalizeTelegram в @bayramm/shared (telegram.test.ts): один на витрину,
// вендора и приглашение в команду
describe("Telegram: витрина, вендор, приглашение", () => {
  it.each([
    ["bayramm_hall", "bayramm_hall"],
    ["@Bayramm_Hall", "Bayramm_Hall"],
    ["https://t.me/bayramm_hall/", "bayramm_hall"],
  ])("%s → %s", (raw, name) => {
    expect(parse({ telegram: raw }, (input) => input.telegram("telegram"))).toEqual({
      value: name,
      errors: [],
    });
  });

  it("в правке: пусто — убрать, мусор — ошибка поля", () => {
    const input = new Input({ telegram: "", other: "@bad name" });
    expect(input.telegram("telegram")).toBeNull();
    expect(input.telegram("other")).toBeUndefined();
    expect(() => input.done()).toThrow();
  });

  it("обязательное (приглашение): нет или пусто — ошибка поля", () => {
    expect(parse({}, (input) => input.telegram("username", true)).errors).toEqual(["username"]);
    expect(parse({ username: " " }, (input) => input.telegram("username", true)).errors).toEqual([
      "username",
    ]);
    expect(parse({ username: "t.me/ops_lead" }, (input) => input.telegram("username", true))).toEqual({
      value: "ops_lead",
      errors: [],
    });
  });
});
