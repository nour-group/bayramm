/* Форма витрины (карточки): название, адрес страницы, район, тексты на двух языках, данные
   витрины по категории, ссылки на видео, телефон и Telegram для клиентов. Сколько заказов
   одновременно — в «Время работы» (WorkingTimes.tsx): это часть календаря.
   Что спрашивать — решает категория (@bayramm/shared/categories): вместимость в гостях —
   только где она нужна (площадка), видео — где их можно (фото и видео, студия).

   Форма — не один блок, а состояние на всю страницу (ListingEditor) и её части, которые страница
   расставляет по порядку работы: «Основное» и описания (MainSection), «Данные витрины» с видео
   (DataSection), «Контакты» (ContactsSection), «Сохранить» — одна на всё (EditorBar). У каждой части свой <form> с тем же
   обработчиком: между ними — фото, услуги и занятость, у которых свои формы, а форма в форме
   нельзя. Отправка одна: уходит только изменённое во всех частях сразу.

   Цены — в услугах витрины (Services.tsx): цена «от» считается из них, руками не задаётся.
   Опубликованную витрину менеджер (без права решать по правкам) меняет как партнёр из
   кабинета: название и описания уходят правкой на модерацию, а витрина остаётся прежней —
   форма говорит «отправлено на модерацию» и показывает то, что в витрине сейчас. Остальное
   (адрес, данные витрины, видео, телефон…) сохраняется сразу.
   Контакты — строка на канал: скрытое значение, «Показать» (одним чтением оба — одна запись в
   журнале доступа к ПДн), «Изменить» (строка становится полем), «…» — убрать. Убрать телефон
   можно, только пока витрина не на проверке и не в каталоге (без телефона её не опубликовать —
   так же решает база); Telegram уходит вместе с ним: он хранится рядом. Убранное — отметка
   до «Сохранить», «Вернуть» её снимает. Telegram — по желанию: пустое поле не меняет; имя,
   @имя и ссылку t.me/имя сервер понимает сам.
   Поля — под свои данные (fields.tsx): адрес страницы — строкой «…/venue/имя» с «Изменить»
   (поле открывается там, где его правят), район — списком по городам, вместимость — парой чисел
   «от» и «до», телефон — +998 и маской, Telegram — с «@». */

