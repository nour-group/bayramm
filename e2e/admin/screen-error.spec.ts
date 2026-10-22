import { t } from "../../apps/admin/src/texts";
import { expect, test } from "../support/offline";
import { mockStaffApi, NOW } from "../support/staff-api";

/* Кусок раздела панели не загрузился (нет связи, после выкладки его уже нет) — на месте
   раздела строка и «Повторить», шапка и разделы остаются; повтор грузит кусок заново
   (ScreenErrorBoundary и retryableLazy из @bayramm/ui/react). */

// Кусок «Настроек»: в разработке — модуль исходника, в сборке — /assets/Settings-<хэш>.js
const SETTINGS_CHUNK = /\/(src\/pages\/Settings\.tsx|assets\/Settings-[\w-]+\.js)(\?.*)?$/;

test("раздел не загрузился — «Повторить» вместо пустоты; повтор открывает раздел", async ({ page }) => {
  await page.clock.setFixedTime(NOW);
  await mockStaffApi(page);
  await page.route(SETTINGS_CHUNK, (route) => route.abort("internetdisconnected"));
  await page.goto("/settings");

  const alert = page.locator(".ui-screen-error[role=alert]");
  await expect(alert).toContainText(t.screenFailed);
  await expect(page.locator("#page-title")).toHaveText(t.settings);

  await page.unroute(SETTINGS_CHUNK);
  await alert.getByRole("button", { name: t.retry }).click();
  await expect(alert).toHaveCount(0);
  await expect(page.locator(".settings-list").first()).toBeVisible();
});
