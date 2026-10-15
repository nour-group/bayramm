/* Окно «Изменить» у карточки-группы витрины (VenueGroups.tsx): шторка на телефоне, карточка по
   центру шире. В окне только поля своей группы:
     · «Основное» — название и описания на двух языках;
     · «Место» — район (список по городам из GET /dictionaries), адрес на двух языках, вместимость
       «Гостей от / до» (у категорий с guest_capacity; район — у категорий с district);
     · «Данные витрины» — поля категории (Attributes.tsx);
     · «Видео» — ссылки на YouTube и Instagram.
   Одно правило: пока витрины нет на сайте — «Сохранить» записывает сразу; на проверке, на сайте
   или приостановлена — «Отправить изменения»: уйдёт предложением, клиенты увидят изменения после
   проверки командой (об этом — одна строка в окне). Слова «Отправить на проверку» — только у
   отправки всей витрины (Venue.tsx).

   В запрос уходят только изменённые поля (listing-edit.ts); поля проверяются до запроса теми же
   правилами, что на сервере, неверные от сервера (422 invalid_input) подсвечиваются тоже. Версия
   витрины — как её видел человек: успели изменить (409 version_conflict) — витрина перечитывается,
   вписанное остаётся в окне. Вписанное и не сохранённое отмечает окно в реестре несохранённого:
   закрыть его (Esc, подложка, «Отмена») или уйти с экрана без сохранения — спросят. */

import type { Lang } from "@bayramm/shared";
import type { Dictionaries } from "@bayramm/shared/api";
import type { VendorListing, VendorListingSaved } from "@bayramm/shared/api/vendor";
import { DESCRIPTION_MAX } from "@bayramm/shared/api/vendor";
import { type AttributeDraft, type AttributeDrafts, categoryConfig } from "@bayramm/shared/categories";
import { Dialog, NumberStepper, Select } from "@bayramm/ui/react";
import { type FormEvent, type RefObject, useId, useState } from "react";
import { AttributesForm } from "./Attributes";
import { ApiFailure, api } from "./api";
import { errorText as apiErrorText } from "./errors";
import { fill, type TextKey, type VendorDict } from "./i18n";
import {
  attributeDraftsOf,
  attributesChanges,
  attributesErrors,
  basicsChanges,
  basicsErrors,
  basicsOf,
  CAPACITY_RANGE,
  districtOptions,
  type EditGroup,
  type FieldErrors,
  hasCapacity,
  hasDistrict,
  type ListingChanges,
  placeChanges,
  placeErrors,
  placeOf,
  savesDirectly,
  videoDraftsOf,
  videoErrorIndexes,
  videosChanges,
  videosErrors,
} from "./listing-edit";
import { FieldMark, LoadError, Loading } from "./ui";
import { useConfirmLeave, useUnsaved } from "./unsaved";
import { useLoad } from "./useLoad";

/** Название группы — заголовок карточки и окна */
export function groupTitle(group: EditGroup, t: VendorDict): string {
  switch (group) {
    case "basics":
      return t.groupBasics;
    case "place":
      return t.groupPlace;
    case "attributes":
      return t.attributesTitle;
    case "videos":
      return t.videoTitle;
  }
}

type Notice = "noChanges" | "invalid" | "failed" | "pendingExists" | null;

interface SheetProps {
  readonly group: EditGroup;
  readonly listing: VendorListing;
  readonly t: VendorDict;
  readonly lang: Lang;
  readonly onClose: () => void;
  /** Куда вернуть фокус после сохранения (строка «Сохранено» — карточка могла измениться); нет её — туда, откуда открыли */
  readonly returnFocus?: RefObject<HTMLElement | null>;
  /** Сохранено сразу или ушло предложением: ответ API с витриной как она теперь */
  readonly onSaved: (saved: VendorListingSaved) => void;
  /** Витрину успели изменить или предложение уже открыто: перечитать витрину и предложения */
  readonly onStale: () => void;
}