import { formatUzPhone, normalizeTelegram, normalizeUzPhone, SLUG_RE } from "@bayramm/shared";
import type {
  ListingDetail,
  ListingInput,
  ListingSaveResult,
  RevealedListingContacts,
  RevisionField,
  StaffDictionaries,
} from "@bayramm/shared/api/staff";
import {
  type AttributeDraft,
  type AttributeDrafts,
  attributeDrafts,
  attributeErrors,
  attributeLabel,
  attributePatch,
  attributesOf,
  attributeText,
  type CategoryConfig,
  draftValue,
  missingAttributes,
  parseAmount,
  videoLinkErrors,
  videoLinksValue,
} from "@bayramm/shared/categories";
import { RadioGroup, Select, type SelectOption, useOptionalToast } from "@bayramm/ui/react";
import {
  createContext,
  type FormEvent,
  Fragment,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type { Failure, Result } from "../api";
import { useDraft } from "../drafts";
import { NumberField, PhoneField, SlugField, TelegramField } from "../fields";
import { usePhone } from "../layout";
import { apiErrorText, t } from "../texts";
import { busyLabel, ErrorText, Field, FormBar, fieldErrors, OverflowMenu, revealFirstError } from "../ui";
import { useUnsaved } from "../unsaved";
import { AttributeFields } from "./AttributeFields";

interface Values {
  name: string;
  slug: string;
  districtCode: string;
  addressRu: string;
  addressUz: string;
  descriptionRu: string;
  descriptionUz: string;
  capMin: string;
  capMax: string;
  phone: string;
  telegram: string;
}

const TEXT_KEYS = ["name", "addressRu", "addressUz", "descriptionRu", "descriptionUz"] as const;
const CAP_KEYS = ["capMin", "capMax"] as const;
/** Поля тела запроса, которые у опубликованной витрины меняет только модерация */
const MODERATED_KEYS: ReadonlySet<string> = new Set<RevisionField>([
  "name",
  "descriptionRu",
  "descriptionUz",
]);

/** Вместимость в гостях — границы сервера (capMin, capMax) */
export const CAPACITY = { min: 1, max: 5000 } as const;

/** Что спрашивает форма у этой категории */
export function formParts(category: CategoryConfig) {
  return {
    // Район — только у категорий, где он есть (зал, студия): у кортежа и тортов его нет
    district: category.listingFields.includes("district"),
    capacity: category.listingFields.includes("guest_capacity"),
    videos: category.maxVideoLinks > 0,
  };
}

function initial(listing: ListingDetail): Values {
  return {
    name: listing.name,
    slug: listing.slug,
    districtCode: listing.districtCode ?? "",
    addressRu: listing.addressRu ?? "",
    addressUz: listing.addressUz ?? "",
    descriptionRu: listing.descriptionRu ?? "",
    descriptionUz: listing.descriptionUz ?? "",
    capMin: listing.capMin?.toString() ?? "",
    capMax: listing.capMax?.toString() ?? "",
    phone: "",
    telegram: "",
  };
}

/** Ссылки на видео в форму: сохранённые и пустое поле для новой, если ещё можно */
function videoDrafts(listing: ListingDetail, category: CategoryConfig): string[] {
  return listing.videoLinks.length < category.maxVideoLinks
    ? [...listing.videoLinks, ""]
    : [...listing.videoLinks];
}

export interface FormState {
  readonly values: Values;
  readonly attributes: AttributeDrafts;
  readonly videos: readonly string[];
  /** «Убрать Telegram»: в тело уйдёт telegram: null */
  readonly clearTelegram: boolean;
  /** «Убрать телефон»: в тело уйдёт phone: null (Telegram уйдёт вместе с ним) */
  readonly clearPhone: boolean;
}

export function formState(listing: ListingDetail, category: CategoryConfig): FormState {
  return {
    values: initial(listing),
    attributes: attributeDrafts(category, listing.attributes),
    videos: videoDrafts(listing, category),
    clearTelegram: false,
    clearPhone: false,
  };
}

/** Число из поля: пусто — null, не число — строкой как есть (сервер назовёт поле, а не очистит его) */
function amount(value: string): number | string | null {
  const n = parseAmount(value);
  return n === null ? null : Number.isNaN(n) ? value.trim() : n;
}

/** Тело правки: только изменённое против того, что было загружено (before) */
export function listingBody(category: CategoryConfig, now: FormState, before: FormState): ListingInput {
  const parts = formParts(category);
  const body: Record<string, unknown> = {};
  const changed = (key: keyof Values) => now.values[key].trim() !== before.values[key].trim();
  for (const key of TEXT_KEYS) {
    if (!changed(key)) continue;
    const value = now.values[key].trim();
    body[key] = value === "" ? null : value;
  }
  if (parts.capacity) for (const key of CAP_KEYS) if (changed(key)) body[key] = amount(now.values[key]);
  if (now.values.districtCode !== before.values.districtCode)
    body.districtCode = now.values.districtCode || null;
  const slug = now.values.slug.trim();
  if (slug !== "" && slug !== before.values.slug) body.slug = slug;
  // Убрать телефон — убрать и Telegram (строка контактов одна): вписанное в поля не уходит
  if (now.clearPhone) body.phone = null;
  else {
    const phone = now.values.phone.trim();
    if (phone !== "") body.phone = normalizeUzPhone(phone) ?? phone;
    // Telegram: убрать — null; иначе только то, что вписали (как есть: имя, @имя или ссылку — разберёт сервер)
    if (now.clearTelegram) body.telegram = null;
    else if (now.values.telegram.trim() !== "") body.telegram = now.values.telegram.trim();
  }
  const attributes = attributePatch(category, now.attributes, before.attributes);
  if (Object.keys(attributes).length > 0) body.attributes = attributes;
  if (parts.videos) {
    const links = videoLinksValue(now.videos);
    if (JSON.stringify(links) !== JSON.stringify(videoLinksValue(before.videos))) body.videoLinks = links;
  }
  return body as ListingInput;
}

/** Ошибки до отправки — те же пути, что ответ 422: адрес, вместимость, данные витрины, видео,
 *  телефон и Telegram */
export function formErrors(category: CategoryConfig, now: FormState): string[] {
  const parts = formParts(category);
  const errors = attributeErrors(category, now.attributes);
  if (!SLUG_RE.test(now.values.slug.trim())) errors.push("slug");
  if (parts.capacity) {
    const [min, max] = CAP_KEYS.map((key) => parseAmount(now.values[key]));
    for (const [key, n] of [
      ["capMin", min],
      ["capMax", max],
    ] as const)
      if (n !== null && n !== undefined && (Number.isNaN(n) || n < CAPACITY.min || n > CAPACITY.max))
        errors.push(key);
    // «До» меньше «от» — ошибка у «до»: её и поправят
    if (typeof min === "number" && typeof max === "number" && max < min && !errors.includes("capMax"))
      errors.push("capMax");
  }
  const phone = now.values.phone.trim();
  if (!now.clearPhone && phone !== "" && normalizeUzPhone(phone) === null) errors.push("phone");
  const telegram = now.values.telegram.trim();
  if (!now.clearPhone && !now.clearTelegram && telegram !== "" && normalizeTelegram(telegram) === null)
    errors.push("telegram");
  if (parts.videos) {
    // Номер поля формы → номер в отправленном списке (пустые поля не отправляются)
    const filled = now.videos.flatMap((link, index) => (link.trim() === "" ? [] : [index]));
    for (const index of videoLinkErrors(category, now.videos))
      errors.push(`videoLinks.${filled.indexOf(index)}`);
  }
  return errors;
}

// ── свежая версия поверх вписанного ────────────────────────────────────────

/** Поле, которое поменяли и здесь, и в свежей версии (по-разному): выбрать «ваш» или «новый» */
export interface Conflict {
  readonly key: string;
  readonly label: string;
  readonly mine: string;
  readonly theirs: string;
}

/** Часть формы для сверки: значение для сравнения, текст для выбора, перенос значения */
interface Unit {
  readonly key: string;
  readonly label: string;
  readonly of: (state: FormState) => string;
  readonly text: (state: FormState) => string;
  readonly take: (into: FormState, from: FormState) => FormState;
}

const REBASE_KEYS = [
  "name",
  "slug",
  "districtCode",
  "addressRu",
  "addressUz",
  "descriptionRu",
  "descriptionUz",
  "capMin",
  "capMax",
] as const;

function unitsOf(category: CategoryConfig, district: (code: string) => string): Unit[] {
  const values = REBASE_KEYS.map(
    (key): Unit => ({
      key,
      label: t.listingFields[key] ?? key,
      of: (state) => state.values[key].trim(),
      text: (state) => {
        const value = state.values[key].trim();
        return (key === "districtCode" && value !== "" ? district(value) : value) || t.none;
      },
      take: (into, from) => ({ ...into, values: { ...into.values, [key]: from.values[key] } }),
    }),
  );
  const attributes = category.attributes.map(
    (field): Unit => ({
      key: `attributes.${field.key}`,
      label: attributeLabel("ru", category, field.key),
      of: (state) => JSON.stringify(draftValue(field, state.attributes[field.key])) ?? "",
      text: (state) =>
        attributeText("ru", field, draftValue(field, state.attributes[field.key]), t.yes) ?? t.none,
      take: (into, from) => ({
        ...into,
        attributes: { ...into.attributes, [field.key]: from.attributes[field.key] as AttributeDraft },
      }),
    }),
  );
  const videos: Unit = {
    key: "videoLinks",
    label: t.revisionFields.videoLinks ?? "videoLinks",
    of: (state) => JSON.stringify(videoLinksValue(state.videos)),
    text: (state) => videoLinksValue(state.videos).join(", ") || t.none,
    take: (into, from) => ({ ...into, videos: from.videos }),
  };
  return [...values, ...attributes, ...(category.maxVideoLinks > 0 ? [videos] : [])];
}

/**
 * Свежая версия витрины поверх вписанного: что поменяли здесь — остаётся, остальное — из свежей
 * версии; поле, которое поменяли и здесь, и там (по-разному), — в conflicts: по умолчанию ваш
 * вариант, «новый» — выбором. Телефон и Telegram вписываются заново и остаются как есть
 */
export function rebase(
  category: CategoryConfig,
  before: FormState,
  now: FormState,
  fresh: FormState,
  district: (code: string) => string = (code) => code,
): { now: FormState; conflicts: Conflict[] } {
  let next = now;
  const conflicts: Conflict[] = [];
  for (const unit of unitsOf(category, district)) {
    const mine = unit.of(now);
    if (mine === unit.of(before)) {
      next = unit.take(next, fresh);
      continue;
    }
    const theirs = unit.of(fresh);
    if (theirs !== unit.of(before) && theirs !== mine)
      conflicts.push({ key: unit.key, label: unit.label, mine: unit.text(now), theirs: unit.text(fresh) });
  }
  return { now: next, conflicts };
}

/** Выбрали «ваш вариант» или «новый» у поля из conflicts */
export function pick(category: CategoryConfig, state: FormState, key: string, from: FormState): FormState {
  const unit = unitsOf(category, (code) => code).find((u) => u.key === key);
  return unit ? unit.take(state, from) : state;
}

interface ContactsProps {
  readonly hasPhone: boolean;
  readonly hasTelegram: boolean;
  readonly load: () => Promise<Result<RevealedListingContacts>>;
}

export interface ListingEditorProps {
  listing: ListingDetail;
  category: CategoryConfig;
  dictionaries: StaffDictionaries | null;
  /** Ответ сервера: ошибка или витрина после правки (и какие поля ушли на модерацию) */
  onSubmit: (body: ListingInput) => Promise<Failure | ListingSaveResult>;
  readOnly?: boolean;
  /** Название и описания уйдут на модерацию — подсказать у этих полей */
  moderated?: boolean;
  /** Есть несохранённые правки (true) или форма как в витрине (false) */
  onDirtyChange?: (dirty: boolean) => void;
  /** Контакты для клиентов: что вписано и как показать (чтение пишется в журнал доступа к ПДн) */
  contacts?: ContactsProps;
  /**
   * Свежая витрина с сервера (её же получает страница): «Показать свежую версию», когда витрину
   * изменили, пока здесь вписывали. Вписанное остаётся
   */
  refresh?: () => Promise<Result<ListingDetail>>;
  children: ReactNode;
}

/** Черновик формы во вкладке (drafts.ts): от чего начинали и что вписали */
interface StoredForm {
  readonly before: FormState;
  readonly now: FormState;
}

const isFormState = (value: unknown): value is FormState => {
  const state = value as Partial<FormState> | null;
  return (
    typeof state === "object" &&
    state !== null &&
    typeof state.values === "object" &&
    state.values !== null &&
    REBASE_KEYS.every(
      (key) => typeof (state.values as unknown as Record<string, unknown>)[key] === "string",
    ) &&
    typeof state.attributes === "object" &&
    Array.isArray(state.videos)
  );
};

const isStoredForm = (value: unknown): value is StoredForm =>
  typeof value === "object" &&
  value !== null &&
  isFormState((value as { before?: unknown }).before) &&
  isFormState((value as { now?: unknown }).now);

/** Свежая версия легла поверх вписанного: что выбрать в полях, которые поменяли и там, и здесь */
interface Rebased {
  readonly mine: FormState;
  readonly fresh: FormState;
  readonly conflicts: readonly Conflict[];
  readonly picks: Readonly<Record<string, "mine" | "theirs">>;
}

/** Что ушло на модерацию и было ли в правке что-то ещё (оно сохранено сразу) */
interface Sent {
  readonly fields: readonly RevisionField[];
  readonly rest: boolean;
}

const invalid = (details: string[]): Failure => ({ ok: false, status: 422, code: "invalid_input", details });

/** «До» меньше «от»: ошибка вместимости — про порядок, а не про границы */
function capOrderBroken(now: FormState): boolean {
  const min = parseAmount(now.values.capMin);
  const max = parseAmount(now.values.capMax);
  return typeof min === "number" && typeof max === "number" && max < min;
}

/**
 * Районы списком по городам: город — заголовок группы (выбрать нельзя: витрина — в районе),
 * районы — вложенными под ним. Район без города в справочнике — в конце списка
 */
export function districtChoices(dictionaries: StaffDictionaries | null): SelectOption[] {
  const districts = dictionaries?.districts ?? [];
  const cities = dictionaries?.cities ?? [];
  const known = new Set(cities.map((city) => city.code));
  return [
    { value: "", label: t.none },
    ...cities.flatMap((city) => {
      const inside = districts.filter((district) => district.city === city.code);
      return inside.length === 0
        ? []
        : [
            { value: `city:${city.code}`, label: city.nameRu, disabled: true },
            ...inside.map((district) => ({ value: district.code, label: district.nameRu, nested: true })),
          ];
    }),
    ...districts
      .filter((district) => district.city === undefined || !known.has(district.city))
      .map((district) => ({ value: district.code, label: district.nameRu })),
  ];
}

// ── состояние формы на всю страницу ────────────────────────────────────────

interface Editor {
  readonly category: CategoryConfig;
  readonly dictionaries: StaffDictionaries | null;
  readonly readOnly: boolean;
  readonly moderatedHint: string | undefined;
  readonly contacts: ContactsProps | undefined;
  readonly now: FormState;
  readonly setNow: (update: (prev: FormState) => FormState) => void;
  readonly parts: ReturnType<typeof formParts>;
  readonly errors: Record<string, string>;
  readonly details: readonly string[];
  readonly failure: Failure | null;
  readonly formId: string;
  readonly saves: number;
  readonly dirty: boolean;
  readonly busy: boolean;
  readonly saved: boolean;
  readonly sent: Sent | null;
  readonly missing: readonly string[];
  readonly phoneRemovable: boolean;
  /** Витрину изменили, пока здесь вписывали: показать свежую версию поверх вписанного */
  readonly showFresh: (() => Promise<void>) | null;
  readonly refreshing: boolean;
  readonly rebased: Rebased | null;
  readonly choose: (key: string, side: "mine" | "theirs") => void;
  readonly put: (key: keyof Values) => (value: string) => void;
  readonly set: (key: keyof Values) => (event: { target: { value: string } }) => void;
  readonly submit: (event: FormEvent) => Promise<void>;
}

const EditorContext = createContext<Editor | null>(null);

function useEditor(): Editor {
  const editor = useContext(EditorContext);
  if (editor === null) throw new Error("ListingEditor: часть формы вне ListingEditor");
  return editor;
}

/** Состояние формы витрины и сохранение; части формы — ниже, их расставляет страница */
export function ListingEditor({
  listing,
  category,
  dictionaries,
  onSubmit,
  readOnly = false,
  moderated = false,
  onDirtyChange,
  contacts,
  refresh,
  children,
}: ListingEditorProps) {
  const [before, setBefore] = useState(() => formState(listing, category));
  const [now, setNowState] = useState(before);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [rebased, setRebased] = useState<Rebased | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [sent, setSent] = useState<Sent | null>(null);
  // Сколько раз сохранили: открытые контакты после правки закрываются — новое чтение, новая запись в журнале
  const [saves, setSaves] = useState(0);
  const parts = formParts(category);
  const errors = fieldErrors(failure, t.listingFieldErrors);
  const details = failure?.code === "invalid_input" ? failure.details : [];
  const moderatedHint = moderated && !readOnly ? t.moderatedHint : undefined;
  const formId = useId();
  const dirty = !readOnly && Object.keys(listingBody(category, now, before)).length > 0;
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  // Вписанное и не сохранённое — уход переспросит
  useUnsaved(dirty);
  // Первое поле с ошибкой — в видимую часть: частей формы несколько, ищем по всей странице
  useEffect(() => {
    if (failure?.code === "invalid_input") revealFirstError(document.querySelector(".listing-page"));
  }, [failure]);
  // Чего не хватает для публикации — по тому, что сейчас в форме
  const missing = missingAttributes(category, attributesOf(category, now.attributes));
  // Телефон снимается, только пока витрина не на проверке и не в каталоге (иначе её не опубликовать)
  const phoneRemovable =
    Boolean(contacts?.hasPhone) && listing.status !== "review" && listing.status !== "active";

  // Любая новая правка — старое «Сохранено» или «Отправлено» уже не про неё
  const setNow = useCallback((update: (prev: FormState) => FormState) => {
    setSaved(false);
    setSent(null);
    setNowState(update);
  }, []);
  const put = (key: keyof Values) => (value: string) =>
    setNow((prev) => ({ ...prev, values: { ...prev.values, [key]: value } }));
  const set = (key: keyof Values) => (event: { target: { value: string } }) => put(key)(event.target.value);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const found = formErrors(category, now);
    if (found.length > 0) {
      setFailure(invalid(found));
      return;
    }
    setBusy(true);
    const body = listingBody(category, now, before);
    const result = await onSubmit(body);
    setBusy(false);
    if ("ok" in result) {
      setFailure(result);
      return;
    }
    setFailure(null);
    setRebased(null);
    setSaves((n) => n + 1);
    // Форма — как в витрине после правки: значения уже в том виде, как их хранит сервер
    const next = formState(result, category);
    setBefore(next);
    setNowState(next);
    if (result.sentForModeration.length > 0) {
      setSaved(false);
      setSent({
        fields: result.sentForModeration,
        rest: Object.keys(body).some((key) => !MODERATED_KEYS.has(key)),
      });
      return;
    }
    setSent(null);
    setSaved(true);
  };

  // Свежая версия поверх вписанного: ваше остаётся, чужое подтягивается, общее — на выбор
  const districtName = (code: string) =>
    dictionaries?.districts.find((district) => district.code === code)?.nameRu ?? code;
  const showFresh = refresh
    ? async () => {
        setRefreshing(true);
        const result = await refresh();
        setRefreshing(false);
        if (!result.ok) {
          setFailure(result);
          return;
        }
        const fresh = formState(result.data, category);
        const merged = rebase(category, before, now, fresh, districtName);
        setFailure(null);
        setBefore(fresh);
        setNowState(merged.now);
        setRebased(
          merged.conflicts.length > 0 ? { mine: now, fresh, conflicts: merged.conflicts, picks: {} } : null,
        );
      }
    : null;
  // Сессия кончилась посреди правки: вписанное — во вкладку (drafts.ts); вернулись после входа —
  // оно поверх свежей витрины, общее с чужими правками — на выбор, как после «свежей версии»
  const toast = useOptionalToast();
  useDraft<StoredForm>(`listing:${listing.id}`, { before, now }, dirty, (draft) => {
    if (!isStoredForm(draft)) return false;
    const merged = rebase(category, draft.before, draft.now, before, districtName);
    setNowState(merged.now);
    if (merged.conflicts.length > 0)
      setRebased({ mine: draft.now, fresh: before, conflicts: merged.conflicts, picks: {} });
    toast?.(t.draftRestored, { tone: "info", duration: 8000 });
    return true;
  });
  const choose = (key: string, side: "mine" | "theirs") => {
    if (!rebased) return;
    setRebased({ ...rebased, picks: { ...rebased.picks, [key]: side } });
    setNow((prev) => pick(category, prev, key, side === "mine" ? rebased.mine : rebased.fresh));
  };

  const editor: Editor = {
    category,
    dictionaries,
    readOnly,
    moderatedHint,
    contacts,
    now,
    setNow,
    parts,
    errors,
    details,
    failure,
    formId,
    saves,
    dirty,
    busy,
    saved,
    sent,
    missing,
    phoneRemovable,
    showFresh,
    refreshing,
    rebased,
    choose,
    put,
    set,
    submit,
  };
  return <EditorContext.Provider value={editor}>{children}</EditorContext.Provider>;
}

