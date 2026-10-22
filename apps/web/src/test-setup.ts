/* Тесты экранов (jsdom): куски сборки с экранами и словари обоих языков — загружены заранее.
   Иначе первый заход на экран ждал бы import() дольше, чем тест ждёт отрисовки, а смена
   языка — загрузки словаря. Тестам воркера (node) не нужно. */

import { LANGS } from "@bayramm/shared";
import { setBackHistory } from "@bayramm/ui/react";
import { loadDictionary } from "./i18n";
import { preloadAll } from "./screens";

// Шторки без записей истории: шаг назад закрытой шторки одного теста пришёл бы в следующий
// (сами записи проверяют тесты набора и e2e)
setBackHistory(false);

if (typeof document !== "undefined") await Promise.all([preloadAll(), ...LANGS.map(loadDictionary)]);
