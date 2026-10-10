/* Форма витрины (карточки): название, адрес страницы, район, тексты на двух языках, данные
   витрины по категории, ссылки на видео, сколько заказов одновременно, телефон и Telegram для
   клиентов.
   Что спрашивать — решает категория (@bayramm/shared/categories): вместимость в гостях —
   только где она нужна (площадка), видео — где их можно (фото и видео, студия), заказы
   одновременно — у занятости по частям дня (кортеж, фото и видео, декор).

   Цены — в услугах витрины (Services.tsx): цена «от» считается из них, руками не задаётся.
   Опубликованную витрину менеджер (без права решать по правкам) меняет как партнёр из
   кабинета: название и описания уходят правкой на модерацию, а витрина остаётся прежней —
   форма говорит «отправлено на модерацию» и показывает то, что в витрине сейчас. Остальное
   (адрес, данные витрины, видео, телефон…) сохраняется сразу. Телефон и Telegram только
   пишутся: текущие — по «Показать» (одним чтением). Telegram — по желанию: пустое поле не
   меняет, «Убрать Telegram» снимает; имя, @имя и ссылку t.me/имя сервер понимает сам.
   «Убрать телефон» — только пока витрина не на проверке и не в каталоге (без телефона её не
   опубликовать — так же решает база); Telegram уходит вместе с ним: он хранится рядом. */

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
  attributePatch,
  attributesOf,
  type CategoryConfig,
  missingAttributes,
  parseAmount,
  videoLinkErrors,
  videoLinksValue,
} from "@bayramm/shared/categories";
import { Checkbox, NumberStepper, Select } from "@bayramm/ui/react";
import { type FormEvent, useEffect, useId, useState } from "react";
import type { Failure, Result } from "../api";
import { categoryName } from "../categories";
import { t } from "../texts";
import { ContactsReveal, ErrorText, Field, FormBar, fieldErrors, useRevealErrors } from "../ui";
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
  parallelCapacity: string;
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

export const MAX_PARALLEL = 50;

