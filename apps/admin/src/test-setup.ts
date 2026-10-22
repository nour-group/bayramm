/* Тесты экранов (jsdom): куски сборки с экранами — загружены заранее. Иначе первый заход
   в раздел ждал бы import() дольше, чем тест ждёт отрисовки. Тестам воркера (node) не нужно. */

import { setBackHistory } from "@bayramm/ui/react";
import { preloadAll } from "./screens";

// Шторки без записей истории: шаг назад закрытой шторки одного теста пришёл бы в следующий
// (сами записи проверяют тесты набора и e2e)
setBackHistory(false);
if (typeof document !== "undefined") await preloadAll();

// jsdom картинок не грузит: снимок просмотра фото «показан» сразу, как появился (решать по фото
// можно только после показа — так и в браузере)
if (typeof MutationObserver !== "undefined" && typeof document !== "undefined") {
  const shown = (node: Node) => {
    if (!(node instanceof Element)) return;
    const images = node.matches(".viewer-image") ? [node] : [...node.querySelectorAll(".viewer-image")];
    for (const img of images) queueMicrotask(() => img.dispatchEvent(new Event("load")));
  };
  new MutationObserver((records) => {
    for (const record of records) for (const node of record.addedNodes) shown(node);
  }).observe(document.body, { childList: true, subtree: true });
}
