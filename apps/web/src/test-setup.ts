/* Тесты экранов (jsdom): куски сборки с экранами — загружены заранее. Иначе первый заход
   на экран ждал бы import() дольше, чем тест ждёт отрисовки. Тестам воркера (node) не нужно. */

import { preloadAll } from "./screens";

if (typeof document !== "undefined") await preloadAll();