// ── основное и описания ────────────────────────────────────────────────────

/** Адрес страницы — строкой «…/venue/имя» с «Изменить»; ошибка или правка — поле на месте строки */
function SlugLine() {
  const { now, put, errors, readOnly } = useEditor();
  const [editing, setEditing] = useState(false);
  const field = useRef<HTMLDivElement>(null);
  if (editing || errors.slug)
    return (
      <div ref={field} className="field-full">
        <SlugField
          label={t.listingFields.slug ?? ""}
          value={now.values.slug}
          onChange={put("slug")}
          source={now.values.name}
          error={errors.slug}
          readOnly={readOnly}
        />
      </div>
    );
  return (
    <div className="field field-full slug-line">
      <span className="slug-url">
        {t.input.slugPrefix}
        <strong>{now.values.slug}</strong>
      </span>
      {readOnly ? null : (
        <button
          type="button"
          className="btn btn-sm"
          aria-expanded={false}
          onClick={() => {
            setEditing(true);
            // Поле появится после этой отрисовки — фокус в него, без прокрутки (ловушка №3)
            setTimeout(
              () => field.current?.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true }),
              0,
            );
          }}
        >
          {t.slugEdit}
          <span className="visually-hidden">: {t.slugEditContext}</span>
        </button>
      )}
    </div>
  );
}

