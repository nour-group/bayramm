# @bayramm/tg

Общий код для Telegram: проверка `initData` Mini App, разбор deep link
`startapp` и проверка секрета вебхука.

Только стандартные API (Web Crypto, `URLSearchParams`), без Node crypto —
работает в Cloudflare Workers. Сборки нет: `exports` смотрит на исходники
TypeScript, их собирает wrangler или vite приложения.

```jsonc
// package.json приложения
"dependencies": { "@bayramm/tg": "workspace:*" }
```

## initData

```ts
import { verifyInitData } from "@bayramm/tg";

app.post("/api/auth/telegram", async (c) => {
  const { initData } = await c.req.json<{ initData: string }>();
  // Токен того бота, через которого открыт Mini App
  const result = await verifyInitData(initData, c.env.CLIENT_BOT_TOKEN);
  if (!result.ok) {
    console.warn("tg auth rejected", result.reason); // reason — для логов, клиенту хватит 401
    return c.json({ error: "unauthorized" }, 401);
  }
  const { user, authDate, startParam } = result.data;
  // …upsert клиента по user.id, выдать сессию
});
```

| `reason` | Когда |
|---|---|
| `missing_hash` | Нет поля `hash` — открыто не из Telegram |
| `bad_hash` | Подпись не сошлась: подделка, изменённое поле, чужой бот |
| `expired` | `auth_date` старше `maxAgeSeconds` (по умолчанию сутки) или больше чем на 5 минут в будущем |
| `malformed` | Не разбирается: повтор ключа, больше 16 КБ, нет или кривой `auth_date`, битый JSON в `user` |
| `missing_user` | Подпись верна, но поля `user` нет |

Опции: `maxAgeSeconds` и `now` (миллисекунды, как `Date.now`, — для тестов).
Пустой токен или неверные опции — исключение: это ошибка конфигурации, а не
плохой запрос.

Поле `signature` **входит** в строку проверки `hash` — так её считает
Telegram. Исключается оно только при проверке Ed25519.

### Без токена бота

`verifyInitDataSignature(initData, botId, { publicKey? })` проверяет подпись
Ed25519 из поля `signature` открытым ключом Telegram («third-party
validation»). Результат тот же, только причины `missing_signature` и
`bad_signature` вместо `missing_hash` и `bad_hash`. `publicKey`: `"production"`
(по умолчанию), `"test"` или свои 32 байта для тестов.

## Deep links

Ссылка на карточку вендора: `t.me/<бот>/<приложение>?startapp=vendor_<id>`.
`id` — строчная латиница, цифры, дефис, до 64 символов.

```ts
import { buildStartParam, parseStartParam } from "@bayramm/tg";

buildStartParam({ kind: "vendor", id: "toyxona-1" }); // "vendor_toyxona-1"
parseStartParam("vendor_toyxona-1"); // { kind: "vendor", id: "toyxona-1" }
parseStartParam("vendor_../admin"); // null — открыть главную
```

`start_param` — только маршрут. Его присылает пользователь, прав он не даёт.

## Вебхук

```ts
import { verifyWebhookSecret } from "@bayramm/tg";

app.post("/tg/webhook", async (c) => {
  if (!(await verifyWebhookSecret(c.req.raw, c.env.TG_WEBHOOK_SECRET))) return c.body(null, 401);
  // …
});
```

Секрет — тот же, что передан в `setWebhook` как `secret_token`: 1–256
символов из `[A-Za-z0-9_-]`. Сравнение за постоянное время.

## Команды

```bash
pnpm --filter @bayramm/tg test
pnpm --filter @bayramm/tg typecheck
```
