/* Витрина — выбранная витрина как есть в базе (то, что видит клиент). Название, описания,
   данные витрины категории и ссылки на видео владелец кабинета меняет предложением
   (Proposal.tsx), фото — загрузкой здесь: и то, и другое проверяет команда, до одобрения
   клиенты видят прежнее (сказано один раз — вверху экрана). Цена «от» — из услуг: здесь
   только она и ссылка на «Услуги», списка услуг второй раз нет. Адрес, район, вместимость и
   телефон меняет менеджер — под ними код вендора для разговора с ним. Сотрудник площадки
   (роль member) витрину только смотрит. Рейтинга нет: его на первом запуске не показываем.

   Витрина не на сайте — сверху чек-лист «что осталось до публикации» (Readiness): почему она
   не опубликована, пункты партнёра — каждый с кнопкой туда, где он делается (услуги, фото,
   предложение изменений), и одной строкой — что сделает команда (район, договор, СТИР…).
   Новый партнёр попадает сюда из входящих (строка «что дальше»).

   Фото — по правилу категории (photoPolicy). no_people: на фото не должно быть лиц —
   предупреждение всегда на виду, без галочки «лиц нет» (не отмеченной заранее) файлы не
   выбрать (X-No-Faces). portfolio (фото и видео, студия): люди на снимках бывают — вторая
   галочка «люди согласны на публикацию» (X-Photo-Consent) вместо «лиц нет»; нужна хоть одна.
   Каждый файл перекодирует браузер (compressForUpload: без EXIF и геопозиции) и отправляет
   по одному; новое фото ждёт модератора. Удаление — через подтверждение. Порядок и обложку
   выбирает команда.

   Порядок: чек-лист (если витрина не на сайте), изменения (предложение на проверке, отказ с
   причиной и кнопка «Предложить» — до фото, а не после двух экранов сведений), затем фото и
   сведения. На компьютере — две колонки: фото слева, сведения справа; изменения над ними во
   всю ширину, поля формы парами (RU рядом с UZ). */

import { isImageError } from "@bayramm/media";
import { compressForUpload } from "@bayramm/media/browser";
import type { VendorListing, VendorListingRef, VendorPhoto, VendorRole } from "@bayramm/shared/api/vendor";
import {
  attributeLabel,
  type CategoryConfig,
  categoryConfig,
  priceUnitLabel,
  serviceTypeLabel,
} from "@bayramm/shared/categories";
import { Checkbox, ConfirmSheet, FileDrop } from "@bayramm/ui/react";
import { type MouseEvent, type ReactNode, useRef, useState } from "react";
import { AttributeFacts } from "./Attributes";
import { ApiFailure, api } from "./api";
import { categoryName } from "./category";
import { errorText } from "./errors";
import { formatMoney, formatPhone } from "./format";
import { fill, type TextKey, textOf, type VendorDict } from "./i18n";
import { Icon } from "./icons";
import { ListingPicker } from "./ListingPicker";
import { Proposal } from "./Proposal";
import { type Location, type Navigate, pathOf } from "./router";
import { Empty, Heading, LoadError, Loading, type ScreenProps } from "./ui";
import { useLoad } from "./useLoad";

/** Что можно выбрать: HEIC с iPhone браузер перекодирует сам, где умеет */
const PHOTO_ACCEPT = "image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif";

/** Почему файл не загрузился: код проверки файла (в браузере или на сервере) или ответ API */
export function uploadErrorText(err: unknown, t: VendorDict): string {
  const known = (key: string) => {
    const text = textOf(t, key);
    return text === key ? t.up_failed : text;
  };
  if (isImageError(err)) return known(`img_${err.code}`);
  if (err instanceof ApiFailure) {
    if (err.code === "invalid_image") return known(`img_${err.details[0] ?? ""}`);
    return known(`up_${err.code}`);
  }
  return t.up_failed;
}

function Capacity({ listing, t }: { listing: VendorListing; t: VendorDict }) {
  if (listing.capMax === null) return <>{t.notSet}</>;
  return (
    <>
      {listing.capMin !== null
        ? fill(t.capRange, { min: listing.capMin, max: listing.capMax })
        : fill(t.capUpTo, { max: listing.capMax })}
    </>
  );
}

