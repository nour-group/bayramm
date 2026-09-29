import { hasNonCanonicalApostrophe, LANGS, normalizeUz } from "@bayramm/shared";
import { describe, expect, it } from "vitest";
import { BOT_TEXTS, type BotStats, botLang, STAFF_TEXTS } from "./texts";

const STATS: BotStats = {
  activeListings: 1,
  reviewListings: 2,
  vendors: 3,
  requestsToday: 4,
  awaiting: 5,
  breached: 6,
  deadNotifications: 7,
};

// Тексты клиента, вендора и команды — всё, что бот может написать
const all = (lang: "ru" | "uz") => {
  const s = STAFF_TEXTS[lang];
  return [
    ...Object.values(BOT_TEXTS[lang]),
    s.staffCard("admin"),
    s.staffCard("manager"),
    s.staffCard("moderator"),
    s.adminButton,
    s.adminHint,
    s.stats(STATS),
    s.partnerStaffHint,
  ];
};

describe("тексты бота", () => {
  it("одинаковый набор ключей на двух языках, ни одного пустого", () => {
    expect(Object.keys(BOT_TEXTS.uz).sort()).toEqual(Object.keys(BOT_TEXTS.ru).sort());
    for (const lang of LANGS)
      for (const text of all(lang)) expect(text.trim().length, lang).toBeGreaterThan(0);
  });

  it("правила продукта: заявка, не бронь", () => {
    for (const text of [...all("ru"), ...all("uz")]) {
      expect(text).not.toMatch(/брон|bron/i);
    }
  });

  it("узбекский: только ʻ и ʼ, в нормальной форме", () => {
    for (const text of all("uz")) {
      expect(hasNonCanonicalApostrophe(text), text).toBe(false);
      expect(normalizeUz(text)).toBe(text);
    }
  });

  it("кнопки — в пределах Telegram (до 64 символов подписи — с запасом)", () => {
    for (const lang of LANGS) {
      const t = BOT_TEXTS[lang];
      for (const label of [t.openApp, t.openCabinet, t.partnerButton])
        expect(label.length).toBeLessThanOrEqual(64);
      // Кнопка клавиатуры упомянута в тексте просьбы так же, как подписана
      expect(t.partnerPrompt).toContain(`«${t.partnerButton}»`);
      expect(t.notOwnContact).toContain(`«${t.partnerButton}»`);
      expect(STAFF_TEXTS[lang].adminButton.length).toBeLessThanOrEqual(64);
      expect(STAFF_TEXTS[lang].partnerStaffHint).toContain(`«${t.partnerButton}»`);
    }
  });

  it("сводка — все счётчики, роль — словом", () => {
    for (const lang of LANGS) {
      const text = STAFF_TEXTS[lang].stats(STATS);
      for (const n of [1, 2, 3, 4, 5, 6, 7]) expect(text).toMatch(new RegExp(`: ${n}(\\n|$)`));
      expect(STAFF_TEXTS[lang].staffCard("admin")).not.toContain("admin\n");
    }
  });

  it("язык: ru — русский, остальные — узбекский", () => {
    expect(botLang("ru")).toBe("ru");
    expect(botLang("RU-ru")).toBe("ru");
    for (const code of ["uz", "en", "kk", "", undefined]) expect(botLang(code)).toBe("uz");
  });
});
