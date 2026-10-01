/* Аккаунт партнёра до кабинета: выбор вендора (человек — партнёр нескольких площадок) и
   выход. Раздел «Аккаунт» с ролью, языком и ссылками на другие приложения — AccountPage.tsx
   (своя часть сборки). */

import type { VendorMembership } from "@bayramm/shared/api/account";
import { signOut } from "./api";
import { chooseVendor } from "./hub";
import { inTelegram } from "./telegram";
import { Heading, type ScreenProps } from "./ui";

interface ChooserProps extends Pick<ScreenProps, "t" | "headingRef"> {
  readonly vendors: readonly VendorMembership[];
  readonly onChosen: () => void;
}

export function VendorChooser({ vendors, t, headingRef, onChosen }: ChooserProps) {
  return (
    <section className="gate" aria-labelledby="page-title">
      <Heading headingRef={headingRef}>{t.chooseTitle}</Heading>
      <p className="lead">{t.chooseText}</p>
      <div className="gate-actions vendor-choice">
        {vendors.map((v) => (
          <button
            key={v.vendorId}
            type="button"
            className="btn btn-ghost btn-wide vendor-option"
            onClick={() => {
              chooseVendor(v.vendorId);
              onChosen();
            }}
          >
            <span>{v.name ?? v.code}</span>
            <span className="vendor-code">{v.code}</span>
          </button>
        ))}
      </div>
      {/* В браузере — войти другим аккаунтом; в Telegram вход — сама кнопка бота */}
      {inTelegram() ? null : <SignOutButton label={t.signOut} />}
    </section>
  );
}

/** Выйти: отозвать сессию и забыть выбранный кабинет; дальше — экран входа */
export function SignOutButton({ label }: { label: string }) {
  return (
    <button
      type="button"
      className="btn btn-ghost account-signout"
      onClick={() => {
        chooseVendor(null);
        void signOut().finally(() => window.location.replace("/"));
      }}
    >
      {label}
    </button>
  );
}
