// Шаблон публикации текстов согласий (supabase/legal/consent-texts.template.sql) знает
// каждую цель согласия: новая цель в перечислении app.consent_purpose без места в шаблоне —
// красный тест, иначе её текст в production не выйти. Сам шаблон проверен на базе:
// незаполненное, черновик, апостроф и один язык из двух откатывают его целиком.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const supabase = join(import.meta.dirname, "../../../../supabase");
const template = readFileSync(join(supabase, "legal/consent-texts.template.sql"), "utf8");

/** Цели согласий из миграций: create type … as enum (…) и alter type … add value */
function consentPurposes(): string[] {
  const purposes: string[] = [];
  for (const file of readdirSync(join(supabase, "migrations")).sort()) {
    const source = readFileSync(join(supabase, "migrations", file), "utf8");
    const created = /create type app\.consent_purpose as enum \(([\s\S]*?)\);/.exec(source);
    if (created?.[1]) purposes.push(...[...created[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1] as string));
    for (const added of source.matchAll(
      /alter type app\.consent_purpose add value (?:if not exists )?'([a-z_]+)'/g,
    )) {
      purposes.push(added[1] as string);
    }
  }
  return purposes;
}

describe("шаблон текстов согласий", () => {
  it("у каждой цели — место для текста на ru и uz", () => {
    const purposes = consentPurposes();
    expect(purposes).toContain("client_service");
    for (const purpose of purposes) {
      for (const locale of ["ru", "uz"]) {
        expect(template, `${purpose} · ${locale}`).toContain(
          `('${purpose}', '${locale}', '{{ПОЛУЧАТЕЛИ}}', '{{ТЕКСТ: ${purpose}, ${locale}}}')`,
        );
      }
    }
  });

  it("обязательные цели клиента — те же, что проверяет чек-лист выпуска", () => {
    const check = readFileSync(join(supabase, "../.github/scripts/release-check.sh"), "utf8");
    for (const purpose of ["client_service", "request_transfer", "bot_notifications"]) {
      expect(check).toContain(purpose);
      expect(template).toMatch(
        new RegExp(`array\\[[^\\]]*'${purpose}'[^\\]]*\\]::app\\.consent_purpose\\[\\]`),
      );
    }
  });

  it("в шаблоне нет готовых текстов: только места {{…}}", () => {
    const bodies = [...template.matchAll(/^\s+\('[a-z_]+', '(?:ru|uz)', '([^']*)', '([^']*)'\)[,;]$/gm)];
    expect(bodies).toHaveLength(12);
    for (const [, recipients, body] of bodies) {
      expect(recipients).toBe("{{ПОЛУЧАТЕЛИ}}");
      expect(body).toMatch(/^\{\{ТЕКСТ: [a-z_]+, (?:ru|uz)\}\}$/);
    }
  });
});
