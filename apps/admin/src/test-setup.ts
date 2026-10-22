/* Тесты экранов (jsdom): куски сборки с экранами — загружены заранее. Иначе первый заход
   в раздел ждал бы import() дольше, чем тест ждёт отрисовки. Тестам воркера (node) не нужно. */

import { setBackHistory } from "@bayramm/ui/react";
import { preloadAll } from "./screens";

// Шторки без записей истории: шаг назад закрытой шторки одного теста пришёл бы в следующий
// (сами записи проверяют тесты набора и e2e)
setBackHistory(false);
if (typeof document !== "undefined") await preloadAll();
