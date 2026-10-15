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
    expect(lastRequest()).toEqual({ name: "Азиза", phone: "901234567", occasion: "wedding" });
    expect(window.localStorage.length).toBe(0);
  });

  it("кривой номер не запоминается; удаление аккаунта стирает и контакты", () => {
    rememberLastRequest({ name: "А", phone: "12", occasion: null });
    expect(lastRequest()?.phone).toBe("");
    clearDrafts();
    expect(lastRequest()).toBeNull();
  });

  it("метка «отправить после входа» — у своей витрины и одноразовая", () => {
    markSendAfterSignIn("lola-zali");
    expect(takeSendAfterSignIn("anor-zali")).toBe(false);
    expect(takeSendAfterSignIn("lola-zali")).toBe(true);
    expect(takeSendAfterSignIn("lola-zali")).toBe(false);
  });
});
