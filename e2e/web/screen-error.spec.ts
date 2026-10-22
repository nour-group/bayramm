import { expect, test } from "../support/offline";
import { open, PATHS, prepare, T } from "../support/web";

/* Кусок экрана не загрузился (нет связи, после выкладки его уже нет) — на месте экрана
   строка и «Повторить», а не пустая страница; повтор грузит кусок заново
   (ScreenErrorBoundary и retryableLazy из @bayramm/ui/react). */

const ru = T.ru;
// Кусок экрана документов: в разработке — модуль исходника, в сборке — /assets/Docs-<хэш>.js
const DOCS_CHUNK = /\/(src\/screens\/Docs\.tsx|assets\/Docs-[\w-]+\.js)(\?.*)?$/;

test("кусок экрана не загрузился — «Повторить» вместо пустой страницы; повтор открывает экран", async ({
  page,
}) => {
  await prepare(page);
  await page.route(DOCS_CHUNK, (route) => route.abort("internetdisconnected"));
  await open(page, PATHS.docs);

  const alert = page.locator(".ui-screen-error[role=alert]");
  await expect(alert).toContainText(ru.errLoad);
  // Оболочка на месте: шапка с логотипом, а не пустой #root
  await expect(page.locator("header.top")).toBeVisible();

  await page.unroute(DOCS_CHUNK);
  await alert.getByRole("button", { name: ru.retry }).click();
  await expect(alert).toHaveCount(0);
  await expect(page.locator(".docs").first()).toBeVisible();
});

test("куска нет на сервере (404 после выкладки) — одна перезагрузка, потом «Повторить»", async ({ page }) => {
  await prepare(page);
  await page.route(DOCS_CHUNK, (route) => route.fulfill({ status: 404, body: "" }));
  let loads = 0;
  page.on("load", () => {
    loads += 1;
  });
  await open(page, PATHS.docs);

  const alert = page.locator(".ui-screen-error[role=alert]");
  // Первая загрузка и одна перезагрузка: новая сборка знала бы новые имена кусков
  await expect.poll(() => loads).toBe(2);
  await expect(alert).toContainText(ru.errLoad);
  await page.waitForTimeout(500);
  expect(loads).toBe(2);
});
