# Bayramm

Toshkentdagi bayramlar uchun pudratchilar platformasi — Telegram Mini App va sayt, o'zbek va rus tillarida.

| Qism | Papka | Stek |
|---|---|---|
| Klient (TMA + sayt) | `apps/web` | Vite · React · Cloudflare Workers |
| API | `apps/api` | Hono · Cloudflare Workers |
| Baza | `supabase/` | Postgres (Supabase), migratsiyalar |
| Umumiy kod | `packages/` | TypeScript |
| Interfeys prototiplari | `prototypes/` | HTML + jsdom testlari |

## Ishga tushirish

```bash
pnpm install
pnpm dev:web
pnpm dev:api
```

## Tekshiruvlar

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Kod qoidalari va konvensiyalar — [`CLAUDE.md`](CLAUDE.md). Zaiflik topsangiz — [`SECURITY.md`](SECURITY.md).
