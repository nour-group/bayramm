// Подписи к id в журналах: что и как собирается пачкой, без базы. Запросы к базе — в
// интеграционных тестах панели (журнал, уведомления).

import { describe, expect, it } from "vitest";
import type { Tx } from "../db/actor";
import { groupRefs, Labels, loadLabels, requestLabel } from "./labels";

const A = "1a2b3c4d-0000-4000-8000-000000000001";
const B = "5e6f7a8b-0000-4000-8000-000000000002";

describe("что подписывать", () => {
  it("по одному набору id на вид, без повторов и в нижнем регистре", () => {
    const grouped = groupRefs([
      { type: "listing", id: A },
      { type: "listing", id: A.toUpperCase() },
      { type: "listing", id: B },
      { type: "client", id: A },
    ]);
    expect(grouped.get("listing")).toEqual([A, B]);
    expect(grouped.get("client")).toEqual([A]);
    expect(grouped.size).toBe(2);
  });

  it("контакты заявки, вендора и витрины — те же заявка, вендор и витрина", () => {
    const grouped = groupRefs([
      { type: "request_contact", id: A },
      { type: "request", id: B },
      { type: "vendor_contact", id: A },
      { type: "listing_contact", id: A },
    ]);
    expect(grouped.get("request")).toEqual([A, B]);
    expect(grouped.get("vendor")).toEqual([A]);
    expect(grouped.get("listing")).toEqual([A]);
  });

  it("чужие виды, не UUID и пустые id в запрос не попадают", () => {
    const grouped = groupRefs([
      { type: "setting", id: "sla_hours" },
      { type: "outbox", id: A },
      { type: "constructor", id: A },
      { type: "listing", id: "не-uuid" },
      { type: "listing", id: null },
      { type: "system", id: null },
    ]);
    expect(grouped.size).toBe(0);
  });
});

describe("подписи", () => {
  it("номер заявки — «№» и число", () => {
    expect(requestLabel(1051)).toBe("№1051");
  });

  it("код клиента — из id, запроса к базе нет; чужие виды и неизвестные id — без подписи", async () => {
    // Транзакция-пустышка упала бы на первом же запросе
    const labels = await loadLabels({} as Tx, [
      { type: "client", id: A },
      { type: "client_unknown", id: A },
      { type: "setting", id: "sla_hours" },
    ]);
    expect(labels.get("client", A)).toBe("C-1a2b3c4d");
    expect(labels.get("client", A.toUpperCase())).toBe("C-1a2b3c4d");
    expect(labels.get("client", B)).toBeNull();
    expect(labels.get("client_unknown", A)).toBeNull();
    expect(labels.get("setting", "sla_hours")).toBeNull();
    expect(labels.get("client", null)).toBeNull();
  });

  it("подпись контакта — подпись его заявки", () => {
    const labels = new Labels(new Map([[`request:${A}`, requestLabel(7)]]));
    expect(labels.get("request_contact", A)).toBe("№7");
    expect(labels.get("request", A)).toBe("№7");
    expect(labels.get("request", B)).toBeNull();
  });
});
