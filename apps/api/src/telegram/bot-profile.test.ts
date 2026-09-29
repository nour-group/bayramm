import { hasNonCanonicalApostrophe, LANGS, normalizeUz } from "@bayramm/shared";
import { describe, expect, it } from "vitest";
import { BOT_TEXTS, botProfile, DEFAULT_LANG, MENU_BUTTON_TEXT } from "./bot-profile";

const WEB_APP_URL = "https://app.example";
const steps = botProfile({ webAppUrl: WEB_APP_URL });

const allTexts = (lang: "ru" | "uz") => Object.values(BOT_TEXTS[lang]);

describe("профиль бота: вызовы", () => {
  it("команды, описания и короткие описания — по умолчанию, ru, uz; потом кнопка меню", () => {
    expect(steps.map((step) => `${step.method}:${step.language}`)).toEqual([
      "setMyCommands:default",
      "setMyCommands:ru",
      "setMyCommands:uz",
      "setMyDescription:default",
      "setMyDescription:ru",
      "setMyDescription:uz",
      "setMyShortDescription:default",
      "setMyShortDescription:ru",
      "setMyShortDescription:uz",
      "setChatMenuButton:default",
    ]);
  });

  it("language_code только у языковых значений; по умолчанию — тексты на русском", () => {
    for (const step of steps) {
      const params = step.params as { language_code?: string };
      if (step.language === "default") expect(params).not.toHaveProperty("language_code");
      else expect(params.language_code).toBe(step.language);
    }
    expect(DEFAULT_LANG).toBe("ru");
    expect(steps[0]?.params).toEqual({
      commands: [{ command: "start", description: BOT_TEXTS.ru.startCommand }],
    });
    expect(steps[3]?.params).toEqual({ description: BOT_TEXTS.ru.description });
    expect(steps[6]?.params).toEqual({ short_description: BOT_TEXTS.ru.shortDescription });
  });

  it("кнопка меню открывает Mini App по WEB_APP_URL, подпись «Открыть»", () => {
    expect(steps.at(-1)).toEqual({
      language: "default",
      method: "setChatMenuButton",
      params: { menu_button: { type: "web_app", text: "Открыть", web_app: { url: WEB_APP_URL } } },
    });
    expect(MENU_BUTTON_TEXT).toBe("Открыть");
  });

  it("вебхук пока не ставится: его обработчика ещё нет", () => {
    expect(steps.map((step) => step.method)).not.toContain("setWebhook");
  });
});

describe("профиль бота: тексты", () => {
  it("ограничения Telegram на длину и формат команды", () => {
    for (const lang of LANGS) {
      const texts = BOT_TEXTS[lang];
      expect(texts.startCommand.length, lang).toBeGreaterThan(0);
      expect(texts.startCommand.length, lang).toBeLessThanOrEqual(256);
      expect(texts.description.length, lang).toBeLessThanOrEqual(512);
      expect(texts.shortDescription.length, lang).toBeLessThanOrEqual(120);
    }
    for (const step of steps)
      if (step.method === "setMyCommands")
        for (const { command } of step.params.commands) expect(command).toMatch(/^[a-z0-9_]{1,32}$/);
    expect(MENU_BUTTON_TEXT.length).toBeLessThanOrEqual(64);
  });

  // Те же правила, что у словарей @bayramm/shared (i18n.test.ts)
  it("заявка, не бронь: запрещённых слов нет", () => {
    const hits = [
      ...allTexts("ru").filter((text) => /брон|продвижен/i.test(text)),
      ...[MENU_BUTTON_TEXT].filter((text) => /брон/i.test(text)),
      ...allTexts("uz").filter((text) => /bron|band\s+qil/i.test(text)),
    ];
    expect(hits).toEqual([]);
  });

  it("клиент не платит — это сказано на обоих языках", () => {
    expect(BOT_TEXTS.ru.description).toMatch(/бесплатно/);
    expect(BOT_TEXTS.uz.description).toMatch(/bepul/);
  });

  it("узбекский: латиница, апострофы только U+02BB и U+02BC, текст уже нормализован", () => {
    for (const text of allTexts("uz")) {
      expect(text).not.toMatch(/[Ѐ-ӿ]/);
      expect(hasNonCanonicalApostrophe(text), text).toBe(false);
      expect(normalizeUz(text)).toBe(text);
    }
    expect(allTexts("uz").join(" ")).toContain("oʻ");
  });

  it("без HTML: Bot API показывает описания как обычный текст", () => {
    for (const lang of LANGS)
      for (const text of allTexts(lang)) expect(text).not.toMatch(/<\/?[a-z][^>]*>|&[a-z#][a-z0-9]*;/i);
  });
});