/** Строка «подпись — значение» для просмотра без правки; пустое не показывается */
interface Fact {
  readonly key: string;
  readonly label: string;
  readonly value: ReactNode;
  /** Длинный текст (описание): обычным начертанием, с переносами строк */
  readonly text?: boolean;
}

/**
 * Витрина для тех, кто её не правит (модератор): данные списком, а не формой с недоступными
 * полями и пометками «обязательно». Пустое не показывается — чего не хватает, говорит «Что осталось»
 */
function Facts({ facts }: { facts: readonly Fact[] }) {
  const shown = facts.filter((fact) => fact.value !== null && fact.value !== "");
  if (shown.length === 0) return <p className="muted">{t.factsEmpty}</p>;
  return (
    <dl className="dl facts">
      {shown.map((fact) => (
        <Fragment key={fact.key}>
          <dt>{fact.label}</dt>
          <dd className={fact.text ? "dd-text" : undefined}>{fact.value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

/** «Основное» без правки: название, район, адрес страницы, адреса и описания — списком */
function MainFacts() {
  const { now, dictionaries, parts } = useEditor();
  const values = now.values;
  const district =
    dictionaries?.districts.find((d) => d.code === values.districtCode)?.nameRu ?? values.districtCode;
  return (
    <section className="fs">
      <p className="notice">{t.listingReadOnly}</p>
      <div className="fs-head">
        <h2 id="form-main-title" tabIndex={-1}>
          {t.listingSections.main}
        </h2>
      </div>
      <Facts
        facts={[
          { key: "name", label: t.listingFields.name ?? "", value: values.name.trim() },
          ...(parts.district
            ? [{ key: "district", label: t.listingFields.districtCode ?? "", value: district }]
            : []),
          { key: "slug", label: t.listingFields.slug ?? "", value: `${t.input.slugPrefix}${values.slug}` },
          { key: "addressRu", label: t.listingFields.addressRu ?? "", value: values.addressRu.trim() },
          { key: "addressUz", label: t.listingFields.addressUz ?? "", value: values.addressUz.trim() },
          {
            key: "descriptionRu",
            label: t.listingFields.descriptionRu ?? "",
            value: values.descriptionRu.trim(),
            text: true,
          },
          {
            key: "descriptionUz",
            label: t.listingFields.descriptionUz ?? "",
            value: values.descriptionUz.trim(),
            text: true,
          },
        ]}
      />
    </section>
  );
}

/** «Данные витрины» без правки: вместимость, поля категории и видео — списком */
function DataFacts() {
  const { now, category, parts } = useEditor();
  const hasAttributes = category.attributes.length > 0 || parts.capacity;
  const { capMin, capMax } = now.values;
  const capacity = capMin.trim() || capMax.trim() ? t.capacityRange(capMin.trim(), capMax.trim()) : "";
  const videos = videoLinksValue(now.videos);
  return (
    <section className="fs">
      <div className="fs-head">
        <h2 id="form-attrs-title" tabIndex={-1}>
          {hasAttributes ? t.listingDataSections.attributes : t.listingDataSections.videos}
        </h2>
      </div>
      <Facts
        facts={[
          ...(parts.capacity ? [{ key: "capacity", label: t.input.capacity, value: capacity }] : []),
          ...category.attributes.map((field) => ({
            key: field.key,
            label: attributeLabel("ru", category, field.key),
            value: attributeText("ru", field, draftValue(field, now.attributes[field.key]), t.yes) ?? "",
          })),
          ...(parts.videos && videos.length > 0
            ? [
                {
                  key: "videos",
                  label: t.listingDataSections.videos,
                  value: (
                    <ul className="plain">
                      {videos.map((link) => (
                        <li key={link}>
                          <a href={link} target="_blank" rel="noopener noreferrer">
                            {link}
                          </a>
                        </li>
                      ))}
                    </ul>
                  ),
                },
              ]
            : []),
        ]}
      />
    </section>
  );
}

/** «Основное» и «Описание и адрес» — одна карточка: название, район, адрес страницы, адреса и описания */
export function MainSection() {
  const { now, put, set, errors, readOnly, moderatedHint, dictionaries, submit, formId, parts } = useEditor();
  if (readOnly) return <MainFacts />;

  // Пометки у подписи — как у клиента и в кабинете: описания для публикации нужны, адрес — нет
  const textarea = (key: "descriptionRu" | "descriptionUz", lang: "ru" | "uz") => (
    <Field label={t.listingFields[key] ?? key} required error={errors[key]} hint={moderatedHint} full>
      {(props) => (
        <textarea
          {...props}
          className="input"
          lang={lang}
          rows={4}
          value={now.values[key]}
          onChange={set(key)}
          maxLength={4000}
          readOnly={readOnly}
        />
      )}
    </Field>
  );

  // Адрес — улица, дом и ориентир: в две-три строки, а не в одну узкую
  const address = (key: "addressRu" | "addressUz", lang: "ru" | "uz") => (
    <Field label={t.listingFields[key] ?? key} required={false} error={errors[key]}>
      {(props) => (
        <textarea
          {...props}
          className="input"
          lang={lang}
          rows={2}
          value={now.values[key]}
          onChange={set(key)}
          maxLength={300}
          autoComplete="off"
          readOnly={readOnly}
        />
      )}
    </Field>
  );

  return (
    <form id={formId} className="form" onSubmit={submit} noValidate>
      <section className="fs">
        {readOnly ? <p className="notice">{t.listingReadOnly}</p> : null}
        {moderatedHint ? <p className="notice notice-warn">{t.moderatedNotice}</p> : null}
        <div className="fs-head">
          <h2 id="form-main-title" tabIndex={-1}>
            {t.listingSections.main}
          </h2>
        </div>
        <div className="fields">
          <Field label={t.listingFields.name ?? ""} required error={errors.name} hint={moderatedHint}>
            {(props) => (
              <input
                {...props}
                className="input"
                value={now.values.name}
                onChange={set("name")}
                maxLength={80}
                autoComplete="off"
                enterKeyHint="done"
                readOnly={readOnly}
                required
              />
            )}
          </Field>
          {parts.district ? (
            <Field label={t.listingFields.districtCode ?? ""} required error={errors.districtCode}>
              {(props) => (
                <Select
                  {...props}
                  className="input"
                  label={t.listingFields.districtCode ?? ""}
                  value={now.values.districtCode}
                  onChange={put("districtCode")}
                  disabled={readOnly}
                  options={districtChoices(dictionaries)}
                />
              )}
            </Field>
          ) : null}
          <SlugLine />
        </div>
        <div className="fs-head fs-sub">
          <h3 id="form-texts-title" tabIndex={-1}>
            {t.listingSections.texts}
          </h3>
        </div>
        <div className="fields">
          {address("addressRu", "ru")}
          {address("addressUz", "uz")}
          {textarea("descriptionRu", "ru")}
          {textarea("descriptionUz", "uz")}
        </div>
      </section>
    </form>
  );
}

// ── данные витрины и видео ─────────────────────────────────────────────────

/** Есть ли у категории что спрашивать в «Данных витрины»: поля, вместимость или видео */
export function hasDataSection(category: CategoryConfig): boolean {
  const parts = formParts(category);
  return category.attributes.length > 0 || parts.capacity || parts.videos;
}

export function DataSection() {
  const { now, put, setNow, errors, details, readOnly, category, parts, missing, submit } = useEditor();
  if (!hasDataSection(category)) return null;
  if (readOnly) return <DataFacts />;
  const hasAttributes = category.attributes.length > 0 || parts.capacity;

  // Видео: номер поля формы ↔ номер в отправленном списке (пустые не отправляются)
  const filledVideos = now.videos.flatMap((link, index) => (link.trim() === "" ? [] : [index]));
  const videoError = (index: number) =>
    details.includes(`videoLinks.${filledVideos.indexOf(index)}`) || details.includes("videoLinks");
  const putVideo = (index: number, value: string) =>
    setNow((prev) => ({ ...prev, videos: prev.videos.map((link, i) => (i === index ? value : link)) }));
  const putAttribute = (key: string, draft: AttributeDraft) =>
    setNow((prev) => ({ ...prev, attributes: { ...prev.attributes, [key]: draft } }));

  return (
    <form className="form" onSubmit={submit} noValidate>
      <section className="fs">
        <div className="fs-head">
          <h2 id="form-attrs-title" tabIndex={-1}>
            {hasAttributes ? t.listingDataSections.attributes : t.listingDataSections.videos}
          </h2>
        </div>
        {parts.capacity ? (
          <fieldset className="cap-pair">
            <legend>{t.input.capacity}</legend>
            {(["capMin", "capMax"] as const).map((key) => (
              <NumberField
                key={key}
                label={key === "capMin" ? t.input.capFrom : t.input.capTo}
                value={now.values[key]}
                onChange={put(key)}
                min={CAPACITY.min}
                max={CAPACITY.max}
                step={10}
                disabled={readOnly}
                error={
                  errors[key]
                    ? key === "capMax" && capOrderBroken(now)
                      ? t.input.capacityOrder
                      : t.attributeIntError(CAPACITY.min, CAPACITY.max)
                    : undefined
                }
              />
            ))}
          </fieldset>
        ) : null}
        <AttributeFields
          category={category}
          drafts={now.attributes}
          onChange={putAttribute}
          errors={details}
          missing={missing}
          readOnly={readOnly}
        />
        {parts.videos ? (
          <>
            {hasAttributes ? (
              <div className="fs-head fs-sub">
                <h3 id="form-videos-title">{t.listingDataSections.videos}</h3>
              </div>
            ) : null}
            <div className="fields">
              {now.videos.map((link, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: поле ссылки — место в списке, своего id нет
                <div key={index} className="video-row field-full">
                  <Field
                    label={t.videoLink(index + 1)}
                    error={videoError(index) ? t.videoLinkError : undefined}
                    full
                  >
                    {(props) => (
                      <input
                        {...props}
                        className="input"
                        type="url"
                        inputMode="url"
                        autoCapitalize="none"
                        spellCheck={false}
                        placeholder="https://youtu.be/…"
                        value={link}
                        maxLength={200}
                        readOnly={readOnly}
                        onChange={(event) => putVideo(index, event.target.value)}
                      />
                    )}
                  </Field>
                  {readOnly || link.trim() === "" ? null : (
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() =>
                        setNow((prev) => ({ ...prev, videos: prev.videos.filter((_, i) => i !== index) }))
                      }
                    >
                      {t.videoRemove}
                      <span className="visually-hidden"> {index + 1}</span>
                    </button>
                  )}
                </div>
              ))}
            </div>
            {readOnly ||
            now.videos.length >= category.maxVideoLinks ||
            now.videos.some((l) => l.trim() === "") ? null : (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setNow((prev) => ({ ...prev, videos: [...prev.videos, ""] }))}
              >
                {t.videoAdd}
              </button>
            )}
          </>
        ) : null}
      </section>
    </form>
  );
}

// ── контакты для клиентов ──────────────────────────────────────────────────

type Reveal =
  | { state: "hidden" }
  | { state: "loading" }
  | { state: "shown"; contacts: RevealedListingContacts }
  | { state: "error"; code: string };

const PHONE_MASK = "+998 •• ••• •• ••";
const TELEGRAM_MASK = "@••••••••";

/** Строка канала: подпись, значение и действия справа; у поля на месте строки подпись своя */
function ContactRow({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className="contact-row">
      {label ? <span className="contact-label">{label}</span> : null}
      {children}
    </div>
  );
}

/** Скрытое значение: маска и «скрыт» для диктора */
function Masked({ mask }: { mask: string }) {
  return (
    <span className="phone-mask contact-value">
      <span aria-hidden="true">{mask}</span>
      <span className="visually-hidden">{t.hidden}</span>
    </span>
  );
}

function ContactRows() {
  const { now, setNow, put, errors, readOnly, contacts, phoneRemovable } = useEditor();
  const [reveal, setReveal] = useState<Reveal>({ state: "hidden" });
  // Номер есть — поле нового по «Изменить»; номера нет — сразу поле (он нужен для публикации)
  const [changingPhone, setChangingPhone] = useState(false);
  // Telegram по желанию: «Изменить» или «Добавить»
  const [changingTelegram, setChangingTelegram] = useState(false);
  const phoneInput = useRef<HTMLInputElement>(null);
  const telegramEdit = useRef<HTMLSpanElement>(null);
  const hasPhone = Boolean(contacts?.hasPhone);
  const hasTelegram = Boolean(contacts?.hasTelegram);
  const load = contacts?.load;

  // Одно чтение открывает оба значения: в журнал доступа к ПДн — одна запись
  const show = useCallback(async () => {
    if (!load) return;
    setReveal({ state: "loading" });
    const result = await load();
    setReveal(result.ok ? { state: "shown", contacts: result.data } : { state: "error", code: result.code });
  }, [load]);
  const shown = reveal.state === "shown" ? reveal.contacts : null;
  const showButton =
    shown === null && (hasPhone || hasTelegram) ? (
      <button type="button" className="btn btn-sm" onClick={show} disabled={reveal.state === "loading"}>
        {t.contactsShow}
      </button>
    ) : null;

  const phoneEditing = !hasPhone || changingPhone || Boolean(errors.phone);
  const telegramEditing = changingTelegram || Boolean(errors.telegram);
  // Поле появится после отрисовки — фокус в него, без прокрутки (ловушка №3)
  const focusLater = (field: { current: HTMLElement | null }) =>
    setTimeout(() => {
      const target =
        field.current instanceof HTMLInputElement ? field.current : field.current?.querySelector("input");
      target?.focus({ preventScroll: true });
    }, 0);

  const removeMenu = (title: string, label: string, run: () => void) => (
    <OverflowMenu
      title={title}
      context={title}
      className="btn btn-icon"
      actions={[{ key: "remove", label, icon: "trash", danger: true, run }]}
    />
  );
  const undo = (what: "clearPhone" | "clearTelegram") => (
    <span className="contact-actions">
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => setNow((prev) => ({ ...prev, [what]: false }))}
      >
        {t.contactUndo}
      </button>
    </span>
  );
  const editButton = (what: string, run: () => void) => (
    <button type="button" className="btn btn-sm" aria-expanded={false} onClick={run}>
      {t.contactEdit}
      <span className="visually-hidden">: {what}</span>
    </button>
  );

  const phoneRow = (() => {
    const label = t.listingFields.phone ?? "";
    if (now.clearPhone)
      return (
        <ContactRow label={label}>
          <span className="contact-note">{t.contactPhoneRemoving}</span>
          {undo("clearPhone")}
        </ContactRow>
      );
    if (readOnly && !hasPhone)
      return (
        <ContactRow>
          <span className="muted contact-value">{t.phoneMissing}</span>
        </ContactRow>
      );
    if (readOnly || !phoneEditing)
      return (
        <ContactRow label={label}>
          {shown ? (
            shown.phone ? (
              <a className="phone-value contact-value" href={`tel:${shown.phone}`}>
                {formatUzPhone(shown.phone)}
              </a>
            ) : (
              <span className="muted contact-value">{t.notSet}</span>
            )
          ) : (
            <Masked mask={PHONE_MASK} />
          )}
          <span className="contact-actions">
            {showButton}
            {readOnly
              ? null
              : editButton(label, () => {
                  setChangingPhone(true);
                  focusLater(phoneInput);
                })}
            {readOnly || !phoneRemovable
              ? null
              : removeMenu(label, t.phoneRemove, () =>
                  setNow((prev) => ({
                    ...prev,
                    clearPhone: true,
                    clearTelegram: false,
                    values: { ...prev.values, phone: "", telegram: "" },
                  })),
                )}
          </span>
        </ContactRow>
      );
    return (
      <ContactRow>
        <span className="contact-edit">
          <PhoneField
            label={hasPhone ? t.phoneChange : label}
            value={now.values.phone}
            onChange={put("phone")}
            error={errors.phone}
            inputRef={phoneInput}
          />
          {hasPhone ? (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                put("phone")("");
                setChangingPhone(false);
              }}
            >
              {t.input.phoneChangeCancel}
            </button>
          ) : null}
        </span>
      </ContactRow>
    );
  })();

  const telegramRow = (() => {
    // Телефон убирают — Telegram уходит вместе с ним: отдельной строки не нужно
    if (now.clearPhone) return null;
    if (now.clearTelegram)
      return (
        <ContactRow label={t.telegramLabel}>
          <span className="contact-note">{t.contactTelegramRemoving}</span>
          {undo("clearTelegram")}
        </ContactRow>
      );
    if (!telegramEditing) {
      const start = () => {
        setChangingTelegram(true);
        focusLater(telegramEdit);
      };
      return (
        <ContactRow {...(hasTelegram ? { label: t.telegramLabel } : {})}>
          {hasTelegram ? (
            shown ? (
              shown.telegram ? (
                <a
                  className="phone-value contact-value"
                  href={`https://t.me/${shown.telegram}`}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  @{shown.telegram}
                </a>
              ) : (
                <span className="muted contact-value">{t.notSet}</span>
              )
            ) : (
              <Masked mask={TELEGRAM_MASK} />
            )
          ) : (
            <span className="muted contact-value">{t.telegramMissing}</span>
          )}
          <span className="contact-actions">
            {showButton}
            {readOnly ? null : hasTelegram ? (
              <>
                {editButton(t.telegramLabel, start)}
                {removeMenu(t.telegramLabel, t.telegramRemove, () =>
                  setNow((prev) => ({
                    ...prev,
                    clearTelegram: true,
                    values: { ...prev.values, telegram: "" },
                  })),
                )}
              </>
            ) : (
              <button type="button" className="btn btn-sm" aria-expanded={false} onClick={start}>
                {t.contactAdd}
                <span className="visually-hidden">: {t.telegramLabel}</span>
              </button>
            )}
          </span>
        </ContactRow>
      );
    }
    return (
      <ContactRow>
        <span ref={telegramEdit} className="contact-edit">
          <TelegramField
            label={t.telegramChange}
            value={now.values.telegram}
            onChange={put("telegram")}
            error={errors.telegram}
          />
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              put("telegram")("");
              setChangingTelegram(false);
            }}
          >
            {hasTelegram ? t.contactKeep : t.cancel}
          </button>
        </span>
      </ContactRow>
    );
  })();

  return (
    <div className="contacts-reveal">
      {phoneRow}
      {telegramRow}
      {reveal.state === "error" ? (
        <span className="field-error" role="alert">
          {apiErrorText(reveal.code)}
        </span>
      ) : null}
    </div>
  );
}

