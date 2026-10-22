/* Карточка «Контакты» на экране витрины: публичные телефон и Telegram, которые клиент видит по
   «Связаться» (правило продукта: телефон виден сразу, до заявки). Владелец кабинета меняет их
   сам, в шторке: телефон с маской «+998», Telegram — @имя или ссылка t.me/имя.
     · витрина вне сайта (черновик, отклонённая) — «Сохранить»: контакты меняются сразу;
     · на проверке, опубликована, приостановлена — «Отправить изменения»: уходит запросом команде
       («Клиенты увидят новые контакты после проверки командой Bayramm»); клиенты до решения видят
       прежние. Ждущий запрос — «на проверке» и новые значения, его можно отозвать; отказ — причина.
   Телефон обязателен, Telegram — нет. Сотрудник площадки (member) контакты только смотрит.
   Отправить можно только изменённое (кнопка ждёт правки); закрыть шторку с вписанным — «Уйти без
   сохранения?»; отозвать запрос — через подтверждение. Сохранили или отправили — всплывающая
   строка; ошибка проверки — фокус на неверное поле. */

import { normalizeTelegram, readUzPhoneDigits, UZ_PHONE_DIGITS } from "@bayramm/shared";
import type { VendorContactChange, VendorListing } from "@bayramm/shared/api/vendor";
import { ConfirmSheet, Dialog, useToast } from "@bayramm/ui/react";
import { type FormEvent, useId, useRef, useState } from "react";
import { ApiFailure, api } from "./api";
import { PhoneField, TelegramField, telegramProblem } from "./ContactFields";
import { errorText } from "./errors";
import { formatPhone } from "./format";
import { fill, type VendorDict } from "./i18n";
import { useFocusInvalid } from "./invalid";
import { useConfirmLeave, useUnsaved } from "./unsaved";

/** Статусы, где контакты меняются запросом команде (как в базе: moderated_field_requires_revision) */
const MODERATED: ReadonlySet<VendorListing["status"]> = new Set(["review", "active", "suspended"]);

interface Props {
  readonly listing: VendorListing;
  readonly t: VendorDict;
  readonly owner: boolean;
  /** Контакты изменены, отправлены или отозваны: перечитать витрину */
  readonly onChanged: () => Promise<void>;
}

interface FieldErrors {
  readonly phone?: string;
  readonly telegram?: string;
}

/** «+998 90 111 22 33 · @name» — как контакты видит человек */
const valueText = (phone: string | null, telegram: string | null, notSet: string) =>
  [phone ? formatPhone(phone) : null, telegram ? `@${telegram}` : null].filter(Boolean).join(" · ") || notSet;

/** Что вписать в шторку: ждущий запрос, иначе нынешние контакты */
function startValues(listing: VendorListing, pending: VendorContactChange | null) {
  return {
    phone: readUzPhoneDigits(pending?.phone ?? listing.phone ?? "") ?? "",
    telegram: pending ? (pending.telegram ?? "") : (listing.telegram ?? ""),
  };
}

