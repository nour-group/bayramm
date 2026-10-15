/* «⋯» — второстепенные и необратимые действия услуги в шторке: на карточке остаётся одно
   главное. Выбранное действие запускается, когда шторка уже закрылась и вернула фокус на «⋯»:
   подтверждение (ConfirmSheet) откроется от кнопки, а не от исчезнувшего пункта. */

import { Dialog } from "@bayramm/ui/react";
import { useRef, useState } from "react";
import { Icon } from "./icons";

export interface MenuAction {
  readonly key: string;
  readonly label: string;
  /** Необратимое или убирающее с витрины — цветом отказа */
  readonly danger?: boolean;
  /** from — кнопка «⋯»: куда вернуть фокус после подтверждения */
  readonly run: (from: HTMLElement | null) => void;
}

interface OverflowMenuProps {
  /** Заголовок шторки: чьи действия */
  readonly title: string;
  /** Имя кнопки для диктора */
  readonly label: string;
  readonly actions: readonly MenuAction[];
  /** Идёт запрос: «⋯» недоступна */
  readonly disabled?: boolean;
  /** Класс кнопки «⋯»: у карточки услуги — svc-more (над растянутой ссылкой карточки) */
  readonly className?: string;
}

/** Закрыть шторку — крестик набора (@bayramm/ui/react Dialog) в заголовке */
export function OverflowMenu({
  title,
  label,
  actions,
  disabled = false,
  className = "svc-more",
}: OverflowMenuProps) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  if (actions.length === 0) return null;
  const pick = (action: MenuAction) => {
    setOpen(false);
    setTimeout(() => action.run(button.current), 0);
  };
  return (
    <>
      <button
        ref={button}
        type="button"
        className={`icon-btn ${className}`}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        <Icon name="more" size={20} />
      </button>
      <Dialog open={open} title={title} onClose={() => setOpen(false)} returnFocus={button}>
        <ul className="menu">
          {actions.map((action) => (
            <li key={action.key}>
              <button
                type="button"
                className={`menu-item${action.danger ? " menu-danger" : ""}`}
                onClick={() => pick(action)}
              >
                {action.label}
              </button>
            </li>
          ))}
        </ul>
      </Dialog>
    </>
  );
}