export function ContactsSection() {
  const { submit, saves } = useEditor();
  return (
    <form className="form" onSubmit={submit} noValidate>
      <section className="fs">
        <div className="fs-head">
          <h2 id="form-phone-title" tabIndex={-1}>
            {t.listingSections.phone}
          </h2>
        </div>
        {/* Сохранили — открытые контакты закрываются: новое чтение, новая запись в журнале */}
        <ContactRows key={saves} />
      </section>
    </form>
  );
}

// ── «Сохранить» ────────────────────────────────────────────────────────────

/** «Сохранить» одна на все части формы: на телефоне — в панели действий, шире — полоса снизу */
export function EditorBar() {
  const { readOnly, failure, formId, dirty, busy, saved, sent, showFresh, refreshing, rebased } = useEditor();
  const phone = usePhone();
  const problem = useRef<HTMLDivElement>(null);
  // Не ошибка поля (версия устарела, нет связи) — сообщение в конце страницы: показать
  useEffect(() => {
    if (failure && failure.code !== "invalid_input") problem.current?.scrollIntoView?.({ block: "center" });
  }, [failure]);
  if (readOnly) return null;
  // Шире телефона полоса — только когда есть что сохранять или что сказать о сохранённом
  const quiet = !phone && !dirty && !busy && !saved && !sent;
  return (
    <>
      <div ref={problem} hidden={!failure}>
        {failure?.code === "version_conflict" && showFresh ? (
          // Витрину изменили, пока здесь вписывали: вписанное не пропадает — свежая версия ляжет под него
          <div className="notice notice-warn conflict" role="alert">
            <p>{t.conflictText}</p>
            <button
              type="button"
              className="btn btn-sm"
              aria-busy={refreshing || undefined}
              disabled={refreshing}
              onClick={() => void showFresh()}
            >
              {busyLabel(t.conflictShowFresh, refreshing)}
            </button>
          </div>
        ) : failure ? (
          <ErrorText failure={failure} />
        ) : null}
      </div>
      {rebased && dirty ? <ConflictChoices rebased={rebased} /> : null}
      {quiet ? null : (
        <FormBar
          formId={formId}
          show={dirty}
          busy={busy}
          submitLabel={t.save}
          note={
            saved ? (
              <span className="saved" role="status">
                {t.saved}
              </span>
            ) : sent ? (
              <span className="sent" role="status">
                {t.sentForModeration(
                  sent.fields.map((field) => t.revisionFields[field] ?? field).join(", "),
                  sent.rest,
                )}
              </span>
            ) : null
          }
        />
      )}
    </>
  );
}

