// Разбор входа панели v0.2 без базы: настройки, поиск клиентов, фильтры журнала,
// правки карточек. Окончательно значения проверяет база — здесь то, что панель
// должна объяснить человеку до неё (422 с именем поля).

import { describe, expect, it } from "vitest";
import { ApiError } from "../errors";
import { parseFilters } from "./audit";
import { clientRef, parseClientQuery } from "./clients";
import { parseRevision } from "./revisions";
import { INT_SETTINGS, parseSettingValue, SETTING_KEYS } from "./settings";

describe("настройки", () => {
  it("числа — в границах базы (app.setting_value_ok)", () => {
    expect(parseSettingValue("sla_hours", 12)).toBe(12);
    expect(parseSettingValue("sla_hours", 0)).toBeUndefined();
    expect(parseSettingValue("sla_hours", 73)).toBeUndefined();
    expect(parseSettingValue("sla_hours", 12.5)).toBeUndefined();
    expect(parseSettingValue("sla_hours", "12")).toBeUndefined();
    // Минимум 3 фото — правило продукта, а не настройка
    expect(parseSettingValue("min_photos", 2)).toBeUndefined();
    expect(parseSettingValue("min_photos", 3)).toBe(3);
  });

  it("напоминания — до двух целых часов по возрастанию", () => {
    expect(parseSettingValue("sla_reminder_hours", [4, 8])).toEqual([4, 8]);
    expect(parseSettingValue("sla_reminder_hours", [])).toEqual([]);
    expect(parseSettingValue("sla_reminder_hours", [6])).toEqual([6]);
    expect(parseSettingValue("sla_reminder_hours", [8, 4])).toBeUndefined();
    expect(parseSettingValue("sla_reminder_hours", [4, 4])).toBeUndefined();
    expect(parseSettingValue("sla_reminder_hours", [1, 2, 3])).toBeUndefined();
    expect(parseSettingValue("sla_reminder_hours", [0])).toBeUndefined();
    expect(parseSettingValue("sla_reminder_hours", "4,8")).toBeUndefined();
  });

  it("тихие часы — { from, to } в ЧЧ:ММ и ничего лишнего", () => {
    expect(parseSettingValue("quiet_hours", { from: "22:00", to: "08:00" })).toEqual({
      from: "22:00",
      to: "08:00",
    });
    expect(parseSettingValue("quiet_hours", { from: "24:00", to: "08:00" })).toBeUndefined();
    expect(parseSettingValue("quiet_hours", { from: "22:00" })).toBeUndefined();
    expect(parseSettingValue("quiet_hours", { from: "22:00", to: "08:00", tz: "UTC" })).toBeUndefined();
    expect(parseSettingValue("quiet_hours", ["22:00", "08:00"])).toBeUndefined();
  });

  it("пауза между напоминаниями сотрудника — 5–1440 минут", () => {
    expect(parseSettingValue("ops_reminder_pause_minutes", 30)).toBe(30);
    expect(parseSettingValue("ops_reminder_pause_minutes", 5)).toBe(5);
    expect(parseSettingValue("ops_reminder_pause_minutes", 1440)).toBe(1440);
    expect(parseSettingValue("ops_reminder_pause_minutes", 4)).toBeUndefined();
    expect(parseSettingValue("ops_reminder_pause_minutes", 1441)).toBeUndefined();
    expect(parseSettingValue("ops_reminder_pause_minutes", "30")).toBeUndefined();
  });

  it("каждый изменяемый ключ разбирается; числовые — все с границами", () => {
    for (const key of Object.keys(INT_SETTINGS)) expect(SETTING_KEYS).toContain(key);
    expect(SETTING_KEYS).toHaveLength(Object.keys(INT_SETTINGS).length + 2);
  });
});

describe("поиск клиентов: только псевдоним и номер заявки", () => {
  it.each([
    ["1001", { kind: "request", no: "1001" }],
    ["№ 1001", { kind: "request", no: "1001" }],
    ["1a2b3c4d", { kind: "id", prefix: "1a2b3c4d" }],
    ["C-1A2B3C4D", { kind: "id", prefix: "1a2b3c4d" }],
    ["1a2b3c4d-0000-4000-8000-000000000001", { kind: "id", prefix: "1a2b3c4d-0000-4000-8000-000000000001" }],
  ])("%s → %j", (q, expected) => {
    expect(parseClientQuery(q)).toEqual(expected);
  });

  it.each(["Иван", "+998001234567", "@username", "1a2b", "1a2b3c4d%"])(
    "%s — не ищем (ни имени, ни телефона)",
    (q) => {
      expect(parseClientQuery(q)).toEqual({ kind: "none" });
    },
  );

  it("пусто — без фильтра", () => {
    expect(parseClientQuery("  ")).toBeNull();
  });

  it("короткая ссылка — C- и начало id", () => {
    expect(clientRef("1a2b3c4d-0000-4000-8000-000000000001")).toBe("C-1a2b3c4d");
  });
});

describe("фильтры журнала", () => {
  const parse = (params: Record<string, string>) => parseFilters((key) => params[key]);

  it("день «по» включительно: граница — начало следующего дня", () => {
    expect(parse({ from: "2026-09-01", to: "2026-09-30" })).toEqual({
      from: "2026-09-01",
      until: "2026-10-01",
    });
  });

  it("id приводится к нижнему регистру, пустые параметры не мешают", () => {
    expect(parse({ actor: "AAAAAAAA-0000-0000-0000-000000000001", type: "", action: "listing." })).toEqual({
      actor: "aaaaaaaa-0000-0000-0000-000000000001",
      action: "listing.",
    });
  });

  it("неверные фильтры — 422 со всеми именами", () => {
    try {
      parse({ actor: "x", actorKind: "robot", type: "Listing", from: "2026-02-30", action: "%" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(422);
      expect((err as ApiError).details).toEqual(["actor", "actorKind", "type", "action", "from"]);
    }
  });
});

describe("правка карточки (ревизия)", () => {
  const weekday = { kind: "weekday", name_ru: "Будни", name_uz: "Ish kunlari", price_uzs: 150000 };

  it("ключи как столбцы базы → поля карточки", () => {
    expect(
      parseRevision({
        name: "  Oqsaroy Grand ",
        price_from_uzs: 180000,
        description_ru: "Зал\r\nна 300 гостей",
        packages: [weekday],
      }),
    ).toEqual({
      fields: { name: "Oqsaroy Grand", price_from_uzs: 180000, description_ru: "Зал\nна 300 гостей" },
      packages: [
        { kind: "weekday", nameRu: "Будни", nameUz: "Ish kunlari", priceUzs: 150000, priceUnit: "per_guest" },
      ],
      valid: true,
    });
  });

  it.each([
    ["пустое название", { name: " " }],
    ["цена null", { price_from_uzs: null }],
    ["цена «по запросу»", { price_from_uzs: "по запросу" }],
    ["неизвестная единица", { price_unit: "per_hour" }],
    ["два пакета будней", { packages: [weekday, weekday] }],
    ["пакет без цены", { packages: [{ ...weekday, price_uzs: 0 }] }],
    ["пакеты не список", { packages: "weekday" }],
  ])("%s — не проходит", (_name, payload) => {
    expect(parseRevision(payload).valid).toBe(false);
  });

  it("не объект — не проходит", () => {
    expect(parseRevision([1, 2]).valid).toBe(false);
    expect(parseRevision(null).valid).toBe(false);
  });
});
