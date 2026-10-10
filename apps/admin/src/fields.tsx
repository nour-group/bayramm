/* Поля панели под свои данные — вместо голого текстового поля: телефон (+998 и маска
   «XX XXX XX XX»), Telegram («@» и имя без ссылки), деньги (разряды и «сум»), адрес витрины
   (латиница, «из названия»), число с «−» и «+» и границами, выбор одного (сегменты или строки
   с пояснением) и нескольких (чипы).
   Подпись, подсказка и ошибка — та же разметка, что у Field (ui.tsx): id и aria-* связывает
   FieldFrame. Ошибку, которую видно до отправки (неполный номер, не тот знак в имени), поле
   показывает само; ошибку проверки формы или ответа сервера передаёт форма (error) — она
   важнее. Шрифт полей на телефоне — 16px (styles.css), зона нажатия — 44px. Конфигурацию
   категорий модуль не импортирует: границы и подписи приходят пропсами. */

import {
  finishSlug,
  normalizeTelegram,
  normalizeUzPhone,
  SLUG_RE,
  slugFromName,
  stripTelegram,
  typingSlug,
} from "@bayramm/shared";
import { Checkbox, NumberStepper, RadioGroup, type RadioOption } from "@bayramm/ui/react";
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
import { t } from "./texts";

type FrameProps = {
  readonly id: string;
  readonly "aria-invalid": boolean;
  readonly "aria-describedby"?: string;
};

interface FieldFrameProps {
  readonly label: string;
  readonly error?: string | undefined;
  readonly hint?: string | undefined;
  readonly full?: boolean | undefined;
  readonly className?: string;
  readonly children: (props: FrameProps) => ReactNode;
}

