/* Несколько номеров одной кнопкой «Показать телефоны»: одно чтение API открывает все —
   в журнал доступа к ПДн уходит одна запись, а не по записи на каждый номер. Скрытые — маской,
   показанные — ссылками tel:. Номер, которого нет, после показа — «не указан». */

import { formatUzPhone } from "@bayramm/shared";
import { useCallback, useState } from "react";
import type { Result } from "./api";
import { apiErrorText, t } from "./texts";

export interface PhoneRow<K extends string> {
  readonly key: K;
  readonly label: string;
}

type Reveal<K extends string> =
  | { state: "hidden" }
  | { state: "loading" }
  | { state: "shown"; phones: Readonly<Record<K, string | null>> }
  | { state: "error"; code: string };

export function PhonesReveal<K extends string>({
  rows,
  load,
}: {
  rows: readonly PhoneRow<K>[];
  /** Запрос к API: каждое чтение сервер пишет в журнал доступа к ПДн */
  load: () => Promise<Result<Readonly<Record<K, string | null>>>>;
}) {
  const [reveal, setReveal] = useState<Reveal<K>>({ state: "hidden" });
  const onShow = useCallback(async () => {
    setReveal({ state: "loading" });
    const result = await load();
    setReveal(result.ok ? { state: "shown", phones: result.data } : { state: "error", code: result.code });
  }, [load]);
  const shown = reveal.state === "shown" ? reveal.phones : null;

  return (
    <div className="phones-reveal">
      {rows.map((row) => {
        const phone = shown?.[row.key];
        return (
          <div key={row.key} className="phone-row">
            <span className="phone-label">{row.label}</span>
            {shown ? (
              phone ? (
                <a className="phone-value" href={`tel:${phone}`}>
                  {formatUzPhone(phone)}
                </a>
              ) : (
                <span className="muted">{t.notSet}</span>
              )
            ) : (
              <span className="phone-mask">
                <span aria-hidden="true">+998 •• ••• •• ••</span>
                <span className="visually-hidden">{t.hidden}</span>
              </span>
            )}
          </div>
        );
      })}
      {shown === null ? (
        <div>
          <button type="button" className="btn btn-sm" onClick={onShow} disabled={reveal.state === "loading"}>
            {t.showPhones}
          </button>
        </div>
      ) : null}
      {reveal.state === "error" && (
        <span className="field-error" role="alert">
          {apiErrorText(reveal.code)}
        </span>
      )}
    </div>
  );
}
