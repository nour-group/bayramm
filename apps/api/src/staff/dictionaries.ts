// Справочники для форм панели: категории, районы, поводы, сотрудники (выбор
// менеджера) и настройки, от которых зависят подсказки (минимум фото, SLA).
//
//   GET /staff/dictionaries

import type { StaffDictionaries } from "@bayramm/shared/api/staff";
import { Hono } from "hono";
import { sql } from "kysely";
import { staffOf } from "../auth/session";
import { withActor } from "../db/actor";
import type { AppEnv } from "../env";
import { requirePermission } from "./access";

export const dictionaries = new Hono<AppEnv>();

dictionaries.get("/", requirePermission("catalog.read"), async (c) => {
  const body: StaffDictionaries = await withActor(c.var.db, staffOf(c), async (trx) => {
    const categories = await trx
      .selectFrom("app.categories")
      .select(["code", "name_ru", "name_uz", "enabled"])
      .orderBy("sort")
      .execute();
    const districts = await trx
      .selectFrom("app.districts")
      .select(["code", "name_ru", "name_uz"])
      .orderBy("sort")
      .execute();
    const occasions = await trx
      .selectFrom("app.occasions")
      .select(["code", "name_ru", "name_uz"])
      .orderBy("sort")
      .execute();
    const staff = await trx
      .selectFrom("app.staff as s")
      .innerJoin("pii.staff_profiles as p", "p.staff_id", "s.id")
      .select(["s.id", "s.role", "p.display_name"])
      .where("s.active", "=", true)
      .orderBy("p.display_name")
      .execute();
    const settings = await trx
      .selectNoFrom([
        sql<number | null>`app.setting_int('min_photos')`.as("min_photos"),
        sql<number | null>`app.setting_int('max_photos')`.as("max_photos"),
        sql<number | null>`app.setting_int('sla_hours')`.as("sla_hours"),
      ])
      .executeTakeFirstOrThrow();

    const item = (row: { code: string; name_ru: string; name_uz: string }) => ({
      code: row.code,
      nameRu: row.name_ru,
      nameUz: row.name_uz,
    });
    return {
      categories: categories.map((row) => ({ ...item(row), enabled: row.enabled })),
      districts: districts.map(item),
      occasions: occasions.map(item),
      staff: staff.map((row) => ({ id: row.id, displayName: row.display_name, role: row.role })),
      settings: {
        minPhotos: Math.max(3, settings.min_photos ?? 3),
        maxPhotos: settings.max_photos ?? 10,
        slaHours: settings.sla_hours ?? 12,
      },
    };
  });
  return c.json(body);
});