/** Подпись, поле, подсказка или ошибка — как Field в ui.tsx */
function FieldFrame({ label, error, hint, full, className, children }: FieldFrameProps) {
  const id = useId();
  const noteId = `${id}-note`;
  const note = error ?? hint;
  return (
    <div
      className={["field", full ? "field-full" : "", error ? "field-bad" : "", className ?? ""]
        .filter(Boolean)
        .join(" ")}
    >
      <label htmlFor={id}>{label}</label>
      {children({ id, "aria-invalid": Boolean(error), ...(note ? { "aria-describedby": noteId } : {}) })}
      {note ? (
        <span id={noteId} className={error ? "field-error" : "field-hint"}>
          {note}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Курсор после переформатирования — после той же по счёту цифры, а не в конце поля: иначе
 * правка в середине номера или суммы уводит курсор и следующая цифра встаёт не туда
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

// ── телефон ────────────────────────────────────────────────────────────────

const UZ_CODE = "+998";
const PHONE_DIGITS = 9;
const PHONE_GROUPS = [2, 3, 2, 2] as const;

/**
 * Цифры после +998 из любой записи: «+998 90 111-22-33», «998901112233», «90 111». Начатый
 * по привычке код («+», «+99») — пусто: код уже написан у поля. Чужой код (+7…) или больше
 * девяти цифр — null: не обрезаем в похожий номер, а говорим «только Узбекистан»
 */
export function readPhone(raw: string): string | null {
  const normal = normalizeUzPhone(raw);
  if (normal) return normal.slice(UZ_CODE.length);
  const text = raw.trim();
  const compact = text.replace(/\s+/g, "");
  if (compact !== "" && UZ_CODE.startsWith(compact)) return "";
  let digits = text.replace(/\D+/g, "");
  if (text.startsWith("+")) {
    if (!digits.startsWith("998")) return null;
    digits = digits.slice(3);
  } else if (digits.length > PHONE_DIGITS && digits.startsWith("998")) {
    // Набирают с кодом страны без «+»: на десятой цифре код уходит, номер остаётся
    digits = digits.slice(3);
  }
  return digits.length > PHONE_DIGITS ? null : digits;
}

/** «901112233» → «90 111 22 33»; неполный — сколько набрано: «90 1» */
export function formatPhone(digits: string): string {
  const parts: string[] = [];
  let at = 0;
  for (const size of PHONE_GROUPS) {
    if (at >= digits.length) break;
    parts.push(digits.slice(at, at + size));
    at += size;
  }
  return parts.join(" ");
}

export interface PhoneFieldProps {
  readonly label: string;
  /** Номер в любой записи; в поле — 9 цифр после +998 */
  readonly value: string;
  /** Только цифры после +998 («901112233»); пусто — номера нет */
  readonly onChange: (digits: string) => void;
  /** Ошибка формы или сервера — важнее своей */
  readonly error?: string | undefined;
  readonly hint?: string | undefined;
  readonly full?: boolean;
  readonly disabled?: boolean;
  readonly readOnly?: boolean;
  readonly enterKeyHint?: "done" | "next" | "send" | "go";
  readonly inputRef?: RefObject<HTMLInputElement | null>;
}

/**
 * Номер Узбекистана: «+998» стоит у поля и не стирается, в поле — девять цифр маской
 * «XX XXX XX XX», клавиатура цифровая. Вставленный номер в любой записи приводится к маске;
 * чужой код — ошибка сразу, неполный — когда ушли из поля
 */
export function PhoneField({
  label,
  value,
  onChange,
  error,
  hint,
  full,
  disabled,
  readOnly,
  enterKeyHint = "done",
  inputRef,
}: PhoneFieldProps) {
  const own = useRef<HTMLInputElement>(null);
  const input = inputRef ?? own;
  const [problem, setProblem] = useState<"short" | "foreign" | null>(null);
  const digits = readPhone(value) ?? "";
  const display = formatPhone(digits);
  const keepCaret = useDigitCaret(input, display);

  const accept = (raw: string) => {
    const next = readPhone(raw);
    if (next === null) {
      // Лишняя цифра в уже полном номере — просто не печатается; вставили чужой номер — ошибка
      if (digits.length === PHONE_DIGITS && !raw.trim().startsWith("+")) return;
      setProblem("foreign");
      return;
    }
    if (problem === "foreign" || next.length === PHONE_DIGITS || next === "") setProblem(null);
    onChange(next);
  };

  const change = (event: ChangeEvent<HTMLInputElement>) => {
    keepCaret(event.target);
    accept(event.target.value);
  };

  // Вставка целого номера заменяет поле, а не дописывается к набранному
  const paste = (event: ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData?.getData("text") ?? "";
    if (text.replace(/\D+/g, "").length < PHONE_DIGITS && !text.trim().startsWith("+")) return;
    event.preventDefault();
    accept(text);
  };

  const ownError =
    problem === "foreign" ? t.input.phoneForeign : problem === "short" ? t.input.phoneShort : undefined;
  return (
    <FieldFrame label={label} error={error ?? ownError} hint={hint} full={full}>
      {(props) => (
        <span className={`affix${disabled ? " is-disabled" : ""}`}>
          <span className="affix-pre" aria-hidden="true">
            {UZ_CODE}
          </span>
          <input
            {...props}
            ref={input}
            className="input affix-input"
            type="tel"
            inputMode="numeric"
            autoComplete="off"
            placeholder={t.input.phonePlaceholder}
            value={display}
            disabled={disabled}
            readOnly={readOnly}
            enterKeyHint={enterKeyHint}
            onChange={change}
            onPaste={paste}
            // Неполный — когда ушли из поля; «чужой номер» остаётся, пока не вписали свой
            onBlur={() =>
              setProblem((was) =>
                digits !== "" && digits.length < PHONE_DIGITS ? "short" : was === "foreign" ? was : null,
              )
            }
          />
        </span>
      )}
    </FieldFrame>
  );
}

// ── Telegram ───────────────────────────────────────────────────────────────

export interface TelegramFieldProps {
  readonly label: string;
  /** Имя без «@» (ссылку и «@» поле снимает само) */
  readonly value: string;
  readonly onChange: (name: string) => void;
  readonly error?: string | undefined;
  readonly hint?: string | undefined;
  readonly full?: boolean;
  readonly disabled?: boolean;
  readonly readOnly?: boolean;
  readonly enterKeyHint?: "done" | "next" | "send" | "go";
}

/** Что не так с именем Telegram: знаки — сразу, длина и края — когда ушли из поля */
export function telegramProblem(name: string, finished: boolean): string | undefined {
  if (name === "") return undefined;
  if (/[^A-Za-z0-9_]/.test(name)) return t.input.telegramChars;
  if (name.length > 32 || (finished && normalizeTelegram(name) === null)) return t.input.telegramRule;
  return undefined;
}

/**
 * Имя пользователя или канала Telegram: «@» стоит у поля, вставленная ссылка
 * https://t.me/имя и «@» снимаются сразу — в поле остаётся имя. Правила Telegram (5–32 знака,
 * латиница, цифры и «_») — те же, что у сервера (normalizeTelegram из @bayramm/shared)
 */
export function TelegramField({
  label,
  value,
  onChange,
  error,
  hint,
  full,
  disabled,
  readOnly,
  enterKeyHint = "done",
}: TelegramFieldProps) {
  const [finished, setFinished] = useState(false);
  const problem = telegramProblem(value, finished);
  return (
    <FieldFrame label={label} error={error ?? problem} hint={hint} full={full}>
      {(props) => (
        <span className={`affix${disabled ? " is-disabled" : ""}`}>
          <span className="affix-pre" aria-hidden="true">
            @
          </span>
          <input
            {...props}
            className="input affix-input"
            inputMode="text"
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
            placeholder={t.input.telegramPlaceholder}
            maxLength={64}
            value={value}
            disabled={disabled}
            readOnly={readOnly}
            enterKeyHint={enterKeyHint}
            onChange={(event) => {
              setFinished(false);
              onChange(stripTelegram(event.target.value));
            }}
            onBlur={() => setFinished(true)}
          />
        </span>
      )}
    </FieldFrame>
  );
}

// ── деньги ─────────────────────────────────────────────────────────────────

/** Узкий неразрывный пробел между разрядами: сумма не переносится и не путается с двумя числами */
const THIN = " ";

/** Только цифры, без ведущих нулей и не длиннее предела */
export function moneyDigits(raw: string, maxDigits: number): string {
  return raw
    .replace(/\D+/g, "")
    .replace(/^0+(?=\d)/, "")
    .slice(0, maxDigits);
}

/** «1500000» → «1 500 000» (разряды — узким неразрывным пробелом) */
export function formatMoney(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, THIN);
}

export interface MoneyFieldProps {
  readonly label: string;
  /** Сумма в сумах: цифры (пробелы и разряды допустимы — поле их уберёт) */
  readonly value: string;
  /** Только цифры: «1500000» */
  readonly onChange: (digits: string) => void;
  readonly max: number;
  readonly error?: string | undefined;
  readonly hint?: string | undefined;
  readonly full?: boolean;
  readonly disabled?: boolean;
}

/** Цена в сумах: только цифры, разряды — по мере набора, «сум» — у поля, не больше max */
export function MoneyField({ label, value, onChange, max, error, hint, full, disabled }: MoneyFieldProps) {
  const input = useRef<HTMLInputElement>(null);
  const maxDigits = String(max).length;
  const digits = moneyDigits(value, maxDigits);
  const display = formatMoney(digits);
  const keepCaret = useDigitCaret(input, display);
  const over = digits !== "" && Number(digits) > max ? t.input.moneyMax(formatMoney(String(max))) : undefined;
  return (
    <FieldFrame label={label} error={error ?? over} hint={hint} full={full}>
      {(props) => (
        <span className={`affix${disabled ? " is-disabled" : ""}`}>
          <input
            {...props}
            ref={input}
            className="input affix-input money-input"
            inputMode="numeric"
            autoComplete="off"
            enterKeyHint="done"
            // Разрядов на треть больше цифр: пробелы не съедают место под цифры
            maxLength={maxDigits + Math.floor((maxDigits - 1) / 3)}
            value={display}
            disabled={disabled}
            onChange={(event) => {
              keepCaret(event.target);
              onChange(moneyDigits(event.target.value, maxDigits));
            }}
          />
          <span className="affix-post" aria-hidden="true">
            {t.input.sum}
          </span>
        </span>
      )}
    </FieldFrame>
  );
}

// ── адрес витрины ──────────────────────────────────────────────────────────

export interface SlugFieldProps {
  readonly label: string;
  readonly value: string;
  readonly onChange: (slug: string) => void;
  /** Название, из которого собрать адрес кнопкой «Из названия» */
  readonly source?: string;
  readonly error?: string | undefined;
  readonly readOnly?: boolean;
}

/**
 * Адрес витрины на сайте: «…/venue/» у поля, в поле — только латиница, цифры и дефис
 * (кириллица — латиницей, пробел — дефисом, по мере набора); 3–40 знаков — когда ушли из поля.
 * «Из названия» собирает адрес так же, как сервер для новой витрины
 */
export function SlugField({ label, value, onChange, source, error, readOnly }: SlugFieldProps) {
  const [finished, setFinished] = useState(false);
  const own = finished && !SLUG_RE.test(value) ? t.listingFieldErrors.slug : undefined;
  const fromName = source === undefined ? "" : slugFromName(source);
  return (
    <FieldFrame label={label} error={error ?? own} hint={t.input.slugHint} full>
      {(props) => (
        <span className="slug-row">
          <span className="affix">
            <span className="affix-pre" aria-hidden="true">
              {t.input.slugPrefix}
            </span>
            <input
              {...props}
              className="input affix-input"
              autoCapitalize="none"
              autoComplete="off"
              spellCheck={false}
              enterKeyHint="done"
              maxLength={40}
              value={value}
              readOnly={readOnly}
              onChange={(event) => {
                setFinished(false);
                onChange(typingSlug(event.target.value));
              }}
              onBlur={() => {
                setFinished(true);
                const done = finishSlug(value);
                if (done !== value) onChange(done);
              }}
            />
          </span>
          {readOnly || source === undefined ? null : (
            <button
              type="button"
              className="btn btn-sm"
              disabled={!SLUG_RE.test(fromName) || fromName === value}
              onClick={() => {
                setFinished(true);
                onChange(fromName);
              }}
            >
              {t.input.slugFromName}
            </button>
          )}
        </span>
      )}
    </FieldFrame>
  );
}

// ── число ──────────────────────────────────────────────────────────────────

/** Сколько цифр у числа: предел длины поля */
export const digitsOf = (n: number): number => String(Math.max(0, Math.trunc(n))).length;

export interface NumberFieldProps {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly min: number;
  readonly max: number;
  readonly step?: number;
  /** Единица после поля: «ч», «мин», «дн.» */
  readonly unit?: string | undefined;
  /** Своя подсказка — после границ: «от 1 до 20 · обязательно» */
  readonly hint?: string | undefined;
  readonly error?: string | undefined;
  readonly full?: boolean;
  readonly disabled?: boolean;
  readonly className?: string;
}

/**
 * Целое число: поле с цифровой клавиатурой и «−»/«+» (NumberStepper), границы видны заранее —
 * подсказкой под полем, а не только в ошибке; «−» и «+» за границы не уводят
 */
export function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  unit,
  hint,
  error,
  full,
  disabled,
  className,
}: NumberFieldProps) {
  const range = t.input.range(min, max);
  return (
    <FieldFrame
      label={label}
      error={error}
      hint={hint ? `${range} · ${hint}` : range}
      full={full}
      className={className}
    >
      {(props) => (
        <span className="num-row">
          <NumberStepper
            {...props}
            value={value}
            onChange={onChange}
            min={min}
            max={max}
            step={step}
            maxLength={digitsOf(max)}
            disabled={disabled}
            decrementLabel={`${label}: ${t.input.less}`}
            incrementLabel={`${label}: ${t.input.more}`}
          />
          {unit ? (
            <span className="num-unit" aria-hidden="true">
              {unit}
            </span>
          ) : null}
        </span>
      )}
    </FieldFrame>
  );
}

// ── выбор ──────────────────────────────────────────────────────────────────

export interface ChoiceFieldProps<V extends string> {
  readonly label: string;
  readonly value: V | null;
  readonly options: readonly RadioOption<V>[];
  readonly onChange: (value: V) => void;
  /** segmented — короткие варианты одной дорожкой; row — строки с пояснением; pill — пилюли */
  readonly variant?: "segmented" | "row" | "pill";
  readonly hint?: string | undefined;
  readonly error?: string | undefined;
  readonly full?: boolean;
  readonly disabled?: boolean;
}

/** Один из вариантов — сразу на виду, без списка: подпись, варианты, подсказка или ошибка */
export function ChoiceField<V extends string>({
  label,
  value,
  options,
  onChange,
  variant = "segmented",
  hint,
  error,
  full = true,
  disabled,
}: ChoiceFieldProps<V>) {
  const id = useId();
  const note = error ?? hint;
  return (
    <div
      className={["field", "choice-field", full ? "field-full" : "", error ? "field-bad" : ""]
        .filter(Boolean)
        .join(" ")}
    >
      <span id={`${id}-label`}>{label}</span>
      <RadioGroup
        variant={variant}
        className={`choice choice-${variant}`}
        aria-labelledby={`${id}-label`}
        aria-describedby={note ? `${id}-note` : undefined}
        aria-invalid={Boolean(error)}
        id={`${id}-first`}
        name={id}
        value={value}
        options={options}
        onChange={onChange}
        disabled={disabled}
      />
      {note ? (
        <span id={`${id}-note`} className={error ? "field-error" : "field-hint"}>
          {note}
        </span>
      ) : null}
    </div>
  );
}

export interface ChipsFieldProps {
  readonly label: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
  readonly value: readonly string[];
  readonly onChange: (value: string[]) => void;
  readonly hint?: string | undefined;
  readonly error?: string | undefined;
  readonly disabled?: boolean;
}

/**
 * Несколько вариантов — чипами: под рисунком настоящая галочка (Checkbox набора), выбранный
 * чип залит. Порядок выбранных — как в списке вариантов, а не как нажимали
 */
export function ChipsField({ label, options, value, onChange, hint, error, disabled }: ChipsFieldProps) {
  const noteId = useId();
  const note = error ?? hint;
  const toggle = (code: string, on: boolean) =>
    onChange(options.map((o) => o.value).filter((v) => (v === code ? on : value.includes(v))));
  return (
    <fieldset
      className={`chips-field field-full${error ? " field-bad" : ""}`}
      aria-describedby={note ? noteId : undefined}
    >
      <legend>{label}</legend>
      {note ? (
        <p id={noteId} className={error ? "field-error" : "field-hint"}>
          {note}
        </p>
      ) : null}
      <div className="chip-checks">
        {options.map((option) => (
          <Checkbox
            key={option.value}
            className="chip-check"
            checked={value.includes(option.value)}
            disabled={disabled}
            aria-invalid={Boolean(error)}
            onChange={(on) => toggle(option.value, on)}
          >
            {option.label}
          </Checkbox>
        ))}
      </div>
    </fieldset>
  );
}
