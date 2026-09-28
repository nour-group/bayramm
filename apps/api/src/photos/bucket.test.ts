// Бакет объявлен в миграции, пределы проверки — в @bayramm/media. Разойдутся —
// сервер начнёт принимать то, что бакет отвергнет, или наоборот
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LISTING_PHOTOS_BUCKET, MAX_UPLOAD_BYTES, UPLOAD_MIME_TYPES } from "@bayramm/media";
import { describe, expect, it } from "vitest";

const migrationsDir = join(import.meta.dirname, "../../../../supabase/migrations");
const sources = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(join(migrationsDir, f), "utf8"))
  .join("\n");

describe("бакет фото в миграциях совпадает с @bayramm/media", () => {
  const insert =
    sources.match(/insert into storage\.buckets[\s\S]*?values\s*\(([\s\S]*?)\)\s*on conflict/)?.[1] ?? "";

  it("имя, публичность, предел размера и типы", () => {
    expect(insert).toContain(
      `'${LISTING_PHOTOS_BUCKET}', '${LISTING_PHOTOS_BUCKET}', true, ${MAX_UPLOAD_BYTES},`,
    );
    const mimes = [...(insert.match(/array\[([^\]]*)\]/)?.[1] ?? "").matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(mimes).toEqual([...UPLOAD_MIME_TYPES]);
  });

  it("предел размера в app.photos — тот же", () => {
    const checks = [...sources.matchAll(/photos_bytes_check check \(bytes between 1 and (\d+)\)/g)];
    expect(Number(checks.at(-1)?.[1])).toBe(MAX_UPLOAD_BYTES);
  });
});
