import { hasNonCanonicalApostrophe, normalizeUz } from "@bayramm/shared";
import { describe, expect, it } from "vitest";
import { botPartnerLink, cabinetSignInLink, type VendorInviteFacts, vendorInviteText } from "./vendor-invite";

const FACTS: VendorInviteFacts = {
  name: "Dilshod",
  vendor: "Lola",
  role: "member",
  bot: "bayramm_bot",
  cabinetUrl: "https://vendor.example/",
  phoneLogin: true,
};

const variants = (lang: "ru" | "uz") =>
  [
    FACTS,
    { ...FACTS, role: "owner" as const, name: null },
    { ...FACTS, phoneLogin: false },
    { ...FACTS, bot: null },
  ].map((facts) => vendorInviteText(lang, facts));

describe("текст приглашения в кабинет", () => {
  it("ссылки: бот сразу с «Я партнёр», кабинет — сразу вход через хаб и язык", () => {
    expect(botPartnerLink("bayramm_bot")).toBe("https://t.me/bayramm_bot?start=partner");
    expect(cabinetSignInLink("https://vendor.example/", "uz")).toBe(
      "https://vendor.example/?signin=1&lang=uz",
    );
    const ru = vendorInviteText("ru", FACTS);
    expect(ru).toContain("Здравствуйте, Dilshod!");
    expect(ru).toContain("«Lola»");
    expect(ru).toContain("сотрудник площадки");
    expect(ru).toContain("https://t.me/bayramm_bot?start=partner");
    expect(ru).toContain("«Я партнёр»");
    expect(ru).toContain("кодом на этот номер: https://vendor.example/?signin=1&lang=ru");
  });

  it("владельцу — что он меняет; без имени — без обращения; без бота — только сайт", () => {
    const owner = vendorInviteText("ru", { ...FACTS, role: "owner", name: null });
    expect(owner.startsWith("Здравствуйте!")).toBe(true);
    expect(owner).toContain("витрина, фото и услуги");
    const noBot = vendorInviteText("uz", { ...FACTS, bot: null });
    expect(noBot).not.toContain("t.me");
    expect(noBot).toContain("https://vendor.example/?signin=1&lang=uz");
    // Входа по коду нет — сайт откроется после бота, кодом войти не предлагаем
    expect(vendorInviteText("ru", { ...FACTS, phoneLogin: false })).not.toContain("кодом");
  });

  it("узбекский: «Men hamkorman», только ʻ и ʼ, в нормальной форме", () => {
    expect(vendorInviteText("uz", FACTS)).toContain("«Men hamkorman»");
    for (const text of variants("uz")) {
      expect(hasNonCanonicalApostrophe(text), text).toBe(false);
      expect(normalizeUz(text)).toBe(text);
    }
  });

  it("правила продукта: заявка, а не бронь; номера в тексте нет", () => {
    for (const text of [...variants("ru"), ...variants("uz")]) {
      expect(text).not.toMatch(/брон|bron/i);
      expect(text).not.toMatch(/\+?998\d{9}/);
      expect(text).not.toMatch(/undefined|null/);
    }
  });
});