/** Район: список по городам из справочника; пока не загрузился — только текущий */
function DistrictField({
  id,
  value,
  onChange,
  bad,
  t,
  lang,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  bad: boolean;
  t: VendorDict;
  lang: Lang;
}) {
  const [dictionaries, reload] = useLoad<Dictionaries>("dictionaries", () => api.dictionaries());
  const ready = dictionaries.state === "ready";
  const options = districtOptions(ready ? dictionaries.data : null, lang);
  return (
    <div className="form-row">
      <label className="field-label" htmlFor={id}>
        {t.district} <FieldMark required t={t} />
      </label>
      <Select
        id={id}
        label={t.district}
        placeholder={t.districtPick}
        value={value === "" ? null : value}
        options={options}
        disabled={!ready}
        onChange={onChange}
        aria-invalid={bad}
      />
      {dictionaries.state === "loading" ? <Loading t={t} /> : null}
      {dictionaries.state === "error" ? (
        <LoadError t={t} onRetry={reload} error={dictionaries.error} />
      ) : null}
      {bad ? <p className="field-error">{t.fieldInvalid}</p> : null}
    </div>
  );
}

function VideoFields({
  id,
  videos,
  setVideos,
  bad,
  setBad,
  max,
  t,
}: {
  id: string;
  videos: readonly string[];
  setVideos: (update: (prev: string[]) => string[]) => void;
  bad: ReadonlySet<number>;
  setBad: (bad: ReadonlySet<number>) => void;
  max: number;
  t: VendorDict;
}) {
  return (
    <fieldset className="choices proposal-videos">
      <legend className="sr-only">{t.videoTitle}</legend>
      {videos.map((link, index) => {
        const inputId = `${id}-video-${index}`;
        const wrong = bad.has(index);
        return (
          // Ссылки без своего id: номер поля и есть его место
          // biome-ignore lint/suspicious/noArrayIndexKey: поле ссылки — по месту
          <div key={index} className="form-row video-row">
            <label className="field-label" htmlFor={inputId}>
              {fill(t.videoLabel, { n: index + 1 })}
            </label>
            <div className="video-field">
              <input
                id={inputId}
                className="field"
                type="url"
                inputMode="url"
                autoComplete="off"
                maxLength={200}
                placeholder="https://"
                value={link}
                aria-invalid={wrong || undefined}
                aria-describedby={wrong ? `${inputId}-error` : undefined}
                onChange={(event) =>
                  setVideos((prev) => prev.map((v, i) => (i === index ? event.target.value : v)))
                }
              />
              {videos.length > 1 || link !== "" ? (
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => {
                    setBad(new Set());
                    setVideos((prev) => {
                      const next = prev.filter((_, i) => i !== index);
                      return next.length > 0 ? next : [""];
                    });
                  }}
                >
                  {fill(t.videoRemove, { n: index + 1 })}
                </button>
              ) : null}
            </div>
            {wrong ? (
              <p className="field-error" id={`${inputId}-error`}>
                {t.videoInvalid}
              </p>
            ) : null}
          </div>
        );
      })}
      {videos.length < max ? (
        <button
          type="button"
          className="btn btn-ghost attr-add"
          onClick={() => setVideos((prev) => [...prev, ""])}
        >
          {t.videoAdd}
        </button>
      ) : null}
    </fieldset>
  );
}

