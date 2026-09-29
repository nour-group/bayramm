// Обновление от Telegram → то, что бот обрабатывает. Всё остальное — null: вебхук
// отвечает 200 и ничего не делает (иначе Telegram повторял бы доставку).
//
// Только личные чаты с человеком: группы, каналы и сообщения от ботов бот не
// читает. Текст сообщения никуда не идёт — нужны только команды /start, /stats, /admin.

export type BotMessage =
  /** /start и параметр ссылки t.me/<бот>?start=<параметр> */
  | { readonly kind: "start"; readonly payload: string | null }
  /** Команды команды Bayramm: /stats — сводка, /admin — кнопка панели. Не сотруднику — как «другое» */
  | { readonly kind: "command"; readonly name: StaffCommand }
  /** Контакт, отправленный кнопкой request_contact (или пересланный — это проверит обработчик) */
  | { readonly kind: "contact"; readonly userId: number | null; readonly phone: string }
  /** Любое другое сообщение в личном чате */
  | { readonly kind: "other" };

export type StaffCommand = "stats" | "admin";

export interface BotUpdate {
  readonly updateId: number;
  /** В личном чате id чата — это id пользователя */
  readonly chatId: number;
  readonly from: {
    readonly id: number;
    readonly languageCode: string | undefined;
    /** Имя пользователя Telegram без @: по нему принимается приглашение сотрудника */
    readonly username: string | undefined;
  };
  readonly message: BotMessage;
}

// /start, /start@имя_бота, параметр — до 64 символов из [A-Za-z0-9_-] (правила deep link)
const START_RE = /^\/start(?:@[A-Za-z0-9_]{1,64})?(?:\s+([A-Za-z0-9_-]{1,64}))?\s*$/;
const COMMAND_RE = /^\/(stats|admin)(?:@[A-Za-z0-9_]{1,64})?\s*$/;
// Правила имён пользователей Telegram: 5–32 символа, латиница, цифры, _
const USERNAME_RE = /^[A-Za-z0-9_]{5,32}$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isId = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

export function parseUpdate(body: unknown): BotUpdate | null {
  if (!isObject(body)) return null;
  const updateId = body.update_id;
  if (typeof updateId !== "number" || !Number.isSafeInteger(updateId) || updateId < 0) return null;

  const message = body.message;
  if (!isObject(message) || !isObject(message.chat) || !isObject(message.from)) return null;
  const { chat, from } = message;
  if (chat.type !== "private" || !isId(chat.id) || !isId(from.id) || from.is_bot === true) return null;
  if (chat.id !== from.id) return null;

  const languageCode = typeof from.language_code === "string" ? from.language_code : undefined;
  const username =
    typeof from.username === "string" && USERNAME_RE.test(from.username) ? from.username : undefined;
  const base = { updateId, chatId: chat.id, from: { id: from.id, languageCode, username } };

  const contact = message.contact;
  if (isObject(contact)) {
    if (typeof contact.phone_number !== "string") return null;
    const userId = isId(contact.user_id) ? contact.user_id : null;
    return { ...base, message: { kind: "contact", userId, phone: contact.phone_number } };
  }

  if (typeof message.text === "string") {
    const start = START_RE.exec(message.text.trim());
    if (start) return { ...base, message: { kind: "start", payload: start[1] ?? null } };
    const command = COMMAND_RE.exec(message.text.trim());
    if (command?.[1] === "stats" || command?.[1] === "admin") {
      return { ...base, message: { kind: "command", name: command[1] } };
    }
  }
  return { ...base, message: { kind: "other" } };
}
