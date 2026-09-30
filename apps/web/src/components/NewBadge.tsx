import { Tooltip } from "@bayramm/ui/react";
import { useLang } from "../context";

/**
 * «Новый» вместо рейтинга (правило продукта: выдуманных оценок нет). Полный смысл —
 * «новый на площадке», а не «новое здание»: диктору — полный текст, мыши — подсказка.
 * Не атрибут title: он не виден ни пальцу, ни клавиатуре. Значок стоит внутри ссылки
 * карточки, поэтому сам не фокусируется
 */
export function NewBadge() {
  const { t } = useLang();
  return (
    <Tooltip text={t.newBadgeHint} describe={false}>
      {(tip) => (
        <span {...tip} className="badge-new">
          <span aria-hidden="true">{t.newBadge}</span>
          <span className="sr-only">{t.newBadgeHint}</span>
        </span>
      )}
    </Tooltip>
  );
}
