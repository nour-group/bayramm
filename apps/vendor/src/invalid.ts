/* После проверки формы — фокус и прокрутка к первому полю с ошибкой (aria-invalid): поле бывает
   за краем шторки или экрана, а диктор иначе не узнает, что не так. Форма зовёт focus() вместе с
   записью ошибок; переход — после отрисовки, когда отметки уже на полях. У группы (fieldset,
   радиокнопки) фокус — на её первый элемент управления. */

import { type RefObject, useCallback, useEffect, useState } from "react";

const CONTROL = "input:not([type=hidden]), textarea, button, [tabindex]";

/** Первое поле с ошибкой внутри root: само поле или первый элемент управления группы */
export function firstInvalid(root: ParentNode): HTMLElement | null {
  const field = root.querySelector<HTMLElement>('[aria-invalid="true"]');
  if (!field) return null;
  if (field.matches(CONTROL)) return field;
  return field.querySelector<HTMLElement>(CONTROL) ?? field;
}

/** Функция «показать первую ошибку»: фокус и прокрутка — после того, как ошибки отрисованы */
export function useFocusInvalid(root: RefObject<HTMLElement | null>): () => void {
  const [asked, setAsked] = useState(0);
  useEffect(() => {
    if (asked === 0 || !root.current) return;
    const target = firstInvalid(root.current);
    if (!target) return;
    // scrollIntoView есть не везде (ловушка №5); прокрутка — сами, фокус — без неё (ловушка №3)
    target.scrollIntoView?.({ block: "center" });
    target.focus({ preventScroll: true });
  }, [asked, root]);
  return useCallback(() => setAsked((n) => n + 1), []);
}
