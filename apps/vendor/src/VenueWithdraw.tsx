/* «Отозвать с проверки» — владельцу кабинета, пока витрина на проверке у команды: она снова
   черновик (review → draft), и партнёр правит её напрямую; из очереди команды она уходит сама.
   За подтверждением (ConfirmSheet): потом на проверку отправляют заново. Кнопка — в чек-листе
   готовности (Readiness в Venue.tsx), сотруднику площадки её нет. */

import type { VendorListing } from "@bayramm/shared/api/vendor";
import { ConfirmSheet } from "@bayramm/ui/react";
import { useRef, useState } from "react";
import { ApiFailure, api } from "./api";
import { errorText } from "./errors";
import type { VendorDict } from "./i18n";

interface WithdrawActionProps {
  readonly listing: VendorListing;
  readonly t: VendorDict;
  readonly owner: boolean;
  /** Витрина отозвана (или уже не на проверке): перечитать её и значки разделов */
  readonly onWithdrawn: () => Promise<void>;
}

export function WithdrawAction({ listing, t, owner, onWithdrawn }: WithdrawActionProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  if (!owner) return null;

  const withdraw = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.withdrawListing(listing.id);
    } catch (err) {
      // Уже не на проверке (решила команда, отозвали с другого устройства) — как сейчас
      if (!(err instanceof ApiFailure && err.code === "illegal_transition")) {
        setError(errorText(err, t));
        setBusy(false);
        return;
      }
    }
    await onWithdrawn();
    // Кнопки больше нет — фокус на заголовок экрана, а не в пустоту
    document.getElementById("page-title")?.focus({ preventScroll: true });
    setBusy(false);
    setOpen(false);
  };

  return (
    <>
      <div className="actions">
        <button
          ref={button}
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            setError(null);
            setOpen(true);
          }}
        >
          {t.withdrawListing}
        </button>
      </div>
      <ConfirmSheet
        open={open}
        title={t.withdrawListingQ}
        text={t.withdrawListingText}
        confirmLabel={t.withdrawListingGo}
        cancelLabel={t.cancel}
        tone="danger"
        busy={busy}
        error={error ?? undefined}
        onConfirm={() => void withdraw()}
        onCancel={() => setOpen(false)}
        returnFocus={button}
      />
    </>
  );
}