/** Что спрашивает форма у этой категории */
export function formParts(category: CategoryConfig) {
  return {
    capacity: category.listingFields.includes("guest_capacity"),
    videos: category.maxVideoLinks > 0,
    parallel: category.availability === "parts",
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
    parallelCapacity: String(listing.parallelCapacity),
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
    if (now.values.phone.trim() !== "") body.phone = now.values.phone.trim();
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
  if (parts.parallel && changed("parallelCapacity"))
    body.parallelCapacity = amount(now.values.parallelCapacity);
  return body as ListingInput;
}

/** Ошибки до отправки — те же пути, что ответ 422: данные витрины, видео, заказы одновременно */
export function formErrors(category: CategoryConfig, now: FormState): string[] {
  const parts = formParts(category);
  const errors = attributeErrors(category, now.attributes);
  if (parts.videos) {
    // Номер поля формы → номер в отправленном списке (пустые поля не отправляются)
    const filled = now.videos.flatMap((link, index) => (link.trim() === "" ? [] : [index]));
    for (const index of videoLinkErrors(category, now.videos))
      errors.push(`videoLinks.${filled.indexOf(index)}`);
  }
  if (parts.parallel) {
    const n = parseAmount(now.values.parallelCapacity);
    if (n === null || Number.isNaN(n) || n < 1 || n > MAX_PARALLEL) errors.push("parallelCapacity");
  }
  return errors;
}

interface ListingFormProps {
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
  contacts?: {
    readonly hasPhone: boolean;
    readonly hasTelegram: boolean;
    readonly load: () => Promise<Result<RevealedListingContacts>>;
  };
}

/** Что ушло на модерацию и было ли в правке что-то ещё (оно сохранено сразу) */
interface Sent {
  readonly fields: readonly RevisionField[];
  readonly rest: boolean;
}

const invalid = (details: string[]): Failure => ({ ok: false, status: 422, code: "invalid_input", details });

export function ListingForm({
  listing,
  category,
  dictionaries,
  onSubmit,
  readOnly,
  moderated = false,
  onDirtyChange,
  contacts,
}: ListingFormProps) {
  const [before, setBefore] = useState(() => formState(listing, category));
  const [now, setNow] = useState(before);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [sent, setSent] = useState<Sent | null>(null);
  // Сколько раз сохранили: открытые контакты после правки закрываются — новое чтение, новая запись в журнале
  const [saves, setSaves] = useState(0);
  const parts = formParts(category);
  const errors = fieldErrors(failure, t.listingFieldErrors);
  const details = failure?.code === "invalid_input" ? failure.details : [];
  const moderatedHint = moderated && !readOnly ? t.moderatedHint : undefined;
  const form = useRevealErrors(failure);
  const formId = useId();
  const phoneRemoveHintId = useId();
  const dirty = !readOnly && Object.keys(listingBody(category, now, before)).length > 0;
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  // Вписанное и не сохранённое — уход переспросит
  useUnsaved(dirty);
  // Чего не хватает для публикации — по тому, что сейчас в форме
  const missing = missingAttributes(category, attributesOf(category, now.attributes));
  // Телефон снимается, только пока витрина не на проверке и не в каталоге (иначе её не опубликовать)
  const phoneRemovable =
    Boolean(contacts?.hasPhone) && listing.status !== "review" && listing.status !== "active";

  // Любая новая правка — старое «Сохранено» или «Отправлено» уже не про неё
  const touch = () => {
    setSaved(false);
    setSent(null);
  };
  const put = (key: keyof Values) => (value: string) => {
    touch();
    setNow((prev) => ({ ...prev, values: { ...prev.values, [key]: value } }));
  };
  const set = (key: keyof Values) => (event: { target: { value: string } }) => put(key)(event.target.value);
  const putAttribute = (key: string, draft: AttributeDraft) => {
    touch();
    setNow((prev) => ({ ...prev, attributes: { ...prev.attributes, [key]: draft } }));
  };
  const putVideo = (index: number, value: string) => {
    touch();
    setNow((prev) => ({ ...prev, videos: prev.videos.map((link, i) => (i === index ? value : link)) }));
  };

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
    setSaves((n) => n + 1);
    // Форма — как в витрине после правки: значения уже в том виде, как их хранит сервер
    const next = formState(result, category);
    setBefore(next);
    setNow(next);
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

  const input = (
    key: keyof Values,
    label: string,
    extra: { maxLength: number; numeric?: boolean; required?: boolean; hint?: string | undefined },
  ) => (
    <Field label={label} error={errors[key]} hint={extra.hint}>
      {(props) => (
        <input
          {...props}
          className="input"
          value={now.values[key]}
          onChange={set(key)}
          maxLength={extra.maxLength}
          inputMode={extra.numeric ? "numeric" : undefined}
          autoComplete="off"
          enterKeyHint="done"
          readOnly={readOnly}
          required={extra.required}
        />
      )}
    </Field>
  );

  const textarea = (key: "descriptionRu" | "descriptionUz", lang: "ru" | "uz") => (
    <Field label={t.listingFields[key] ?? key} error={errors[key]} hint={moderatedHint} full>
      {(props) => (
        <textarea
          {...props}
          className="input"
          lang={lang}
          rows={5}
          value={now.values[key]}
          onChange={set(key)}
          maxLength={4000}
          readOnly={readOnly}
        />
      )}
    </Field>
  );

  // Видео: номер поля формы ↔ номер в отправленном списке (пустые не отправляются)
  const filledVideos = now.videos.flatMap((link, index) => (link.trim() === "" ? [] : [index]));
  const videoError = (index: number) =>
    details.includes(`videoLinks.${filledVideos.indexOf(index)}`) || details.includes("videoLinks");

  return (
    <form id={formId} ref={form} className="form" onSubmit={submit} noValidate>
      {readOnly ? <p className="notice">{t.listingReadOnly}</p> : null}
      {moderatedHint && <p className="notice notice-warn">{t.moderatedNotice}</p>}
      <section className="fs">
        <div className="fs-head">
          <h2 id="form-main-title" tabIndex={-1}>
            {t.listingSections.main}
          </h2>
          <p>{t.listingSections.mainHint}</p>
        </div>
        <div className="fields">
          {input("name", t.listingFields.name ?? "", { maxLength: 80, required: true, hint: moderatedHint })}
          <Field label={t.listingFields.slug ?? ""} error={errors.slug}>
            {(props) => (
              <input
                {...props}
                className="input"
                value={now.values.slug}
                onChange={set("slug")}
                maxLength={40}
                autoCapitalize="none"
                spellCheck={false}
                readOnly={readOnly}
              />
            )}
          </Field>
          <Field label={t.listingFields.districtCode ?? ""} error={errors.districtCode}>
            {(props) => (
              <Select
                {...props}
                className="input"
                label={t.listingFields.districtCode ?? ""}
                value={now.values.districtCode}
                onChange={put("districtCode")}
                disabled={readOnly}
                options={[
                  { value: "", label: t.none },
                  ...(dictionaries?.districts ?? []).map((district) => ({
                    value: district.code,
                    label: district.nameRu,
                  })),
                ]}
              />
            )}
          </Field>
        </div>
      </section>

      <section className="fs">
        <div className="fs-head">
          <h2 id="form-texts-title" tabIndex={-1}>
            {t.listingSections.texts}
          </h2>
          <p>{t.listingSections.textsHint}</p>
        </div>
        <div className="fields">
          {input("addressRu", t.listingFields.addressRu ?? "", { maxLength: 300 })}
          {input("addressUz", t.listingFields.addressUz ?? "", { maxLength: 300 })}
          {textarea("descriptionRu", "ru")}
          {textarea("descriptionUz", "uz")}
        </div>
      </section>

      {category.attributes.length > 0 || parts.capacity ? (
        <section className="fs">
          <div className="fs-head">
            <h2 id="form-attrs-title" tabIndex={-1}>
              {t.listingDataSections.attributes}
            </h2>
            <p>{t.listingDataSections.attributesHint(categoryName(category.code))}</p>
          </div>
          {parts.capacity ? (
            <div className="fields attr-capacity">
              {input("capMin", t.listingFields.capMin ?? "", { maxLength: 5, numeric: true })}
              {input("capMax", t.listingFields.capMax ?? "", { maxLength: 5, numeric: true })}
            </div>
          ) : null}
          <AttributeFields
            category={category}
            drafts={now.attributes}
            onChange={putAttribute}
            errors={details}
            missing={missing}
            readOnly={readOnly}
          />
        </section>
      ) : null}

      {parts.videos ? (
        <section className="fs">
          <div className="fs-head">
            <h2>{t.listingDataSections.videos}</h2>
            <p>{t.listingDataSections.videosHint(category.maxVideoLinks)}</p>
          </div>
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
                    onClick={() => {
                      touch();
                      setNow((prev) => ({ ...prev, videos: prev.videos.filter((_, i) => i !== index) }));
                    }}
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
              onClick={() => {
                touch();
                setNow((prev) => ({ ...prev, videos: [...prev.videos, ""] }));
              }}
            >
              {t.videoAdd}
            </button>
          )}
        </section>
      ) : null}

      {parts.parallel ? (
        <section className="fs">
          <div className="fs-head">
            <h2>{t.listingDataSections.occupancy}</h2>
            <p>{t.listingDataSections.occupancyHint}</p>
          </div>
          <div className="fields">
            <Field
              label={t.listingDataSections.occupancy}
              error={errors.parallelCapacity ? t.parallelCapacityError : undefined}
            >
              {(props) => (
                <NumberStepper
                  {...props}
                  value={now.values.parallelCapacity}
                  onChange={put("parallelCapacity")}
                  min={1}
                  max={MAX_PARALLEL}
                  maxLength={2}
                  disabled={readOnly}
                  decrementLabel={`${t.listingDataSections.occupancy} −1`}
                  incrementLabel={`${t.listingDataSections.occupancy} +1`}
                />
              )}
            </Field>
          </div>
        </section>
      ) : null}

      {/* Контакты для клиентов — один блок: нынешние по «Показать» (чтение — в журнал), новые —
        полями; без права правки — только показать */}
      <section className="fs">
        <div className="fs-head">
          <h2 id="form-phone-title" tabIndex={-1}>
            {t.listingSections.phone}
          </h2>
          <p>{t.listingSections.phoneHint}</p>
        </div>
        {contacts ? (
          <ContactsReveal
            key={saves}
            hasPhone={contacts.hasPhone}
            hasTelegram={contacts.hasTelegram}
            load={contacts.load}
          />
        ) : null}
        {readOnly ? null : (
          <div className="fields">
            <Field label={t.phoneChange} error={errors.phone} hint={t.phoneKeep}>
              {(props) => (
                <input
                  {...props}
                  className="input"
                  type="tel"
                  inputMode="tel"
                  autoComplete="off"
                  placeholder="+998 XX XXX XX XX"
                  value={now.values.phone}
                  onChange={set("phone")}
                  maxLength={24}
                  enterKeyHint="done"
                  disabled={now.clearPhone}
                />
              )}
            </Field>
            <Field
              label={t.telegramChange}
              error={errors.telegram}
              hint={contacts?.hasTelegram ? t.phoneKeep : t.telegramHintNew}
            >
              {(props) => (
                <input
                  {...props}
                  className="input"
                  inputMode="text"
                  autoCapitalize="none"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="@username"
                  value={now.values.telegram}
                  onChange={set("telegram")}
                  maxLength={64}
                  enterKeyHint="done"
                  disabled={now.clearTelegram || now.clearPhone}
                />
              )}
            </Field>
            {phoneRemovable ? (
              <div className="field-full">
                <Checkbox
                  checked={now.clearPhone}
                  aria-describedby={phoneRemoveHintId}
                  onChange={(checked) => {
                    touch();
                    setNow((prev) => ({
                      ...prev,
                      clearPhone: checked,
                      clearTelegram: false,
                      values: checked ? { ...prev.values, phone: "", telegram: "" } : prev.values,
                    }));
                  }}
                >
                  {t.phoneRemove}
                </Checkbox>
                <span id={phoneRemoveHintId} className="field-hint">
                  {t.phoneRemoveHint}
                </span>
              </div>
            ) : null}
            {contacts?.hasTelegram && !now.clearPhone ? (
              <div className="field-full">
                <Checkbox
                  checked={now.clearTelegram}
                  onChange={(checked) => {
                    touch();
                    setNow((prev) => ({
                      ...prev,
                      clearTelegram: checked,
                      values: checked ? { ...prev.values, telegram: "" } : prev.values,
                    }));
                  }}
                >
                  {t.telegramRemove}
                </Checkbox>
              </div>
            ) : null}
          </div>
        )}
      </section>

      {failure && <ErrorText failure={failure} />}
      {!readOnly && (
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
    </form>
  );
}
