// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { clearDrafts } from "./request-draft";
import {
  lastRequest,
  markSendAfterSignIn,
  rememberLastRequest,
  takeSendAfterSignIn,
} from "./request-prefill";

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
});

describe("подстановка в следующую заявку", () => {
  it("имя, телефон (9 цифр) и повод последней заявки — во вкладке, не между визитами", () => {
    expect(lastRequest()).toBeNull();
    rememberLastRequest({ name: " Азиза ", phone: "+998 90 123 45 67", occasion: "wedding" });
    expect(lastRequest()).toEqual({
      name: "Азиза",
      phone: "901234567",
      occasion: "wedding",
      date: null,
      guests: null,
    });
    expect(window.localStorage.length).toBe(0);
  });

  it("день и гости — для следующей заявки без них в адресе; кривые не запоминаются", () => {
    rememberLastRequest({ name: "А", phone: "", occasion: null, date: "2026-10-20", guests: 250 });
    expect(lastRequest()).toMatchObject({ date: "2026-10-20", guests: 250 });
    rememberLastRequest({ name: "А", phone: "", occasion: null, date: "20.10", guests: 0 });
    expect(lastRequest()).toMatchObject({ date: null, guests: null });
  });

  it("запись прежней вкладки (без дня и гостей) читается", () => {
    window.sessionStorage.setItem(
      "bayramm.web.draft._last",
      JSON.stringify({ name: "А", phone: "901234567", occasion: null }),
    );
    expect(lastRequest()).toEqual({ name: "А", phone: "901234567", occasion: null });
  });

  it("кривой номер не запоминается; удаление аккаунта стирает и контакты", () => {
    rememberLastRequest({ name: "А", phone: "12", occasion: null });
    expect(lastRequest()?.phone).toBe("");
    clearDrafts();
    expect(lastRequest()).toBeNull();
  });

  it("метка «отправить после входа» — у своей витрины и одноразовая", () => {
    markSendAfterSignIn("lola-zali", "Lola zali");
    expect(takeSendAfterSignIn("anor-zali")).toBe(false);
    expect(takeSendAfterSignIn("lola-zali")).toBe(true);
    expect(takeSendAfterSignIn("lola-zali")).toBe(false);
  });
});
