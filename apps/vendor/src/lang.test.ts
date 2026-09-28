// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialLang, saveLang } from "./lang";

const prefer = (...languages: string[]) =>
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(languages);

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("язык кабинета до входа", () => {
  it("первый подходящий из языков браузера", () => {
    prefer("en-US", "ru-UZ", "uz-UZ");
    expect(initialLang()).toBe("ru");
    prefer("uz-Latn-UZ", "ru");
    expect(initialLang()).toBe("uz");
  });

  it("без подходящего — русский", () => {
    prefer("en-US", "de");
    expect(initialLang()).toBe("ru");
  });

  it("сохранённый выбор важнее браузера", () => {
    prefer("ru");
    saveLang("uz");
    expect(initialLang()).toBe("uz");
  });

  it("мусор в хранилище игнорируется", () => {
    prefer("ru");
    window.localStorage.setItem("bayramm.vendor.lang", "en");
    expect(initialLang()).toBe("ru");
  });

  it("недоступное хранилище не ломает выбор языка", () => {
    prefer("uz");
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(initialLang()).toBe("uz");
    expect(() => saveLang("ru")).not.toThrow();
  });
});