export function VenueContacts({ listing, t, owner, onChanged }: Props) {
  const moderated = MODERATED.has(listing.status);
  const change = listing.contactChange;
  const pending = change?.status === "pending" ? change : null;
  const declined = change?.status === "declined" ? change : null;
  const formId = useId();
  const edit = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [start, setStart] = useState(() => startValues(listing, pending));
  const [phone, setPhone] = useState(start.phone);
  const [telegram, setTelegram] = useState(start.telegram);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [withdrawError, setWithdrawError] = useState<string | null>(null);
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);
  const toast = useToast();
  const form = useRef<HTMLFormElement>(null);
  const showInvalid = useFocusInvalid(form);
  const withdrawButton = useRef<HTMLButtonElement>(null);

  // Вписанное и не отправленное: уход с экрана и закрытие шторки спрашивают «Уйти без сохранения?»
  const dirty = phone !== start.phone || telegram !== start.telegram;
  useUnsaved(open && dirty);
  const confirmLeave = useConfirmLeave();

  // Вопрос и шторка закрываются по очереди (ловушка №11): шторка — следующим тактом
  const close = () => {
    if (!busy) confirmLeave(() => queueMicrotask(() => setOpen(false)));
  };

  const openSheet = () => {
    const next = startValues(listing, pending);
    setStart(next);
    setPhone(next.phone);
    setTelegram(next.telegram);
    setErrors({});
    setFormError(null);
    setOpen(true);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const found: { phone?: string; telegram?: string } = {};
    if (phone.length !== UZ_PHONE_DIGITS) found.phone = t.phoneShort;
    if (telegram !== "" && (telegramProblem(telegram, true, t) || normalizeTelegram(telegram) === null)) {
      found.telegram = telegramProblem(telegram, true, t) ?? t.telegramRule;
    }
    setErrors(found);
    setFormError(null);
    if (Object.keys(found).length > 0) {
      showInvalid();
      return;
    }
    if (!dirty) return;
    setBusy(true);
    try {
      const saved = await api.saveContacts(listing.id, {
        phone: `+998${phone}`,
        telegram: telegram === "" ? null : telegram,
      });
      await onChanged();
      toast(saved.sentForModeration ? t.contactsSent : t.contactsSaved, { tone: "success" });
      setOpen(false);
    } catch (err) {
      if (err instanceof ApiFailure && err.code === "invalid_input") {
        setErrors({
          ...(err.details.includes("phone") ? { phone: t.phoneShort } : {}),
          ...(err.details.includes("telegram") ? { telegram: t.telegramRule } : {}),
        });
        showInvalid();
      } else {
        // Статус витрины успели изменить: перечитать — подпись кнопки и путь станут верными
        if (err instanceof ApiFailure && err.code === "contacts_not_live") await onChanged();
        setFormError(errorText(err, t));
      }
    } finally {
      setBusy(false);
    }
  };

  const withdraw = async () => {
    setConfirmWithdraw(false);
    setWithdrawing(true);
    setWithdrawError(null);
    try {
      await api.withdrawContactChange(listing.id);
    } catch (err) {
      // Уже решили или отозвали — как сейчас
      if (!(err instanceof ApiFailure && err.code === "contact_change_not_pending")) {
        setWithdrawError(errorText(err, t));
        setWithdrawing(false);
        return;
      }
    }
    await onChanged();
    setWithdrawing(false);
    toast(t.contactsWithdrawn, { tone: "success" });
    // Кнопки «Отозвать» больше нет — фокус на «Изменить»
    edit.current?.focus({ preventScroll: true });
  };

  return (
    <section className="panel contacts" aria-labelledby="contacts-title">
      <div className="contacts-head">
        <h3 className="panel-title" id="contacts-title">
          {t.contactsTitle}
        </h3>
        {owner ? (
          <button ref={edit} type="button" className="btn btn-ghost" onClick={openSheet}>
            {t.contactsEdit}
          </button>
        ) : null}
      </div>
      <dl className="contact-rows">
        <div>
          <dt>{t.contactsPhone}</dt>
          <dd className="fact-phone">{listing.phone ? formatPhone(listing.phone) : t.notSet}</dd>
        </div>
        <div>
          <dt>{t.contactsTelegram}</dt>
          <dd>{listing.telegram ? `@${listing.telegram}` : t.notSet}</dd>
        </div>
      </dl>
      {pending ? (
        <div className="contact-pending">
          <span className="chip chip-wait">{t.contactsOnReview}</span>
          {owner ? (
            <>
              <span className="contact-pending-value">
                {fill(t.contactsPendingValue, {
                  value: valueText(pending.phone, pending.telegram, t.notSet),
                })}
              </span>
              <button
                ref={withdrawButton}
                type="button"
                className="btn btn-ghost"
                disabled={withdrawing}
                aria-busy={withdrawing || undefined}
                onClick={() => setConfirmWithdraw(true)}
              >
                {t.contactsWithdraw}
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      {withdrawError ? (
        <p className="form-error" role="alert">
          {withdrawError}
        </p>
      ) : null}
      {declined && !pending ? (
        <p className="note">{fill(t.contactsDeclined, { reason: declined.reason ?? "—" })}</p>
      ) : null}
      <ConfirmSheet
        open={confirmWithdraw}
        title={t.contactsWithdrawQ}
        text={t.contactsWithdrawText}
        confirmLabel={t.contactsWithdraw}
        cancelLabel={t.cancel}
        onConfirm={() => void withdraw()}
        onCancel={() => setConfirmWithdraw(false)}
        returnFocus={withdrawButton}
      />

      {owner ? (
        <Dialog
          open={open}
          title={t.contactsSheetTitle}
          onClose={close}
          returnFocus={edit}
          actions={
            <>
              <button type="button" className="ui-btn ui-btn-secondary" disabled={busy} onClick={close}>
                {t.cancel}
              </button>
              <button
                type="submit"
                form={formId}
                className="ui-btn ui-btn-primary"
                disabled={busy || !dirty}
                aria-busy={busy || undefined}
              >
                {moderated ? t.contactsSend : t.contactsSave}
              </button>
            </>
          }
        >
          <form
            ref={form}
            id={formId}
            className="contacts-form"
            noValidate
            onSubmit={(event) => void submit(event)}
          >
            <PhoneField
              label={t.contactsPhone}
              t={t}
              value={phone}
              onChange={setPhone}
              error={errors.phone}
            />
            <TelegramField
              label={t.contactsTelegramLabel}
              t={t}
              value={telegram}
              onChange={setTelegram}
              error={errors.telegram}
            />
            {moderated ? <p className="note">{t.contactsLiveNote}</p> : null}
            {formError ? (
              <p className="form-error" role="alert">
                {formError}
              </p>
            ) : null}
          </form>
        </Dialog>
      ) : null}
    </section>
  );
}