export function EditSheet({ group, listing, t, lang, onClose, returnFocus, onSaved, onStale }: SheetProps) {
  const id = useId();
  const category = categoryConfig(listing.categoryCode);
  const moderated = !savesDirectly(listing.status);
  const confirmLeave = useConfirmLeave();

  const [basics, setBasics] = useState(() => basicsOf(listing));
  const [place, setPlace] = useState(() => placeOf(listing));
  const [before] = useState<AttributeDrafts>(() => (category ? attributeDraftsOf(listing, category) : {}));
  const [drafts, setDrafts] = useState<AttributeDrafts>(before);
  const [videos, setVideos] = useState<string[]>(() => videoDraftsOf(listing));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [badAttributes, setBadAttributes] = useState<ReadonlySet<string>>(new Set());
  const [badVideos, setBadVideos] = useState<ReadonlySet<number>>(new Set());
  const [notice, setNotice] = useState<Notice>(null);
  const [failedText, setFailedText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const changes = ((): ListingChanges => {
    switch (group) {
      case "basics":
        return basicsChanges(listing, basics);
      case "place":
        return placeChanges(listing, category, place);
      case "attributes":
        return category ? attributesChanges(category, drafts, before) : {};
      case "videos":
        return category ? videosChanges(listing, category, videos) : {};
    }
  })();
  const dirty = Object.keys(changes).length > 0;
  // Вписанное и не сохранённое: уход с экрана и закрытие окна переспросят
  useUnsaved(dirty);

  // «Уйти» закрывает вопрос и окно разом: два слоя, закрытых в одном обновлении, возвращают
  // странице inert друг другу по очереди и оставляют её недоступной. Окно — следующим тактом
  const requestClose = () => {
    if (!busy) confirmLeave(() => queueMicrotask(onClose));
  };

  /** Те же проверки, что на сервере; true — можно отправлять */
  const validate = (): boolean => {
    let found: FieldErrors = {};
    let attributes: ReadonlySet<string> = new Set();
    let links: ReadonlySet<number> = new Set();
    if (group === "basics") found = basicsErrors(basics, moderated);
    if (group === "place") found = placeErrors(listing, category, place);
    if (group === "attributes" && category) attributes = attributesErrors(category, drafts);
    if (group === "videos" && category) links = videosErrors(category, videos);
    setErrors(found);
    setBadAttributes(attributes);
    setBadVideos(links);
    const ok = Object.keys(found).length === 0 && attributes.size === 0 && links.size === 0;
    setNotice(ok ? null : "invalid");
    return ok;
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!validate()) return;
    if (!dirty) {
      setNotice("noChanges");
      return;
    }
    setBusy(true);
    try {
      onSaved(await api.saveListing(listing.id, { version: listing.version, ...changes }));
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiFailure && err.code === "invalid_input") {
        const fields: Record<string, TextKey> = {};
        const attributes = new Set<string>();
        for (const detail of err.details) {
          if (detail.startsWith("attributes")) attributes.add(detail);
          else if (!/^(?:videoLinks|video_links)/.test(detail))
            fields[detail] = detail === "capMax" ? "capErrOrder" : "fieldInvalid";
        }
        setErrors(fields);
        setBadAttributes(attributes);
        setBadVideos(new Set(videoErrorIndexes(err.details, videos.length)));
        setNotice("invalid");
      } else if (err instanceof ApiFailure && err.code === "no_changes") {
        setNotice("noChanges");
      } else if (err instanceof ApiFailure && err.code === "revision_pending") {
        setNotice("pendingExists");
        onStale();
      } else {
        if (err instanceof ApiFailure && err.code === "version_conflict") onStale();
        setFailedText(apiErrorText(err, t));
        setNotice("failed");
      }
    }
  };

  const bad = (key: string) => errors[key] !== undefined;
  const described = (key: string) => (bad(key) ? `${id}-${key}-error` : undefined);
  const errorLine = (key: string) => {
    const message = errors[key];
    return message === undefined ? null : (
      <p className="field-error" id={`${id}-${key}-error`}>
        {t[message]}
      </p>
    );
  };

  const text = (
    key: string,
    label: string,
    value: string,
    set: (value: string) => void,
    options: { multiline?: boolean; max: number; lang?: "ru" | "uz"; required: boolean },
  ) => {
    const inputId = `${id}-${key}`;
    const common = {
      id: inputId,
      className: "field",
      value,
      maxLength: options.max,
      "aria-invalid": bad(key) || undefined,
      "aria-describedby": described(key),
      onChange: (event: { target: { value: string } }) => set(event.target.value),
    };
    return (
      <div className="form-row">
        <label className="field-label" htmlFor={inputId}>
          {label} <FieldMark required={options.required} t={t} />
        </label>
        {options.multiline ? (
          <textarea {...common} rows={5} lang={options.lang} />
        ) : (
          <input {...common} autoComplete="off" lang={options.lang} />
        )}
        {errorLine(key)}
      </div>
    );
  };

  const capacity = (key: "capMin" | "capMax", label: string) => {
    const inputId = `${id}-${key}`;
    return (
      <div className="form-row">
        <label className="field-label" htmlFor={inputId}>
          {label} <FieldMark required t={t} />
        </label>
        <NumberStepper
          id={inputId}
          value={place[key]}
          min={CAPACITY_RANGE.min}
          max={CAPACITY_RANGE.max}
          maxLength={String(CAPACITY_RANGE.max).length}
          onChange={(value) => setPlace((prev) => ({ ...prev, [key]: value }))}
          decrementLabel={`${label}: ${t.capacityLess}`}
          incrementLabel={`${label}: ${t.capacityMore}`}
          aria-invalid={bad(key)}
          aria-describedby={described(key)}
        />
        {errorLine(key)}
      </div>
    );
  };

  const notices: Record<Exclude<Notice, null>, string> = {
    noChanges: t.proposalNoChanges,
    invalid: t.proposalInvalid,
    failed: failedText ?? t.actionFailed,
    pendingExists: t.proposalPendingExists,
  };
  const maxVideos = category?.maxVideoLinks ?? 0;

  return (
    <Dialog
      open
      title={groupTitle(group, t)}
      className="sheet-wide"
      returnFocus={returnFocus}
      onClose={requestClose}
      actions={
        <>
          <button type="button" className="ui-btn ui-btn-secondary" disabled={busy} onClick={requestClose}>
            {t.cancel}
          </button>
          <button
            type="submit"
            form={`${id}-form`}
            className="ui-btn ui-btn-primary"
            disabled={busy || !dirty}
            aria-busy={busy || undefined}
          >
            {moderated ? t.editSend : t.editSave}
          </button>
        </>
      }
    >
      <form id={`${id}-form`} className="proposal-form" onSubmit={submit} noValidate>
        {group === "basics" ? (
          <>
            {text("name", t.nameLabel, basics.name, (v) => setBasics((p) => ({ ...p, name: v })), {
              max: 80,
              required: true,
            })}
            {text(
              "descriptionRu",
              t.descriptionRuLabel,
              basics.descriptionRu,
              (v) => setBasics((p) => ({ ...p, descriptionRu: v })),
              { multiline: true, max: DESCRIPTION_MAX, lang: "ru", required: true },
            )}
            {text(
              "descriptionUz",
              t.descriptionUzLabel,
              basics.descriptionUz,
              (v) => setBasics((p) => ({ ...p, descriptionUz: v })),
              { multiline: true, max: DESCRIPTION_MAX, lang: "uz", required: true },
            )}
          </>
        ) : null}

        {group === "place" ? (
          <>
            {hasDistrict(category) ? (
              <DistrictField
                id={`${id}-districtCode`}
                value={place.districtCode}
                onChange={(value) => setPlace((prev) => ({ ...prev, districtCode: value }))}
                bad={bad("districtCode")}
                t={t}
                lang={lang}
              />
            ) : null}
            {text(
              "addressRu",
              t.addressRuLabel,
              place.addressRu,
              (v) => setPlace((p) => ({ ...p, addressRu: v })),
              { max: 300, lang: "ru", required: false },
            )}
            {text(
              "addressUz",
              t.addressUzLabel,
              place.addressUz,
              (v) => setPlace((p) => ({ ...p, addressUz: v })),
              { max: 300, lang: "uz", required: false },
            )}
            {hasCapacity(category) ? (
              <div className="cap-row">
                {capacity("capMin", t.capMinLabel)}
                {capacity("capMax", t.capMaxLabel)}
              </div>
            ) : null}
          </>
        ) : null}

        {group === "attributes" && category ? (
          <>
            <p className="note">{t.attributesLead}</p>
            <AttributesForm
              category={category}
              drafts={drafts}
              onChange={(key: string, value: AttributeDraft) =>
                setDrafts((prev) => ({ ...prev, [key]: value }))
              }
              invalid={badAttributes}
              t={t}
              lang={lang}
              idPrefix={`${id}-attr`}
            />
          </>
        ) : null}

        {group === "videos" && category ? (
          <>
            <p className="note">{fill(t.videoLead, { max: maxVideos })}</p>
            <VideoFields
              id={id}
              videos={videos}
              setVideos={(update) => setVideos(update)}
              bad={badVideos}
              setBad={setBadVideos}
              max={maxVideos}
              t={t}
            />
          </>
        ) : null}

        {moderated ? <p className="note">{t.liveSaveNote}</p> : null}
        {notice ? (
          <p className={notice === "noChanges" ? "note" : "form-error"} role="alert">
            {notices[notice]}
          </p>
        ) : null}
      </form>
    </Dialog>
  );
}