interface PhotosProps {
  readonly listing: VendorListing;
  /** Правило фото категории: portfolio — люди на фото с их согласия */
  readonly portfolio: boolean;
  readonly t: VendorDict;
  /** Владелец кабинета: загружает и удаляет; сотрудник площадки только смотрит */
  readonly owner: boolean;
  /** После загрузки и удаления — перечитать карточку: меняются фото и блокеры */
  readonly onChanged: () => Promise<void>;
}

interface Problem {
  readonly key: string;
  readonly text: string;
}

function Photos({ listing, portfolio, t, owner, onChanged }: PhotosProps) {
  const { photos, photoLimits } = listing;
  const [ack, setAck] = useState(false);
  const [consent, setConsent] = useState(false);
  const acknowledged = ack || (portfolio && consent);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [problems, setProblems] = useState<readonly Problem[]>([]);
  const [removing, setRemoving] = useState<VendorPhoto | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const title = useRef<HTMLHeadingElement>(null);
  // Куда вернуть фокус после подтверждения: на кнопку, а если фото удалено — на заголовок
  const focusBack = useRef<HTMLElement | null>(null);
  const room = Math.max(0, photoLimits.max - photos.length);
  const uploading = progress !== null;

  const upload = async (picked: readonly File[]) => {
    const files = picked.slice(0, room);
    if (files.length === 0) return;
    setProblems([]);
    const found: Problem[] = [];
    for (const [index, file] of files.entries()) {
      setProgress({ done: index, total: files.length });
      try {
        // Перекодирование всегда: EXIF и геопозиция не уходят дальше телефона
        const photo = await compressForUpload(file);
        await api.uploadPhoto(listing.id, photo.blob, { noFaces: ack, consent: portfolio && consent });
      } catch (err) {
        found.push({
          key: `${index}:${file.name}`,
          text: fill(t.photoFailed, { name: file.name, why: uploadErrorText(err, t) }),
        });
      }
    }
    if (picked.length > files.length) {
      found.push({
        key: "skipped",
        text: fill(t.photosSkipped, { n: picked.length - files.length, max: photoLimits.max }),
      });
    }
    await onChanged();
    setProgress(null);
    setProblems(found);
    // Подтверждение — про выбранные фото: следующие — снова с галочкой
    setAck(false);
    setConsent(false);
  };

  const remove = async () => {
    if (!removing) return;
    setRemoveBusy(true);
    setRemoveError(null);
    try {
      await api.deletePhoto(listing.id, removing.id);
    } catch (err) {
      // Фото уже нет (удалили с другого устройства) — как удалено
      if (!(err instanceof ApiFailure && err.code === "not_found")) {
        setRemoveError(
          err instanceof ApiFailure && err.code === "publish_blocked"
            ? fill(t.photoDeleteBlocked, { min: photoLimits.min })
            : errorText(err, t),
        );
        setRemoveBusy(false);
        return;
      }
    }
    await onChanged();
    // Кнопки удалённого фото больше нет — фокус на заголовок раздела
    focusBack.current = title.current;
    setRemoveBusy(false);
    setRemoving(null);
  };

  return (
    <section className="panel" aria-labelledby="photos-title">
      <h2 className="section-title" id="photos-title" ref={title} tabIndex={-1}>
        {t.photos}
      </h2>
      <p className="note">{fill(t.photosLimits, { min: photoLimits.min, max: photoLimits.max })}</p>
      {photos.length === 0 ? (
        <p className="note">{t.noPhotos}</p>
      ) : (
        <ul className="photos">
          {photos.map((photo, index) => (
            <li key={photo.id}>
              <img
                src={photo.src}
                srcSet={photo.srcSet}
                sizes="(min-width: 1024px) 220px, (min-width: 720px) 30vw, 50vw"
                width={photo.width}
                height={photo.height}
                alt={`${listing.name} — ${t.photos} ${index + 1}`}
                loading={index < 2 ? "eager" : "lazy"}
                decoding="async"
              />
              {photo.moderation !== "approved" ? (
                <span className={`chip photo-chip chip-${photo.moderation === "declined" ? "off" : "wait"}`}>
                  {photo.moderation === "declined" ? t.photoDeclined : t.photoPending}
                </span>
              ) : null}
              {owner ? (
                <button
                  type="button"
                  className="btn btn-danger photo-delete"
                  aria-label={fill(t.photoDeleteLabel, { n: index + 1 })}
                  disabled={uploading}
                  onClick={(event) => {
                    focusBack.current = event.currentTarget;
                    setRemoveError(null);
                    setRemoving(photo);
                  }}
                >
                  {t.photoDelete}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {owner ? (
        <>
          <p className="notice notice-warn">{portfolio ? t.portfolioWarning : t.noFacesWarning}</p>
          {room > 0 ? (
            <div className="upload">
              {portfolio ? (
                <Checkbox checked={consent} onChange={setConsent} disabled={uploading}>
                  {t.consentAck}
                </Checkbox>
              ) : null}
              <Checkbox checked={ack} onChange={setAck} disabled={uploading}>
                {t.noFacesAck}
              </Checkbox>
              <FileDrop
                title={t.addPhotos}
                hint={t.photosDrop}
                accept={PHOTO_ACCEPT}
                multiple={room > 1}
                disabled={!acknowledged || uploading}
                onFiles={(files) => void upload(files)}
              />
            </div>
          ) : (
            <p className="note">{fill(t.photosFull, { max: photoLimits.max })}</p>
          )}
          {progress ? (
            <p className="status-line" role="status">
              {fill(t.uploading, { n: progress.done + 1, total: progress.total })}
            </p>
          ) : null}
          {problems.length > 0 ? (
            <div className="notice notice-error photo-problems" role="alert">
              <ul>
                {problems.map((problem) => (
                  <li key={problem.key}>{problem.text}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <ConfirmSheet
            open={removing !== null}
            title={t.photoDeleteQ}
            text={t.photoDeleteText}
            confirmLabel={t.photoDelete}
            cancelLabel={t.cancel}
            tone="danger"
            busy={removeBusy}
            error={removeError ?? undefined}
            onConfirm={() => void remove()}
            onCancel={() => setRemoving(null)}
            returnFocus={focusBack}
          />
        </>
      ) : null}
    </section>
  );
}

/** Пункт чек-листа готовности: что сделать и кнопка туда, где это делается */
export interface Todo {
  readonly key: string;
  /** Что сделать: пункты с одной и той же кнопкой — строками одного пункта */
  readonly lines: readonly string[];
  readonly action?: { readonly label: string; readonly run: () => void };
}

/** Пункты партнёра — их он делает сам; остальные коды готовности делает команда Bayramm */
const VENDOR_BLOCKERS: ReadonlySet<string> = new Set([
  "price",
  "packages",
  "photos",
  "descriptions",
  "attributes",
]);

/** Что сказано о витрине не на сайте — по статусу */
const STATUS_LEAD: Readonly<Record<VendorListing["status"], TextKey | null>> = {
  lead: "readyDraft",
  draft: "readyDraft",
  review: "readyReview",
  active: null,
  suspended: "readySuspended",
  rejected: "readyRejected",
};

/** Куда ведут кнопки чек-листа */
interface TodoRoutes {
  readonly services: () => void;
  readonly photos: () => void;
  readonly propose: () => void;
}

/** Пункты партнёра: что сделать самому и где (коды готовности базы и пустые данные витрины) */
export function vendorTodos(
  listing: VendorListing,
  category: CategoryConfig | undefined,
  t: VendorDict,
  lang: "ru" | "uz",
  go: TodoRoutes,
): Todo[] {
  const blockers = new Set(listing.blockers);
  const todos: Todo[] = [];
  const toServices = { label: t.toServices, run: go.services };
  // Форма изменений — блок прямо под чек-листом со своей «Предложить изменения»: тут другая подпись
  const propose = { label: t.toFill, run: go.propose };
  if (blockers.has("price")) todos.push({ key: "price", lines: [t.todoPrice], action: toServices });
  if (blockers.has("packages")) {
    const list =
      category && category.requiredServices.length > 0
        ? category.requiredServices.map((type) => serviceTypeLabel(lang, category, type)).join(", ")
        : t.blocker_packages;
    todos.push({ key: "packages", lines: [fill(t.todoServices, { list })], action: toServices });
  }
  if (blockers.has("photos")) {
    const ready = listing.photos.filter((photo) => photo.moderation !== "declined").length;
    todos.push({
      key: "photos",
      lines: [fill(t.todoPhotos, { n: ready, min: listing.photoLimits.min })],
      action: { label: t.toPhotos, run: go.photos },
    });
  }
  if (blockers.has("descriptions"))
    todos.push({ key: "descriptions", lines: [t.todoDescriptions], action: propose });
  if (blockers.has("attributes") || listing.missingAttributes.length > 0) {
    const list =
      category && listing.missingAttributes.length > 0
        ? // «;»: у подписи бывает единица через запятую («Готовый материал через, дней»)
          listing.missingAttributes.map((key) => attributeLabel(lang, category, key)).join("; ")
        : t.blocker_attributes;
    todos.push({ key: "attributes", lines: [fill(t.todoAttributes, { list })], action: propose });
  }
  // Одна кнопка — один пункт: «описание» и «данные витрины» делаются одним предложением, цена и
  // обязательные услуги — в «Услугах»; две одинаковые кнопки подряд только путали бы
  const merged: Todo[] = [];
  for (const todo of todos) {
    const same = merged.findIndex((m) => m.action?.label === todo.action?.label);
    const into = merged[same];
    if (into && todo.action) merged[same] = { ...into, lines: [...into.lines, ...todo.lines] };
    else merged.push(todo);
  }
  return merged;
}

interface ReadinessProps {
  readonly listing: VendorListing;
  readonly category: CategoryConfig | undefined;
  readonly t: VendorDict;
  readonly lang: "ru" | "uz";
  readonly owner: boolean;
  readonly go: TodoRoutes;
}

/**
 * Готовность к публикации — чек-лист: почему витрины нет на сайте, что сделать партнёру (с
 * кнопкой туда, где это делается) и одной строкой — что сделает команда. Опубликованная
 * витрина, где делать нечего, — блока нет
 */
function Readiness({ listing, category, t, lang, owner, go }: ReadinessProps) {
  const todos = vendorTodos(listing, category, t, lang, go);
  const team = listing.blockers.filter((code) => !VENDOR_BLOCKERS.has(code));
  const leadKey = STATUS_LEAD[listing.status];
  const lead =
    leadKey === "readyDraft" && todos.length === 0 ? t.readyDraftDone : leadKey ? t[leadKey] : null;
  if (lead === null && todos.length === 0) return null;
  const reason = listing.statusReason ? (
    <p className="note">{fill(t.reasonLine, { reason: listing.statusReason })}</p>
  ) : null;
  if (todos.length === 0 && team.length === 0) {
    return (
      <div className="notice readiness">
        <p>{lead}</p>
        {reason}
      </div>
    );
  }
  return (
    <section className="panel readiness" aria-labelledby="ready-title">
      <h2 className="section-title" id="ready-title">
        {t.blockersTitle}
      </h2>
      {lead ? <p className="lead">{lead}</p> : null}
      {reason}
      {todos.length > 0 ? (
        <ul className="todo">
          {todos.map((todo) => (
            <li key={todo.key} className="todo-item">
              <span className="todo-text">
                <span className="todo-mark" aria-hidden="true" />
                <span className="todo-lines">
                  {todo.lines.map((line) => (
                    <span key={line} className="todo-line">
                      {line}
                    </span>
                  ))}
                </span>
              </span>
              {owner && todo.action ? (
                <button type="button" className="btn btn-ghost todo-go" onClick={todo.action.run}>
                  {todo.action.label}
                  <span className="sr-only">: {todo.lines.join("; ")}</span>
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {!owner && todos.length > 0 ? <p className="note">{t.todoOwner}</p> : null}
      {team.length > 0 ? (
        <p className="note">
          {fill(t.todoTeam, { list: team.map((code) => textOf(t, `blocker_${code}`)).join(", ") })}
        </p>
      ) : null}
    </section>
  );
}

/** Ссылка на раздел без перезагрузки (новая вкладка, окно — как решит браузер) */
function SectionLink({
  to,
  navigate,
  className,
  children,
}: {
  to: Location;
  navigate: Navigate;
  className: string;
  children: ReactNode;
}) {
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(to);
  };
  return (
    <a className={className} href={pathOf(to)} onClick={onClick}>
      {children}
    </a>
  );
}

interface VenueProps extends ScreenProps {
  readonly listings: readonly VendorListingRef[];
  readonly listingId: string | null;
  readonly onListing: (id: string) => void;
  readonly vendorCode: string;
  /** Роль в кабинете: витрину (фото и предложения) меняет только владелец */
  readonly role: VendorRole;
  /** Выбор витрины — в боковой панели (компьютер) */
  readonly inSidebar?: boolean;
  readonly navigate: Navigate;
}

export function Venue({
  t,
  lang,
  headingRef,
  listings,
  listingId,
  onListing,
  vendorCode,
  role,
  inSidebar = false,
  navigate,
}: VenueProps) {
  const [listing, reload, , refresh] = useLoad<VendorListing>(listingId, (id) => api.listing(id));
  const owner = role === "owner";
  // Тихо, чтобы список ошибок загрузки и фокус остались; не вышло — обычная загрузка с повтором
  const refreshListing = async () => {
    if (!(await refresh())) reload();
  };

  if (listings.length === 0 || !listingId) {
    return (
      <section className="page" aria-labelledby="page-title">
        <Heading headingRef={headingRef}>{t.card}</Heading>
        <Empty icon="hall" title={t.noListings} text={t.noListingsText} />
        <p className="note">{fill(t.vendorCode, { code: vendorCode })}</p>
      </section>
    );
  }

  // Выбор витрины на экране (телефон, планшет) уже называет её — второй раз имя не нужно
  const pickerShown = listings.length > 1 && !inSidebar;
  return (
    <section className="page" aria-labelledby="page-title">
      <Heading headingRef={headingRef}>{t.card}</Heading>
      <ListingPicker
        listings={listings}
        value={listingId}
        onChange={(id) => id && onListing(id)}
        t={t}
        lang={lang}
        inSidebar={inSidebar}
        line={false}
      />
      <p className="promise">
        <Icon name="info" size={17} />
        <span>{owner ? t.venueNote : t.venueNoteMember}</span>
      </p>

      {listing.state === "loading" ? <Loading t={t} kind="card" /> : null}
      {listing.state === "error" ? <LoadError t={t} onRetry={reload} error={listing.error} /> : null}
      {listing.state === "ready" ? (
        <VenueCard
          listing={listing.data}
          t={t}
          lang={lang}
          owner={owner}
          showName={!pickerShown}
          vendorCode={vendorCode}
          navigate={navigate}
          onChanged={refreshListing}
        />
      ) : null}
    </section>
  );
}

interface VenueCardProps {
  readonly listing: VendorListing;
  readonly t: VendorDict;
  readonly lang: "ru" | "uz";
  readonly owner: boolean;
  /** Имя витрины заголовком: выбора витрины на экране нет */
  readonly showName: boolean;
  readonly vendorCode: string;
  readonly navigate: Navigate;
  readonly onChanged: () => Promise<void>;
}

function VenueCard({ listing, t, lang, owner, showName, vendorCode, navigate, onChanged }: VenueCardProps) {
  const category = categoryConfig(listing.categoryCode);
  const fields = category?.listingFields ?? ["guest_capacity", "district"];
  // Кнопка чек-листа «Предложить изменения»: растёт — форма предложения открывается
  const [propose, setPropose] = useState(0);
  const go: TodoRoutes = {
    services: () => navigate({ route: "services" }),
    // Фото — на этом же экране: фокус на заголовок блока, браузер прокрутит к нему
    photos: () => document.getElementById("photos-title")?.focus(),
    propose: () => setPropose((n) => n + 1),
  };
  return (
    <article className="venue">
      <div className="detail-top">
        {showName ? <h2 className="venue-name">{listing.name}</h2> : null}
        <span className="venue-chips">
          {/* Имя и категорию уже называет выбор витрины на экране — здесь только статус */}
          {showName ? (
            <span className="chip chip-cat">{categoryName(lang, listing.categoryCode)}</span>
          ) : null}
          <span className={`chip chip-${listing.status === "active" ? "done" : "wait"}`}>
            {textOf(t, `ls_${listing.status}`)}
          </span>
        </span>
      </div>

      <Readiness listing={listing} category={category} t={t} lang={lang} owner={owner} go={go} />

      {/* Изменения — сразу под чек-листом: предложение на проверке, отказ с причиной и сама
        кнопка «Предложить» не прячутся под фото и сведениями (на телефоне — через два экрана).
        Ключ — витрина: при смене витрины форма и предложения — заново */}
      <Proposal key={listing.id} listing={listing} t={t} lang={lang} owner={owner} openSignal={propose} />

      <div className="venue-grid">
        {/* Ключ — витрина: галочка и ошибки загрузки другой витрины не переносятся.
          Не тот же, что у Proposal: ключи соседей в одном родителе обязаны различаться */}
        <Photos
          key={`photos-${listing.id}`}
          listing={listing}
          portfolio={category?.photoPolicy === "portfolio"}
          t={t}
          owner={owner}
          onChanged={onChanged}
        />

        <div className="venue-side">
          {/* Цена и телефон — во всю ширину: «от 25 млн сум за мероприятие» и номер в
            половине строки телефона переносились посреди числа */}
          <dl className="facts">
            <div className="facts-wide">
              <dt>{t.priceLabel}</dt>
              <dd>
                {listing.priceFromUzs !== null
                  ? `${fill(t.priceFrom, { price: formatMoney(listing.priceFromUzs, t, lang) })} ${priceUnitLabel(
                      lang,
                      listing.priceUnit,
                    )}`
                  : t.notSet}
                <span className="fact-sub fact-note">
                  {listing.priceFromUzs !== null ? t.priceFromServices : t.priceFromNone}
                </span>
                <SectionLink
                  to={{ route: "services" }}
                  navigate={navigate}
                  className="btn btn-ghost fact-link"
                >
                  {t.toServices}
                </SectionLink>
              </dd>
            </div>
            {fields.includes("guest_capacity") ? (
              <div>
                <dt>{t.capacity}</dt>
                <dd>
                  <Capacity listing={listing} t={t} />
                </dd>
              </div>
            ) : null}
            {fields.includes("district") || listing.districtCode ? (
              <div>
                <dt>{t.district}</dt>
                <dd>{listing.districtCode ? textOf(t, `dist_${listing.districtCode}`) : t.notSet}</dd>
              </div>
            ) : null}
            <div className="facts-wide">
              <dt>{t.phoneLabel}</dt>
              <dd className="fact-phone">{listing.phone ? formatPhone(listing.phone) : t.notSet}</dd>
            </div>
            <div className="facts-wide">
              <dt>{t.address}</dt>
              <dd>{listing.address[lang] || t.notSet}</dd>
            </div>
          </dl>
          <p className="note">{fill(t.managerFacts, { code: vendorCode })}</p>

          {category && category.attributes.length > 0 ? (
            <section className="panel" aria-labelledby="venue-attrs-title">
              <h3 className="panel-title" id="venue-attrs-title">
                {t.attributesTitle}
              </h3>
              {Object.keys(listing.attributes).length === 0 ? (
                <p className="note">{t.notSet}</p>
              ) : (
                <AttributeFacts category={category} attributes={listing.attributes} t={t} lang={lang} />
              )}
            </section>
          ) : null}

          {listing.videoLinks.length > 0 ? (
            <section className="panel" aria-labelledby="venue-video-title">
              <h3 className="panel-title" id="venue-video-title">
                {t.videoTitle}
              </h3>
              <ul className="video-list">
                {listing.videoLinks.map((link) => (
                  <li key={link}>{link}</li>
                ))}
              </ul>
            </section>
          ) : null}

          <div className="panel">
            <p className="panel-title">{t.description}</p>
            <p className="description">{listing.description[lang] || t.notSet}</p>
          </div>
        </div>
      </div>
    </article>
  );
}
