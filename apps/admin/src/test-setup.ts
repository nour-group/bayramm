/* Тесты экранов (jsdom): куски сборки с экранами — загружены заранее. Иначе первый заход
   в раздел ждал бы import() дольше, чем тест ждёт отрисовки. Тестам воркера (node) не нужно. */

import { preloadAll } from "./screens";

if (typeof document !== "undefined") await preloadAll();
