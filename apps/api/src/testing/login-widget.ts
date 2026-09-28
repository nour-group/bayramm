// Подпись данных виджета входа так, как это делает Telegram, — для тестов.
// Алгоритм: https://core.telegram.org/widgets/login#checking-authorization

const encoder = new TextEncoder();

export interface TestWidgetUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
}

/** Поля виджета со строковыми значениями и верным hash. authDate — unix-секунды, по умолчанию сейчас. */
export async function signLoginWidget(
  user: TestWidgetUser,
  botToken: string,
  authDate = Math.floor(Date.now() / 1000),
): Promise<Record<string, string>> {
  const fields: Record<string, string> = { auth_date: String(authDate) };
  for (const [key, value] of Object.entries(user)) {
    if (value !== undefined) fields[key] = String(value);
  }
  const checkString = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join("\n");
  const secret = await crypto.subtle.digest("SHA-256", encoder.encode(botToken));
  const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(checkString)));
  return { ...fields, hash: Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("") };
}
