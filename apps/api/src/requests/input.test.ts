// Тело заявки — без базы: что отсекается до транзакции
import { describe, expect, it } from "vitest";
import { ApiError } from "../errors";
import { parseCreateRequest } from "./input";

const TODAY = "2026-09-29";
const LISTING = "AAAAAAAA-0000-4000-8000-000000000101";
const TRANSFER = "dddddddd-0000-4000-8000-000000000001";
const NOTIFY = "dddddddd-0000-4000-8000-000000000002";

const valid = {
  listingId: LISTING,
  occasionCode: "toy",
  eventDate: "2026-10-03",
  guests: 200,
  contactName: "Азиз",
  contactPhone: "+998000000123",
  requestTransferConsentId: TRANSFER,
};

function rejection(body: unknown): ApiError {
  try {
    parseCreateRequest(body, TODAY);
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error("ожидался отказ");
}

describe("parseCreateRequest", () => {
  it("минимальное тело: необязательное — null, id в нижнем регистре", () => {
    expect(parseCreateRequest(valid, TODAY)).toEqual({
      listingId: LISTING.toLowerCase(),
      occasionCode: "toy",
      eventDate: "2026-10-03",
      guests: 200,
      budgetMinUzs: null,
      budgetMaxUzs: null,
      contactName: "Азиз",
      contactPhone: "+998000000123",
      comment: null,
      requestTransferConsentId: TRANSFER,
      notifyConsentId: null,
    });
  });

  it("полное тело: телефон без пробелов и скобок, текст обрезан по краям", () => {
    const input = parseCreateRequest(
      {
        ...valid,
        budgetMinUzs: 0,
        budgetMaxUzs: 50_000_000,
        contactName: "  Азиз Тестов ",
        contactPhone: " +998 (00) 000-01-23 ",
        comment: "  Вечер,\nживая музыка\t ",
        notifyConsentId: NOTIFY,
      },
      TODAY,
    );
    expect(input).toMatchObject({
      budgetMinUzs: 0,
      budgetMaxUzs: 50_000_000,
      contactName: "Азиз Тестов",
      contactPhone: "+998000000123",
      comment: "Вечер,\nживая музыка",
      notifyConsentId: NOTIFY,
    });
  });

  it("пустой комментарий — null; null в необязательных — как отсутствие", () => {
    expect(
      parseCreateRequest({ ...valid, comment: "   ", budgetMinUzs: null, notifyConsentId: null }, TODAY),
    ).toMatchObject({ comment: null, budgetMinUzs: null, notifyConsentId: null });
  });

  it("тело не объект — 400", () => {
    for (const body of [null, [], "text", 42]) {
      expect(rejection(body)).toMatchObject({ status: 400, code: "invalid_request" });
    }
  });

  it.each<[string, Record<string, unknown>, string[]]>([
    ["listingId не uuid", { listingId: "42" }, ["listingId"]],
    ["повод не код", { occasionCode: "Свадьба" }, ["occasionCode"]],
    ["дата сегодня (по Ташкенту)", { eventDate: TODAY }, ["eventDate"]],
    ["дата в прошлом", { eventDate: "2026-09-01" }, ["eventDate"]],
    ["дата дальше двух лет", { eventDate: "2028-09-29" }, ["eventDate"]],
    ["несуществующий день", { eventDate: "2026-11-31" }, ["eventDate"]],
    ["гостей 0", { guests: 0 }, ["guests"]],
    ["гостей больше 5000", { guests: 5001 }, ["guests"]],
    ["гостей дробное", { guests: 10.5 }, ["guests"]],
    ["гостей строкой", { guests: "200" }, ["guests"]],
    ["бюджет отрицательный", { budgetMinUzs: -1 }, ["budgetMinUzs"]],
    ["верх бюджета 0", { budgetMaxUzs: 0 }, ["budgetMaxUzs"]],
    ["верх бюджета меньше низа", { budgetMinUzs: 20, budgetMaxUzs: 10 }, ["budgetMaxUzs"]],
    ["бюджет строкой", { budgetMinUzs: "1000" }, ["budgetMinUzs"]],
    ["пустое имя", { contactName: "   " }, ["contactName"]],
    ["имя длиннее 80 символов", { contactName: "Я".repeat(81) }, ["contactName"]],
    ["управляющий символ в имени", { contactName: "Aziz\u0000" }, ["contactName"]],
    ["телефон не узбекский", { contactPhone: "+70000000123" }, ["contactPhone"]],
    ["телефон короче", { contactPhone: "+99800000012" }, ["contactPhone"]],
    ["телефон без плюса", { contactPhone: "998000000123" }, ["contactPhone"]],
    ["комментарий длиннее 1000", { comment: "x".repeat(1001) }, ["comment"]],
    ["комментарий с NUL", { comment: "a\u0000b" }, ["comment"]],
    ["комментарий не строка", { comment: 5 }, ["comment"]],
    ["согласие не uuid", { requestTransferConsentId: "yes" }, ["requestTransferConsentId"]],
    ["уведомления не uuid", { notifyConsentId: true }, ["notifyConsentId"]],
    ["несколько полей", { guests: -1, contactPhone: "" }, ["guests", "contactPhone"]],
  ])("%s — 400 с именем поля", (_, patch, details) => {
    const err = rejection({ ...valid, ...patch });
    expect(err).toMatchObject({ status: 400, code: "invalid_request", details });
  });

  it("5000 гостей и 80 символов имени (эмодзи — один символ) — можно", () => {
    expect(parseCreateRequest({ ...valid, guests: 5000, contactName: "😀".repeat(80) }, TODAY).guests).toBe(
      5000,
    );
  });

  it("без согласия на передачу контактов — 422 consent_required", () => {
    for (const requestTransferConsentId of [undefined, null]) {
      expect(rejection({ ...valid, requestTransferConsentId })).toMatchObject({
        status: 422,
        code: "consent_required",
        details: ["requestTransferConsentId"],
      });
    }
  });

  it("неверные поля важнее отсутствующего согласия", () => {
    expect(rejection({ ...valid, guests: 0, requestTransferConsentId: undefined })).toMatchObject({
      status: 400,
      details: ["guests"],
    });
  });
});
