/* Вендор: витрины (по одной на категорию, бывает и несколько), пользователи кабинета, чек-лист
   проверки, контакт с реквизитами и ответы на заявки. Новый вендор — форма из четырёх полей
   (категория первой витрины, название, контактное лицо, телефон); остальное дописывают здесь, в
   «Реквизитах». Страница короткая, по порядку важности: что с витринами и кабинетом — сверху, чек-лист
   — только пока проверка ниже 4/4 (потом одна строка), контакт — одна кнопка «Показать телефоны»,
   реквизиты свёрнуты и правятся на месте, ответы на заявки — одна строка (VendorResponsePanel).
   Только что заведённый вендор — с раскрытыми «Реквизитами»: без них проверку (СТИР) не отметить.

   В шапке — «Ещё» на любой ширине: заявки вендора (поиск по коду), журнал действий с ним и
   удалить. Удалить вендора целиком — администратор, только пока ни у одной витрины не было заявок и
   ни одна не на проверке и не в каталоге; подтверждение — кодом вендора, а почему нельзя — в самой
   шторке, а не на странице. */

import { formatUzPhone } from "@bayramm/shared";
import type {
  ChecklistItem,
  StaffDictionaries,
  VendorDetail,
  VendorInput,
  VendorPhones,
} from "@bayramm/shared/api/staff";
import { Checkbox, ConfirmSheet, useToast } from "@bayramm/ui/react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { type Failure, useCan, useLoad, useSession } from "../api";
import { CategoryChip, formatPrice } from "../categories";
import { formatMoment } from "../format";
import { readQuery, writeQuery } from "../router";
import { apiErrorText, t } from "../texts";
import {
  deleteFailureText,
  ErrorText,
  focusSection,
  Link,
  LoadedView,
  type MenuAction,
  OverflowMenu,
  StatusPill,
  useEntityTitle,
  useNavigate,
} from "../ui";
import { VendorResponsePanel } from "./Metrics";
import { VendorForm } from "./VendorForm";
import { VendorUsers } from "./VendorUsers";

const CHECKLIST: readonly ChecklistItem[] = ["contract", "stir", "contacts", "pdConsent"];

/** Метка в адресе: вендора только что завели (VendorNewPage) */
const CREATED = ["created"] as const;

/**
 * Пункты готовности, которые отмечают в «Проверке вендора» на этой же странице: у витрин их
 * не повторяем — иначе четыре одинаковых строки у каждой витрины
 */
const VENDOR_CHECKS: ReadonlySet<string> = new Set(["contract", "stir", "contacts", "pd_consent"]);

export function VendorNewPage({ dictionaries }: { dictionaries: StaffDictionaries | null }) {
  const { api } = useSession();
  const navigate = useNavigate();
  const create = useCallback(
    async (body: VendorInput): Promise<Failure | null> => {
      const result = await api.post<VendorDetail>("/staff/vendors", body);
      if (!result.ok) return result;
      // Вендор создан — форма сохранена: переход без вопроса о несохранённом; на его странице —
      // раскрытые «Реквизиты» (?created=1)
      navigate({ name: "vendor", id: result.data.id, query: { created: "1" } }, { force: true });
      return null;
    },
    [api, navigate],
  );
  return (
    <VendorForm vendor={null} dictionaries={dictionaries} onSubmit={create} submitLabel={t.createVendor} />
  );
}

export function VendorPage({ id, dictionaries }: { id: string; dictionaries: StaffDictionaries | null }) {
  const { loaded, reload, set } = useLoad<VendorDetail>(`/staff/vendors/${id}`);
  // Только что заведён — «Реквизиты» раскрыты; из адреса метку убираем: обновление страницы и
  // «назад» её не повторяют
  const [created] = useState(() => readQuery(CREATED).created === "1");
  useEffect(() => writeQuery(CREATED, {}), []);
  return (
    <LoadedView loaded={loaded} onRetry={reload} skeleton="detail">
      {(vendor) => (
        <VendorView vendor={vendor} dictionaries={dictionaries} onChange={set} created={created} />
      )}
    </LoadedView>
  );
}

interface VendorViewProps {
  vendor: VendorDetail;
  dictionaries: StaffDictionaries | null;
  onChange: (vendor: VendorDetail) => void;
  /** Только что заведён: «Реквизиты» раскрыты */
  created: boolean;
}

