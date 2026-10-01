/* Тесты экранов (jsdom): куски сборки с разделами — загружены заранее. Иначе первый заход
   в раздел ждал бы import() дольше, чем тест ждёт отрисовки. Тестам воркера (node) не нужно.

   Сжатие фото — канвас браузера, которого в jsdom нет: подменено здесь, до загрузки раздела
   «Площадка», иначе он взял бы настоящее. Тест задаёт ответ сам (vi.mocked(compressForUpload)).
   Ширина — телефона (кабинет прежде всего Mini App): jsdom без matchMedia отдал бы 1024px,
   то есть компьютер; раскладку компьютера тест задаёт сам. */

import { vi } from "vitest";

vi.mock("@bayramm/media/browser", () => ({ compressForUpload: vi.fn() }));

if (typeof document !== "undefined") {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 390 });
  const { preloadAll } = await import("./screens");
  await preloadAll();
}
