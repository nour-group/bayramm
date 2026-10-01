/* Несохранённое в кабинете — как в панели оператора (apps/admin/src/unsaved.tsx). Форма
   отмечает себя сама: useUnsaved(dirty) — «есть что терять» (предложение изменений витрины,
   услуга, причина отказа, число заказов одновременно). Пока хоть одна изменена, уход с экрана
   спрашивает «Уйти без сохранения?»:
     · переход внутри кабинета — нижняя панель, боковая, ссылки, смена витрины;
     · «назад» браузера и Telegram — адрес экрана с правками возвращается в историю
       (router.ts, useRoute), уйти — по «Уйти»; «назад» Telegram в форме услуги — тоже вопрос;
     · перезагрузка и закрытие вкладки — beforeunload (браузер спросит своим окном);
     · закрытие Mini App — подтверждение Telegram (enableClosingConfirmation, с 6.2).
   Нечего терять (не меняли, отправили, нажали «Отмена») — уход без вопросов. На телефоне
   палец легко задевает нижнюю панель посреди длинной формы услуги — правки не пропадают молча. */

import { ConfirmSheet } from "@bayramm/ui/react";
import {
  createContext,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { VendorDict } from "./i18n";
import type { LeaveGuard } from "./router";
import { getWebApp, supports } from "./telegram";

export interface UnsavedRegistry {
  /** Форма id изменена (true) или как была (false) */
  mark(id: string, dirty: boolean): void;
  /** Уйти (переход, смена витрины, «назад»): сразу, если терять нечего, иначе — после «Уйти» */
  confirmLeave(leave: () => void): void;
}

export const UnsavedContext = createContext<UnsavedRegistry | null>(null);

/** Отметка формы: dirty — есть несохранённое. Форма ушла с экрана — отметка снята */
export function useUnsaved(dirty: boolean): void {
  const registry = useContext(UnsavedContext);
  const id = useId();
  useEffect(() => {
    registry?.mark(id, dirty);
  }, [registry, id, dirty]);
  useEffect(() => () => registry?.mark(id, false), [registry, id]);
}

/** Спросить перед уходом, если есть несохранённое (без оболочки — уйти сразу) */
export function useConfirmLeave(): (leave: () => void) => void {
  const registry = useContext(UnsavedContext);
  return useCallback((leave: () => void) => (registry ? registry.confirmLeave(leave) : leave()), [registry]);
}

export interface Unsaved {
  /** Для useRoute: держит уход, пока на экране есть несохранённое */
  readonly guard: RefObject<LeaveGuard>;
  /** Реестр для UnsavedContext: формы экранов отмечаются в нём */
  readonly registry: UnsavedRegistry;
  /** Вопрос «Уйти без сохранения?» — в разметку оболочки */
  readonly sheet: ReactNode;
}

/** Реестр изменённых форм кабинета и вопрос перед уходом */
export function useUnsavedGuard(t: VendorDict): Unsaved {
  const dirty = useRef(new Set<string>());
  // Адрес и запись истории экрана с правками — снимок в момент первой правки
  const held = useRef<{ url: string; state: unknown } | null>(null);
  const [any, setAny] = useState(false);
  const [asking, setAsking] = useState<{ leave: () => void } | null>(null);

  const guard = useRef<LeaveGuard>({
    holding: () => (dirty.current.size > 0 ? held.current : null),
    ask: (leave) => setAsking({ leave }),
  });

  const registry = useMemo<UnsavedRegistry>(
    () => ({
      mark(id, isDirty) {
        const set = dirty.current;
        const before = set.size > 0;
        if (isDirty) set.add(id);
        else set.delete(id);
        const after = set.size > 0;
        if (after && !before) {
          const { pathname, search, hash } = window.location;
          held.current = { url: `${pathname}${search}${hash}`, state: window.history.state };
        }
        if (!after) held.current = null;
        if (after !== before) setAny(after);
      },
      confirmLeave(leave) {
        if (guard.current.holding()) guard.current.ask(leave);
        else leave();
      },
    }),
    [],
  );

  // Перезагрузка и закрытие вкладки: браузер спрашивает своим окном (текст — его)
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (dirty.current.size === 0) return;
      event.preventDefault();
      // Старые браузеры спрашивают, только если задан returnValue
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  // Закрыть Mini App с несохранённым — Telegram переспросит (6.2+)
  useEffect(() => {
    const webApp = getWebApp();
    if (!any || !webApp || !supports(webApp, "6.2")) return;
    webApp.enableClosingConfirmation?.();
    return () => webApp.disableClosingConfirmation?.();
  }, [any]);

  const sheet = (
    <ConfirmSheet
      open={asking !== null}
      title={t.unsavedTitle}
      text={t.unsavedText}
      confirmLabel={t.unsavedLeave}
      cancelLabel={t.unsavedStay}
      tone="danger"
      onConfirm={() => {
        const leave = asking?.leave;
        setAsking(null);
        // Правки брошены: уход больше ничего не держит (формы сами снимут отметки, уходя)
        dirty.current.clear();
        held.current = null;
        setAny(false);
        leave?.();
      }}
      onCancel={() => setAsking(null)}
    />
  );

  return { guard, registry, sheet };
}
