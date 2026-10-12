/* Свёрнутый блок: кнопка и содержимое под ней, пока кнопку не нажали, содержимого на экране нет.
   Для того, что нужно не каждый день: обозначения календаря, условия услуги. Открывать можно и
   снаружи (open): ошибка в свёрнутом поле открывает блок, чтобы её было видно. */

import { type ReactNode, useId, useState } from "react";
import { Icon } from "./icons";

interface DisclosureProps {
  readonly label: string;
  readonly children: ReactNode;
  /** Открыт с самого начала (неуправляемый блок) */
  readonly defaultOpen?: boolean;
  /** Управляемый блок: состояние держит родитель */
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly className?: string;
}

export function Disclosure({
  label,
  children,
  defaultOpen = false,
  open,
  onOpenChange,
  className,
}: DisclosureProps) {
  const [own, setOwn] = useState(defaultOpen);
  const shown = open ?? own;
  const bodyId = useId();
  const toggle = () => {
    setOwn(!shown);
    onOpenChange?.(!shown);
  };
  return (
    <div className={["disclosure-block", className ?? ""].filter(Boolean).join(" ")}>
      <button
        type="button"
        className={`btn btn-ghost disclosure${shown ? " disclosure-open" : ""}`}
        aria-expanded={shown}
        aria-controls={shown ? bodyId : undefined}
        onClick={toggle}
      >
        <Icon name="next" size={14} />
        {label}
      </button>
      {shown ? (
        <div className="disclosure-body" id={bodyId}>
          {children}
        </div>
      ) : null}
    </div>
  );
}
