import type { Page } from "@playwright/test";

/* Поддельный Telegram Mini App: window.Telegram.WebApp до первого скрипта страницы.
   Настоящий SDK в тестах не грузится (support/offline.ts), поэтому подделку никто не
   перезапишет. Как и SDK, она кладёт безопасные зоны в CSS-переменные --tg-*.
   Вызовы методов пишутся в window.__tg.calls; главную кнопку и «назад» можно нажать
   из теста (clickMain / clickBack). initData — не подпись, а метка: в демо-режиме
   клиента и за перехваченным /api её никто не проверяет. */

export interface Insets {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

export interface FakeTelegramOptions {
  /** start_param из ссылки t.me/<бот>?startapp=… */
  readonly startParam?: string;
  readonly version?: string;
  readonly languageCode?: string;
  /** Вырез и жест-бар устройства */
  readonly safeArea?: Partial<Insets>;
  /** Кнопки клиента Telegram поверх приложения */
  readonly contentSafeArea?: Partial<Insets>;
}

export interface TelegramCall {
  readonly name: string;
  readonly args: readonly unknown[];
}

export interface TelegramState {
  readonly calls: readonly TelegramCall[];
  readonly main: { readonly text: string; readonly visible: boolean };
  readonly back: { readonly visible: boolean };
}

export const E2E_USER = { id: 700_000_001, first_name: "Азиза", last_name: "Тест" } as const;

export async function fakeTelegram(page: Page, options: FakeTelegramOptions = {}): Promise<void> {
  await page.addInitScript(
    ({ options, user }) => {
      type Handler = () => void;
      const calls: { name: string; args: unknown[] }[] = [];
      const record = (name: string, ...args: unknown[]) => {
        calls.push({ name, args });
      };
      const version = options.version ?? "8.0";
      const atLeast = (wanted: string) => {
        const a = version.split(".").map(Number);
        const b = wanted.split(".").map(Number);
        for (let i = 0; i < Math.max(a.length, b.length); i++) {
          const d = (a[i] ?? 0) - (b[i] ?? 0);
          if (d !== 0) return d > 0;
        }
        return true;
      };

      const mainHandlers = new Set<Handler>();
      const backHandlers = new Set<Handler>();
      const main = { text: "", visible: false };
      const back = { visible: false };

      const MainButton = {
        get isVisible() {
          return main.visible;
        },
        isActive: true,
        setText(text: string) {
          record("MainButton.setText", text);
          main.text = text;
        },
        setParams(params: Record<string, unknown>) {
          record("MainButton.setParams", params);
          if (typeof params.text === "string") main.text = params.text;
        },
        show() {
          record("MainButton.show");
          main.visible = true;
        },
        hide() {
          record("MainButton.hide");
          main.visible = false;
        },
        enable() {
          record("MainButton.enable");
        },
        disable() {
          record("MainButton.disable");
        },
        showProgress() {},
        hideProgress() {},
        onClick(handler: Handler) {
          mainHandlers.add(handler);
        },
        offClick(handler: Handler) {
          mainHandlers.delete(handler);
        },
      };

      const BackButton = {
        get isVisible() {
          return back.visible;
        },
        show() {
          record("BackButton.show");
          back.visible = true;
        },
        hide() {
          record("BackButton.hide");
          back.visible = false;
        },
        onClick(handler: Handler) {
          backHandlers.add(handler);
        },
        offClick(handler: Handler) {
          backHandlers.delete(handler);
        },
      };

      const tgUser = { ...user, language_code: options.languageCode ?? "ru" };
      const initData = new URLSearchParams({
        query_id: "e2e",
        user: JSON.stringify(tgUser),
        auth_date: String(Math.floor(Date.now() / 1000)),
        ...(options.startParam ? { start_param: options.startParam } : {}),
        hash: "e2e",
      }).toString();

      const zero = { top: 0, bottom: 0, left: 0, right: 0 };
      const safeAreaInset = { ...zero, ...options.safeArea };
      const contentSafeAreaInset = { ...zero, ...options.contentSafeArea };

      Object.defineProperty(window, "Telegram", {
        configurable: true,
        value: {
          WebApp: {
            initData,
            initDataUnsafe: {
              user: tgUser,
              auth_date: Math.floor(Date.now() / 1000),
              ...(options.startParam ? { start_param: options.startParam } : {}),
            },
            version,
            platform: "android",
            colorScheme: "light",
            safeAreaInset,
            contentSafeAreaInset,
            MainButton,
            BackButton,
            HapticFeedback: {
              impactOccurred: (style: string) => record("HapticFeedback.impactOccurred", style),
              notificationOccurred: (type: string) => record("HapticFeedback.notificationOccurred", type),
              selectionChanged: () => record("HapticFeedback.selectionChanged"),
            },
            isVersionAtLeast: atLeast,
            ready: () => record("ready"),
            expand: () => record("expand"),
            setHeaderColor: (color: string) => record("setHeaderColor", color),
            setBackgroundColor: (color: string) => record("setBackgroundColor", color),
            setBottomBarColor: (color: string) => record("setBottomBarColor", color),
            disableVerticalSwipes: () => record("disableVerticalSwipes"),
            enableClosingConfirmation: () => record("enableClosingConfirmation"),
            disableClosingConfirmation: () => record("disableClosingConfirmation"),
            openTelegramLink: (url: string) => record("openTelegramLink", url),
            requestWriteAccess: (callback?: (granted: boolean) => void) => {
              record("requestWriteAccess");
              callback?.(true);
            },
            onEvent: () => {},
            offEvent: () => {},
          },
        },
      });

      Object.defineProperty(window, "__tg", {
        configurable: true,
        value: {
          calls,
          get main() {
            return { ...main };
          },
          get back() {
            return { ...back };
          },
          clickMain: () => {
            for (const handler of [...mainHandlers]) handler();
          },
          clickBack: () => {
            for (const handler of [...backHandlers]) handler();
          },
        },
      });

      // Как SDK: безопасные зоны — CSS-переменными на <html>
      const paint = () => {
        const style = document.documentElement?.style;
        if (!style) return false;
        for (const [side, value] of Object.entries(safeAreaInset))
          style.setProperty(`--tg-safe-area-inset-${side}`, `${value}px`);
        for (const [side, value] of Object.entries(contentSafeAreaInset))
          style.setProperty(`--tg-content-safe-area-inset-${side}`, `${value}px`);
        return true;
      };
      if (!paint()) document.addEventListener("DOMContentLoaded", paint, { once: true });
    },
    { options, user: E2E_USER },
  );
}

/** Что происходило с SDK: вызовы, главная кнопка, «назад» */
export function telegramState(page: Page): Promise<TelegramState> {
  return page.evaluate(() => {
    const tg = (window as unknown as { __tg: TelegramState }).__tg;
    return { calls: [...tg.calls], main: tg.main, back: tg.back };
  });
}

export async function clickMainButton(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as { __tg: { clickMain(): void } }).__tg.clickMain());
}

export async function clickBackButton(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as { __tg: { clickBack(): void } }).__tg.clickBack());
}
