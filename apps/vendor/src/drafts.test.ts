// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { clearDrafts, DRAFT_PREFIX, saveDraft, setDraftOwner, takeDraft } from "./drafts";
import { isEditDraft } from "./ListingEdit";

const KEY = "edit.aaaaaaaa-0000-0000-0000-000000000101.basics";
const DRAFT = {
  basics: { name: "Зал", descriptionRu: "Описание", descriptionUz: "Tavsif" },
  place: { districtCode: "", addressRu: "", addressUz: "", capMin: "", capMax: "" },
  drafts: {},
  videos: [],
};

afterEach(() => {
  setDraftOwner(null);
  window.sessionStorage.clear();
});

describe("черновики при конце сессии", () => {
  it("восстанавливается один раз и только тому же пользователю кабинета", () => {
    setDraftOwner("user-a");
    saveDraft(KEY, DRAFT);
    expect(takeDraft(KEY, isEditDraft)).toEqual(DRAFT);
    expect(takeDraft(KEY, isEditDraft)).toBeNull();

    saveDraft(KEY, DRAFT);
    setDraftOwner("user-b");
    expect(takeDraft(KEY, isEditDraft)).toBeNull();
    // Чужой черновик стёрт, а не оставлен до следующего раза
    expect(window.sessionStorage.getItem(`${DRAFT_PREFIX}${KEY}`)).toBeNull();
  });

  it("до входа не пишется; непонятный вид (старая сборка, обрезанный) — не открывается", () => {
    saveDraft(KEY, DRAFT);
    expect(window.sessionStorage.length).toBe(0);
    setDraftOwner("user-a");
    for (const bad of [
      { owner: "user-a", value: { basics: { name: 1 } } },
      { owner: "user-a" },
      "oops",
      null,
    ]) {
      window.sessionStorage.setItem(
        `${DRAFT_PREFIX}${KEY}`,
        typeof bad === "string" ? bad : JSON.stringify(bad),
      );
      expect(takeDraft(KEY, isEditDraft)).toBeNull();
    }
  });

  it("выход и смена кабинета стирают все черновики", () => {
    setDraftOwner("user-a");
    saveDraft(KEY, DRAFT);
    window.sessionStorage.setItem("bayramm.vendor.calendar.legend", "closed");
    clearDrafts();
    expect(Object.keys(window.sessionStorage)).toEqual(["bayramm.vendor.calendar.legend"]);
  });
});
