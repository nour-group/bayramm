// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialLang, saveLang, takeLangParam } from "./lang";

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

describe("язык из ссылки с сайта (?lang=)", () => {
  it("важнее браузерного и сохранённого; запоминается, из адреса убирается", () => {
    prefer("ru");
    saveLang("ru");
    window.history.replaceState(null, "", "/calendar?signin=1&lang=uz#x");
    takeLangParam();
    expect(initialLang()).toBe("uz");
    expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe(
      "/calendar?signin=1#x",
    );
    expect(window.localStorage.getItem("bayramm.vendor.lang")).toBe("uz");
    // Выбрал другой язык в кабинете — он и остаётся
    saveLang("ru");
    expect(initialLang()).toBe("ru");
  });

  it("чужое значение — убирается, язык как обычно", () => {
    prefer("uz");
    window.history.replaceState(null, "", "/?lang=en");
    takeLangParam();
    expect(window.location.search).toBe("");
    expect(initialLang()).toBe("uz");
  });
});