/** Длинный текст в выборе — началом: целиком он в поле формы */
const clip = (text: string) => (text.length > 120 ? `${text.slice(0, 117)}…` : text);

/**
 * Поля, которые поменяли и здесь, и в свежей версии: по каждому — «ваш вариант» (по умолчанию) или
 * «новый». Выбор сразу ставит значение в форму; сохранить — как обычно, «Сохранить»
 */
function ConflictChoices({ rebased }: { rebased: Rebased }) {
  const { choose } = useEditor();
  return (
    <section className="notice notice-warn conflict" aria-labelledby="conflict-title">
      <h3 id="conflict-title" className="notice-title">
        {t.conflictChoose}
      </h3>
      {rebased.conflicts.map((conflict, index) => (
        <Fragment key={conflict.key}>
          <p className="sheet-group" id={`conflict-${index}`}>
            {conflict.label}
          </p>
          <RadioGroup<"mine" | "theirs">
            variant="row"
            aria-labelledby={`conflict-${index}`}
            value={rebased.picks[conflict.key] ?? "mine"}
            onChange={(side) => choose(conflict.key, side)}
            options={[
              { value: "mine", label: t.conflictMine(clip(conflict.mine)) },
              { value: "theirs", label: t.conflictTheirs(clip(conflict.theirs)) },
            ]}
          />
        </Fragment>
      ))}
    </section>
  );
}
