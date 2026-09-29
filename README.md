# Bayramm

Toshkentdagi bayramlar uchun pudratchilar platformasi — Telegram Mini App va sayt, o'zbek va rus tillarida.

| Qism | Papka | Stek |
|---|---|---|
| Klient (TMA + sayt) | `apps/web` | Vite · React · Cloudflare Workers |
| Vendor kabineti | `apps/vendor` | Vite · React · Cloudflare Workers |
| Operator paneli | `apps/admin` | Vite · React · Cloudflare Workers |
| API | `apps/api` | Hono · Cloudflare Workers |
| Baza | `supabase/` | Postgres (Supabase), migratsiyalar |
| Umumiy kod | `packages/` | TypeScript |
| Interfeys prototiplari | `prototypes/` | HTML + jsdom testlari |
| Brauzer testlari | `e2e/` | Playwright · axe-core |

## Ishga tushirish

```bash
pnpm install
pnpm dev:web
pnpm dev:vendor
pnpm dev:admin
pnpm dev:api
```

## Tekshiruvlar

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm e2e    # brauzerda (Chromium): pnpm --filter @bayramm/e2e e2e:install
```

Kod qoidalari va konvensiyalar — [`CLAUDE.md`](CLAUDE.md). Zaiflik topsangiz — [`SECURITY.md`](SECURITY.md).
