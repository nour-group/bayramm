/* Поля телефона и Telegram кабинета — как PhoneField и TelegramField панели (apps/admin/src/fields.tsx):
   «+998» стоит у поля и не стирается, в поле — девять цифр маской «XX XXX XX XX» (вставленный номер
   в любой записи приводится к маске, чужой код — ошибка сразу, неполный — когда ушли из поля);
   «@» у поля Telegram, вставленная ссылка t.me/имя и «@» снимаются сразу. Чистый разбор —
   @bayramm/shared (readUzPhoneDigits, maskUzPhoneDigits, stripTelegram, normalizeTelegram),
   правила те же, что у сервера. Шрифт на телефоне — 16px (иначе iOS увеличивает страницу). */

import {
  maskUzPhoneDigits,
  normalizeTelegram,
  readUzPhoneDigits,
  stripTelegram,
  UZ_PHONE_DIGITS,
} from "@bayramm/shared";
import {
  type ChangeEvent,
  type ClipboardEvent,
  type ReactNode,
  type RefObject,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { VendorDict } from "./i18n";
import { FieldMark } from "./ui";

interface FrameProps {
  readonly label: string;
  /** Пометка у подписи: «обязательно» или «по желанию» */
  readonly required: boolean;
  readonly t: VendorDict;
  readonly error?: string | undefined;
  readonly children: (props: {
    id: string;
    "aria-invalid": boolean;
    "aria-describedby"?: string;
  }) => ReactNode;
}

/** Подпись, поле и ошибка: id и aria-* связаны */
function Frame({ label, required, t, error, children }: FrameProps) {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <div className="form-row">
      <label className="field-label" htmlFor={id}>
        {label} <FieldMark required={required} t={t} />
      </label>
      {children({ id, "aria-invalid": Boolean(error), ...(error ? { "aria-describedby": errorId } : {}) })}
      {error ? (
        <p className="field-error" id={errorId}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Курсор после переформатирования — после той же по счёту цифры, а не в конце поля: иначе
 * правка в середине номера уводит курсор и следующая цифра встаёт не туда
 */
function useDigitCaret(input: RefObject<HTMLInputElement | null>, display: string) {
  const want = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = input.current;
    const digits = want.current;
    want.current = null;
    if (!el || digits === null || el.ownerDocument.activeElement !== el) return;
    let pos = 0;
    for (let seen = 0; pos < display.length && seen < digits; pos++)
      if (/\d/.test(display[pos] ?? "")) seen++;
    try {
      el.setSelectionRange(pos, pos);
    } catch {
      // Старый движок без выделения в этом поле: курсор останется в конце
    }
  });
  return (el: HTMLInputElement) => {
    const at = el.selectionStart ?? el.value.length;
    want.current = el.value.slice(0, at).replace(/\D+/g, "").length;
  };
}

export interface PhoneFieldProps {
  readonly label: string;
  readonly t: VendorDict;
  /** Девять цифр после +998 («901112233»); пусто — номера нет */
  readonly value: string;
  readonly onChange: (digits: string) => void;
  /** Ошибка формы или сервера — важнее своей */
  readonly error?: string | undefined;
  readonly disabled?: boolean;
}

export function PhoneField({ label, t, value, onChange, error, disabled }: PhoneFieldProps) {
  const input = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<"short" | "foreign" | null>(null);
  const digits = readUzPhoneDigits(value) ?? "";
  const display = maskUzPhoneDigits(digits);
  const keepCaret = useDigitCaret(input, display);

  const accept = (raw: string) => {
    const next = readUzPhoneDigits(raw);
    if (next === null) {
      // Лишняя цифра в уже полном номере — не печатается; вставили чужой номер — ошибка
      if (digits.length === UZ_PHONE_DIGITS && !raw.trim().startsWith("+")) return;
      setProblem("foreign");
      return;
    }
    if (problem === "foreign" || next.length === UZ_PHONE_DIGITS || next === "") setProblem(null);
    onChange(next);
  };

  const change = (event: ChangeEvent<HTMLInputElement>) => {
    keepCaret(event.target);
    accept(event.target.value);
  };

  // Вставка целого номера заменяет поле, а не дописывается к набранному
  const paste = (event: ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData?.getData("text") ?? "";
    if (text.replace(/\D+/g, "").length < UZ_PHONE_DIGITS && !text.trim().startsWith("+")) return;
    event.preventDefault();
    accept(text);
  };

  const own = problem === "foreign" ? t.phoneForeign : problem === "short" ? t.phoneShort : undefined;
  return (
    <Frame label={label} required t={t} error={error ?? own}>
      {(props) => (
        <span
          className={`affix${props["aria-invalid"] ? " affix-bad" : ""}${disabled ? " is-disabled" : ""}`}
        >
          <span className="affix-pre" aria-hidden="true">
            +998
          </span>
          <input
            {...props}
            ref={input}
            className="affix-input"
            type="tel"
            inputMode="numeric"
            autoComplete="off"
            placeholder={t.phonePlaceholder}
            value={display}
            disabled={disabled}
            onChange={change}
            onPaste={paste}
            // Неполный — когда ушли из поля; «чужой номер» остаётся, пока не вписали свой
            onBlur={() =>
              setProblem((was) =>
                digits !== "" && digits.length < UZ_PHONE_DIGITS ? "short" : was === "foreign" ? was : null,
              )
            }
          />
        </span>
      )}
    </Frame>
  );
}

/** Что не так с именем Telegram: знаки — сразу, длина и края — когда ушли из поля */
export function telegramProblem(name: string, finished: boolean, t: VendorDict): string | undefined {
  if (name === "") return undefined;
  if (/[^A-Za-z0-9_]/.test(name)) return t.telegramChars;
  if (name.length > 32 || (finished && normalizeTelegram(name) === null)) return t.telegramRule;
  return undefined;
}

export interface TelegramFieldProps {
  readonly label: string;
  readonly t: VendorDict;
  /** Имя без «@» (ссылку и «@» поле снимает само) */
  readonly value: string;
  readonly onChange: (name: string) => void;
  readonly error?: string | undefined;
  readonly disabled?: boolean;
}

export function TelegramField({ label, t, value, onChange, error, disabled }: TelegramFieldProps) {
  const [finished, setFinished] = useState(false);
  return (
    <Frame label={label} required={false} t={t} error={error ?? telegramProblem(value, finished, t)}>
      {(props) => (
        <span
          className={`affix${props["aria-invalid"] ? " affix-bad" : ""}${disabled ? " is-disabled" : ""}`}
        >
          <span className="affix-pre" aria-hidden="true">
            @
          </span>
          <input
            {...props}
            className="affix-input"
            inputMode="text"
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
            placeholder={t.telegramPlaceholder}
            maxLength={64}
            value={value}
            disabled={disabled}
            onChange={(event) => {
              setFinished(false);
              onChange(stripTelegram(event.target.value));
            }}
            onBlur={() => setFinished(true)}
          />
        </span>
      )}
    </Frame>
  );
}
