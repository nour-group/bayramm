/* Прокрутка при «назад» (router.ts запоминает её у каждой записи истории). Экран, на который
   вернулись, может дорисовываться (данные из кэша — сразу, без кэша — через запрос): ждём,
   пока страница дорастёт до нужной высоты, но не дольше limitMs. scrollTo и MutationObserver
   есть не везде (ловушка №5) — без них просто ничего не делаем или прокручиваем сразу. */

/** Прокрутить к y, когда страница станет достаточно высокой; вернёт отмену ожидания */
export function scrollWhenReady(y: number, root: Element, limitMs = 3000): () => void {
  if (typeof window.scrollTo !== "function") return () => {};
  const reachable = () => document.documentElement.scrollHeight - window.innerHeight >= y - 1;
  if (reachable() || typeof MutationObserver !== "function") {
    window.scrollTo(0, y);
    return () => {};
  }
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    observer.disconnect();
    clearTimeout(timer);
    window.scrollTo(0, y);
  };
  const observer = new MutationObserver(() => {
    if (reachable()) finish();
  });
  const timer = setTimeout(finish, limitMs);
  observer.observe(root, { childList: true, subtree: true });
  return () => {
    done = true;
    observer.disconnect();
    clearTimeout(timer);
  };
}
