/* Тексты набора. В самих компонентах слов нет: подписи на русском и узбекском приходят
   из словаря приложения. Общие («Закрыть», «Очистить») — один раз через провайдер,
   частные (подпись поля, «Гостей +20») — пропсами компонента. */

import { createContext, type ReactNode, useContext } from "react";

export interface UiTexts {
  /** Кнопка-крестик шторки, диалога и уведомления */
  readonly close: string;
  /** Очистить поле поиска */
  readonly clear: string;
}

const UiTextsContext = createContext<UiTexts | null>(null);

export function UiTextsProvider({ texts, children }: { texts: UiTexts; children: ReactNode }) {
  return <UiTextsContext.Provider value={texts}>{children}</UiTextsContext.Provider>;
}

/** Без провайдера — ошибка сразу, а не кнопка без подписи для диктора */
export function useUiTexts(): UiTexts {
  const texts = useContext(UiTextsContext);
  if (!texts) throw new Error("@bayramm/ui/react: нет UiTextsProvider над компонентом");
  return texts;
}
