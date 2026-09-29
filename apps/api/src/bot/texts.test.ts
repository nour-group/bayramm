import { hasNonCanonicalApostrophe, LANGS, normalizeUz } from "@bayramm/shared";
import { describe, expect, it } from "vitest";
import { BOT_TEXTS, botLang, STAFF_STARTED } from "./texts";

const all = (lang: "ru" | "uz") => Object.values(BOT_TEXTS[lang]);

describe("тексты бота", () => {
  it("одинаковый набор ключей на двух языках, ни одного пустого", () => {
    expect(Object.keys(BOT_TEXTS.uz).sort()).toEqual(Object.keys(BOT_TEXTS.ru).sort());
    for (const lang of LANGS)
      for (const text of all(lang)) expect(text.trim().length, lang).toBeGreaterThan(0);
  });

  it("правила продукта: заявка, не бронь", () => {
    for (const text of [...all("ru"), ...all("uz"), STAFF_STARTED]) {
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
    }
  });

  it("язык: ru — русский, остальные — узбекский", () => {
    expect(botLang("ru")).toBe("ru");
    expect(botLang("RU-ru")).toBe("ru");
    for (const code of ["uz", "en", "kk", "", undefined]) expect(botLang(code)).toBe("uz");
  });
});