function VendorView({ vendor, dictionaries, onChange, created }: VendorViewProps) {
  const { api } = useSession();
  const can = useCan();
  const toast = useToast();
  useEntityTitle(vendor.name ?? vendor.contacts.legalName ?? vendor.code);
  const save = useCallback(
    async (body: VendorInput): Promise<Failure | null> => {
      const result = await api.patch<VendorDetail>(`/staff/vendors/${vendor.id}`, body);
      if (!result.ok) return result;
      onChange(result.data);
      toast(t.saved, { tone: "success" });
      return null;
    },
    [api, vendor.id, onChange, toast],
  );

  return (
    <div className="stack">
      <div className="vendor-head">
        <p className="sub">
          {t.vendorCode}: {vendor.code}
          {vendor.manager?.name ? ` · ${t.fields.managerId}: ${vendor.manager.name}` : ""}
        </p>
        <VendorActions vendor={vendor} />
      </div>
      <div className="columns columns-vendor">
        <div className="stack">
          <Listings vendor={vendor} />
          <VendorUsers vendor={vendor} onChange={onChange} />
        </div>
        <div className="stack">
          <Checklist vendor={vendor} onChange={onChange} />
          <Contact
            vendor={vendor}
            dictionaries={dictionaries}
            onSubmit={save}
            canWrite={can("vendors.write")}
            startEditing={created}
          />
          {can("metrics.read") && <VendorResponsePanel vendorId={vendor.id} />}
        </div>
      </div>
    </div>
  );
}

// ── «Ещё» в шапке: заявки, журнал, удаление ────────────────────────────────

/**
 * «Ещё» на любой ширине: заявки вендора (поиск по коду), журнал действий с ним и «Удалить
 * вендора» — только администратор. Почему удалить нельзя, сервер говорит заранее (deleteBlocker):
 * пункт открывает шторку, где об этом сказано словами и подтвердить нечем — на странице причины
 * нет. Подтверждение — кодом вендора (V101): удаляется всё сразу, вернуть нельзя. Удалили — к списку
 * вендоров без вопроса о несохранённом и без записи удалённого в истории
 */
function VendorActions({ vendor }: { vendor: VendorDetail }) {
  const { api } = useSession();
  const can = useCan();
  const navigate = useNavigate();
  const codeId = useId();
  const more = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const blocker = blocked ?? vendor.deleteBlocker;
  const typed = code.trim().toUpperCase() === vendor.code.toUpperCase();

  const actions: MenuAction[] = [
    ...(can("requests.read")
      ? [
          {
            key: "requests",
            label: t.vendorRequests,
            run: () => navigate({ name: "requests", query: { q: vendor.code } }),
          },
        ]
      : []),
    ...(can("audit.read")
      ? [
          {
            key: "journal",
            label: t.vendorJournal,
            run: () => navigate({ name: "audit", query: { type: "vendor", object: vendor.id } }),
          },
        ]
      : []),
    ...(can("vendors.delete")
      ? [{ key: "delete", label: t.vendorDelete, danger: true, run: () => setOpen(true) }]
      : []),
  ];

  const remove = async () => {
    setBusy(true);
    const result = await api.del<null>(`/staff/vendors/${vendor.id}`);
    setBusy(false);
    if (!result.ok) {
      setFailure(result);
      // Пока смотрели, появилась заявка или витрину отправили на проверку
      if (result.code === "vendor_in_use") setBlocked(result.details[0] ?? "published");
      return;
    }
    setOpen(false);
    navigate({ name: "vendors" }, { force: true, replace: true });
  };
  const close = () => {
    setOpen(false);
    setCode("");
    setFailure(null);
  };

  return (
    <>
      <OverflowMenu
        title={t.actionsTitle}
        context={t.vendorActionsContext}
        buttonRef={more}
        className="btn btn-sm"
        actions={actions}
      />
      {can("vendors.delete") ? (
        <ConfirmSheet
          open={open}
          title={t.vendorDeleteTitle}
          text={
            blocker ? (
              <p>{t.vendorDeleteBlocked[blocker] ?? t.api.vendor_in_use}</p>
            ) : (
              <>
                <p>{t.vendorDeleteText(vendor.code)}</p>
                <label htmlFor={codeId}>{t.vendorDeleteCode(vendor.code)}</label>
                <input
                  id={codeId}
                  className="input"
                  value={code}
                  maxLength={16}
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  enterKeyHint="done"
                  onChange={(event) => setCode(event.target.value)}
                />
              </>
            )
          }
          confirmLabel={t.vendorDelete}
          cancelLabel={t.cancel}
          tone="danger"
          busy={busy}
          confirmDisabled={blocker !== null || !typed}
          error={failure && !blocker ? deleteFailureText(failure, t.vendorDeleteBlocked) : undefined}
          returnFocus={more}
          onConfirm={() => void remove()}
          onCancel={close}
        />
      ) : null}
    </>
  );
}

