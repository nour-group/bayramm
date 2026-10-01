import type { Dict, Lang } from "@bayramm/shared";

/* Словари интерфейса — отдельными кусками сборки: первая загрузка тянет только словарь
   своего языка, второй — при переключении (или заранее, когда к переключателю потянулись:
   LangSwitch). Тип Dict — из @bayramm/shared, узбекский обязан совпадать с русским, как
   и раньше. Воркеру (разметка страниц) словари по-прежнему нужны оба — он берёт их из
   @bayramm/shared целиком, у него сборка своя. */

const LOADERS: Readonly<Record<Lang, () => Promise<Dict>>> = {
  ru: () => import("@bayramm/shared/i18n/ru").then((m) => m.ru),
  uz: () => import("@bayramm/shared/i18n/uz").then((m) => m.uz),
};

const ready = new Map<Lang, Dict>();
const loading = new Map<Lang, Promise<Dict>>();

/** Словарь языка, если он уже загружен; иначе null */
export function dictionary(lang: Lang): Dict | null {
  return ready.get(lang) ?? null;
}

/** Загрузить словарь: один запрос на язык; не загрузился — следующий вызов пробует снова */
export function loadDictionary(lang: Lang): Promise<Dict> {
  const done = ready.get(lang);
  if (done) return Promise.resolve(done);
  const pending = loading.get(lang);
  if (pending) return pending;
  const load = LOADERS[lang]().then(
    (dict) => {
      ready.set(lang, dict);
      loading.delete(lang);
      return dict;
    },
    (error: unknown) => {
      loading.delete(lang);
      throw error;
    },
  );
  loading.set(lang, load);
  return load;
}

/** Загрузить заранее (наведение на переключатель): ошибку сети покажет само переключение */
export function prefetchDictionary(lang: Lang): void {
  loadDictionary(lang).catch(() => {});
}
