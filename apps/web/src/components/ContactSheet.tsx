import type { ContactChannel, ListingContacts } from "@bayramm/shared/api";
import { Dialog } from "@bayramm/ui/react";
import { type ReactNode, useRef, useState } from "react";
import { canSignIn, useLang, useServices } from "../context";
import { formatPhone, telHref } from "../format";
import { Icon } from "../icons";

/* «Связаться»: телефон и Telegram витрины — по нажатию, до всякой заявки и без входа (правило
   продукта: контакты до заявки). Карточка витрины их не несёт: нажали — запрос контактов, сервер
   считает открытие (без клиента: только витрина, источник и вошёл ли), выбор «Позвонить» или
   «Написать в Telegram» — ещё один счётчик. По ним панель видит, у кого чаще ищут связь.
   Окно — Dialog набора: шторка снизу на телефоне, карточка по центру на компьютере. */

/** Имя Telegram в ссылку: только допустимые знаки (имя проверил сервер) */
export const telegramHref = (name: string) => `https://t.me/${encodeURIComponent(name)}`;

type State =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly contacts: ListingContacts }
  | { readonly kind: "error" };

interface ContactButtonProps {
  readonly slug: string;
  /** Название витрины — в заголовке окна и подписи для диктора */
  readonly name: string;
  readonly className?: string;
  /** Подпись кнопки; по умолчанию «Связаться» */
  readonly children?: ReactNode;
  /** Подпись для диктора, когда видна только иконка */
  readonly ariaLabel?: string;
}

/** Кнопка «Связаться» и окно с контактами витрины */
export function ContactButton({
  slug,
  name,
  className = "btn btn-secondary",
  children,
  ariaLabel,
}: ContactButtonProps) {
  const { api, identity, webApp } = useServices();
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<State>({ kind: "idle" });
  const button = useRef<HTMLButtonElement>(null);
  const signedIn = canSignIn(identity);

  const load = () => {
    setState({ kind: "loading" });
    api.listingContacts(slug, signedIn).then(
      (contacts) => setState({ kind: "ready", contacts }),
      () => setState({ kind: "error" }),
    );
  };

  const show = () => {
    setOpen(true);
    // Каждое открытие — запрос: его и считает сервер (ответ не кэшируется)
    load();
  };

  const chose = (channel: ContactChannel) => api.contactChoice(slug, channel, signedIn);

  return (
    <>
      <button
        type="button"
        ref={button}
        className={className}
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        onClick={show}
      >
        {children ?? (
          <>
            <Icon name="phone" size={17} />
            {t.contactBtn}
          </>
        )}
      </button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={t.contactH}
        className="contact-sheet"
        returnFocus={button}
      >
        <p className="muted small contact-sheet-name">{name}</p>
        {state.kind === "ready" ? (
          <ul className="contact-ways">
            {state.contacts.phone ? (
              <li>
                <span className="contact-way-value">{formatPhone(state.contacts.phone)}</span>
                <a
                  className="btn btn-primary"
                  href={telHref(state.contacts.phone)}
                  onClick={() => chose("phone")}
                >
                  <Icon name="phone" size={17} />
                  {t.contactCall}
                </a>
              </li>
            ) : null}
            {state.contacts.telegram ? (
              <li>
                <span className="contact-way-value">@{state.contacts.telegram}</span>
                <a
                  className="btn btn-secondary"
                  href={telegramHref(state.contacts.telegram)}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(event) => {
                    chose("telegram");
                    // В Mini App — ссылкой Telegram: чат откроется в самом клиенте
                    const link = telegramHref(state.contacts.telegram ?? "");
                    if (webApp?.openTelegramLink) {
                      event.preventDefault();
                      webApp.openTelegramLink(link);
                    }
                  }}
                >
                  <Icon name="tg" size={17} />
                  {t.contactTg}
                </a>
              </li>
            ) : null}
          </ul>
        ) : state.kind === "error" ? (
          <div className="contact-error">
            <p role="alert">{t.contactErr}</p>
            <button type="button" className="btn btn-secondary" onClick={load}>
              {t.retry}
            </button>
          </div>
        ) : (
          <p className="muted" role="status">
            {t.loading}
          </p>
        )}
        <p className="muted small">{t.contactP}</p>
      </Dialog>
    </>
  );
}
