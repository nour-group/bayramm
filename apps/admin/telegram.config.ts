/* Бот виджета входа панели оператора — по окружению сборки (CLOUDFLARE_ENV, как у
   @cloudflare/vite-plugin). vite.config.ts кладёт имя в import.meta.env.VITE_TG_BOT_USERNAME.

   Имя бота — не секрет: оно видно в кнопке входа. Токен того же бота (TELEGRAM_BOT_TOKEN)
   проверяет подпись на API. В @BotFather у бота командой /setdomain задан домен панели
   своего окружения; один бот — один домен. */
export const TG_BOT_USERNAMES = {
  local: "bayramm_test_bot",
  staging: "bayramm_test_bot",
  production: "bayramm_bot",
} as const;

export type BuildTarget = keyof typeof TG_BOT_USERNAMES;

// Имя бота Telegram: 5–32 символа латиницы, цифр и _, оканчивается на bot
const BOT_USERNAME_RE = /^[A-Za-z0-9_]{2,29}bot$/i;

/**
 * Имя бота для сборки. Локально можно подставить своего:
 * VITE_TG_BOT_USERNAME=my_test_bot pnpm dev:admin. Для staging и production — только из карты
 * выше, чтобы переменная окружения CI не подменила бота молча.
 */
export function tgBotUsername(target: string = "local", override?: string): string {
  if (!Object.hasOwn(TG_BOT_USERNAMES, target)) {
    throw new Error(`telegram.config: неизвестное окружение сборки «${target}»`);
  }
  const name = target === "local" && override ? override : TG_BOT_USERNAMES[target as BuildTarget];
  if (!BOT_USERNAME_RE.test(name)) throw new Error(`telegram.config: «${name}» — не имя бота Telegram`);
  return name;
}