// ── чек-лист ───────────────────────────────────────────────────────────────

/**
 * Проверка вендора: карточка с четырьмя отметками, пока их меньше четырёх; все четыре — одна строка
 * (отметки открывает «Изменить»: снять отметку тоже бывает нужно)
 */
function Checklist({ vendor, onChange }: { vendor: VendorDetail; onChange: (v: VendorDetail) => void }) {
  const { api } = useSession();
  const can = useCan();
  const toast = useToast();
  const listId = useId();
  const [busy, setBusy] = useState<ChecklistItem | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [open, setOpen] = useState(false);
  const done = CHECKLIST.filter((item) => vendor.checklist[item].done).length;
  const complete = done === CHECKLIST.length;
  const write = can("vendors.write");

  const toggle = async (item: ChecklistItem, value: boolean) => {
    setBusy(item);
    const result = await api.post<VendorDetail>(`/staff/vendors/${vendor.id}/checklist`, {
      item,
      done: value,
    });
    setBusy(null);
    setFailure(result.ok ? null : result);
    if (!result.ok) return;
    onChange(result.data);
    toast(t.toastChecklist(t.checklistItems[item], value), { tone: "success" });
  };

  return (
    <section className="panel" aria-labelledby="checklist-title">
      <div className="panel-head">
        <h2 id="checklist-title" tabIndex={-1}>
          {t.checklist} <span className="count">{done}/4</span>
        </h2>
        {complete && write ? (
          <button
            type="button"
            className="btn btn-sm"
            aria-expanded={open}
            aria-controls={listId}
            onClick={() => setOpen(!open)}
          >
            {open ? t.close : t.vuEdit}
          </button>
        ) : null}
      </div>
      {!complete || open ? (
        <ul className="check" id={listId}>
          {CHECKLIST.map((item) => {
            const mark = vendor.checklist[item];
            return (
              <li key={item}>
                <Checkbox
                  checked={mark.done}
                  disabled={!write}
                  // Пока отметка уходит — aria-busy, а не disabled: фокус остаётся на галочке
                  busy={busy !== null}
                  onChange={(value) => void toggle(item, value)}
                >
                  {t.checklistItems[item]}
                </Checkbox>
                {mark.done && mark.at && (
                  <span className="sub">{t.checkedBy(mark.by, formatMoment(mark.at))}</span>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
      {failure && <ErrorText failure={failure} />}
    </section>
  );
}

// ── контакт и реквизиты ────────────────────────────────────────────────────

type PhonesReveal =
  | { state: "hidden" }
  | { state: "loading" }
  | { state: "shown"; phones: VendorPhones }
  | { state: "error"; code: string };

/** Реквизиты одной строкой: форма · юрназвание · СТИР · договор; ничего нет — «Не заполнены» */
function requisitesLine(vendor: VendorDetail): string {
  const parts = [
    vendor.legalForm ? t.legalForms[vendor.legalForm] : null,
    vendor.contacts.legalName,
    vendor.contacts.stir ? t.requisitesStir(vendor.contacts.stir) : null,
    vendor.contractNo ? t.requisitesContract(vendor.contractNo) : null,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : t.requisitesEmpty;
}

/**
 * Контакт вендора и его реквизиты в одной карточке. Контакт — кто и как с ним связаться; оба
 * телефона скрыты, одна кнопка «Показать телефоны» открывает их одним чтением (в журнал доступа к
 * ПДн — одна запись). Реквизиты — строкой и свёрнуты: «Изменить» раскрывает форму на месте, сохранили
 * — снова строка. Только что заведённый вендор — реквизиты раскрыты и на них фокус
 */
function Contact({
  vendor,
  dictionaries,
  onSubmit,
  canWrite,
  startEditing,
}: {
  vendor: VendorDetail;
  dictionaries: StaffDictionaries | null;
  onSubmit: (body: VendorInput) => Promise<Failure | null>;
  canWrite: boolean;
  startEditing: boolean;
}) {
  const { api } = useSession();
  const [editing, setEditing] = useState(startEditing && canWrite);
  const [reveal, setReveal] = useState<PhonesReveal>({ state: "hidden" });
  const formId = useId();
  // Раскрыли реквизиты: первый вход после создания — к ним, без клика
  // biome-ignore lint/correctness/useExhaustiveDependencies: только при открытии страницы
  useEffect(() => {
    if (startEditing && canWrite) focusSection("requisites-title");
  }, []);

  const showPhones = async () => {
    setReveal({ state: "loading" });
    const result = await api.post<VendorPhones>(`/staff/vendors/${vendor.id}/phones`, {});
    setReveal(result.ok ? { state: "shown", phones: result.data } : { state: "error", code: result.code });
  };
  const shown = reveal.state === "shown" ? reveal.phones : null;
  const person = [vendor.contacts.contactPerson, vendor.contacts.contactRole].filter(Boolean).join(" · ");
  const telegram = vendor.contacts.telegramUsername;
  const phoneRow = (label: string, value: string | null | undefined) => (
    <div className="phone-row">
      <span className="phone-label">{label}</span>
      {shown ? (
        value ? (
          <a className="phone-value" href={`tel:${value}`}>
            {formatUzPhone(value)}
          </a>
        ) : (
          <span className="muted">{t.notSet}</span>
        )
      ) : (
        <span className="phone-mask">
          <span aria-hidden="true">{t.input.phoneMasked}</span>
          <span className="visually-hidden">{t.hidden}</span>
        </span>
      )}
    </div>
  );

  return (
    <section className="panel" aria-labelledby="contact-title">
      <h2 id="contact-title">{t.contactTitle}</h2>
      <div className="contacts-reveal">
        <div className="phone-row">
          <span className="phone-label">{t.fields.contactPerson}</span>
          {person ? <span>{person}</span> : <span className="muted">{t.contactNone}</span>}
        </div>
        {telegram ? (
          <div className="phone-row">
            <span className="phone-label">{t.fields.telegramUsername}</span>
            <a
              className="phone-value"
              href={`https://t.me/${telegram}`}
              target="_blank"
              rel="noreferrer noopener"
            >
              @{telegram}
            </a>
          </div>
        ) : null}
        {phoneRow(t.phoneMain, shown?.phone)}
        {phoneRow(t.phoneAlternative, shown?.phoneAlt)}
        {shown === null ? (
          <div>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void showPhones()}
              disabled={reveal.state === "loading"}
            >
              {t.phonesShow}
            </button>
          </div>
        ) : null}
        {reveal.state === "error" && (
          <span className="field-error" role="alert">
            {apiErrorText(reveal.code)}
          </span>
        )}
      </div>

      <div className="panel-head requisites-head">
        <h3 id="requisites-title" tabIndex={-1}>
          {t.requisites}
        </h3>
        {canWrite ? (
          <button
            type="button"
            className="btn btn-sm"
            aria-expanded={editing}
            aria-controls={formId}
            onClick={() => setEditing(!editing)}
          >
            {editing ? t.close : t.vuEdit}
          </button>
        ) : null}
      </div>
      {editing ? (
        <div id={formId}>
          <VendorForm
            key={vendor.id}
            vendor={vendor}
            dictionaries={dictionaries}
            onSubmit={async (body) => {
              const failure = await onSubmit(body);
              if (failure === null) setEditing(false);
              return failure;
            }}
            submitLabel={t.save}
          />
        </div>
      ) : (
        <p className="rcard-meta">{requisitesLine(vendor)}</p>
      )}
    </section>
  );
}

// ── витрины ────────────────────────────────────────────────────────────────

function Listings({ vendor }: { vendor: VendorDetail }) {
  const can = useCan();
  return (
    <section className="panel" aria-labelledby="listings-title">
      <div className="panel-head">
        <h2 id="listings-title" tabIndex={-1}>
          {t.listings} <span className="count">{vendor.listings.length}</span>
        </h2>
        {can("listings.write") && (
          <Link to={{ name: "listingNew", vendorId: vendor.id }} className="btn btn-sm">
            {t.addVitrina}
          </Link>
        )}
      </div>
      {vendor.listings.length === 0 ? (
        <p className="muted">{t.listingsEmpty}</p>
      ) : (
        <ul className="cards">
          {vendor.listings.map((listing) => {
            // Что именно не хватает — на странице витрины; пункты проверки вендора — в «Проверке»
            const missing =
              listing.status === "active"
                ? 0
                : listing.blockers.filter((code) => !VENDOR_CHECKS.has(code)).length;
            return (
              <li key={listing.id} className="card-row rcard-tap">
                <div className="rcard-head">
                  <Link to={{ name: "listing", id: listing.id }} className="rcard-link">
                    {listing.name}
                  </Link>
                  <StatusPill status={listing.status} />
                </div>
                <span className="sub">
                  <CategoryChip code={listing.categoryCode} />{" "}
                  {formatPrice(listing.priceFromUzs, listing.priceUnit)}
                  {listing.capMax ? ` · ${t.guestsUpTo(listing.capMax)}` : ""}
                  {missing > 0 ? (
                    <>
                      {" · "}
                      <strong className="rcard-missing">{t.missingN(missing)}</strong>
                    </>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
