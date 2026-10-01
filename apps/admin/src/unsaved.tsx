/* Несохранённые правки. Форма отмечает себя сама: useUnsaved(dirty) — «есть что терять».
   Пока хоть одна форма на экране изменена, уход с экрана спрашивает подтверждение:
     · переход внутри панели — ссылки, нижняя панель, «Ещё», «назад» в шапке, выход —
       ConfirmSheet «Уйти без сохранения?» (оболочка зовёт confirmLeave / guard.ask);
     · «назад» и «вперёд» браузера и кнопка «назад» Telegram — то же: адрес экрана с правками
       возвращается в историю (router.ts, useRoute), уйти — по «Уйти»;
     · перезагрузка и закрытие вкладки — beforeunload (браузер спросит своим окном);
     · закрытие Mini App — подтверждение Telegram (enableClosingConfirmation, с 6.2).
   Нечего терять (ничего не меняли или только что сохранили) — уход без вопросов. */

import type { TelegramWebApp } from "@bayramm/tg/webapp";
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
import type { LeaveGuard } from "./router";
import { supports } from "./telegram";
import { t } from "./texts";

export interface UnsavedRegistry {
  /** Форма id изменена (true) или как сохранена (false) */
  mark(id: string, dirty: boolean): void;
}

export const UnsavedContext = createContext<UnsavedRegistry | null>(null);

/** Отметка формы: dirty — есть несохранённое. Ушла со страницы — отметка снята */
export function useUnsaved(dirty: boolean): void {
  const registry = useContext(UnsavedContext);
  const id = useId();
  useEffect(() => {
    registry?.mark(id, dirty);
  }, [registry, id, dirty]);
  useEffect(() => () => registry?.mark(id, false), [registry, id]);
}

export interface Unsaved {
  /** Для useRoute: держит уход, пока на экране есть несохранённое */
  readonly guard: RefObject<LeaveGuard>;
  /** Уйти (выход, переход): сразу, если терять нечего, иначе — после «Уйти» */
  readonly confirmLeave: (leave: () => void) => void;
  /** Реестр для UnsavedContext: формы экранов отмечаются в нём */
  readonly registry: UnsavedRegistry;
  /** Вопрос «Уйти без сохранения?» — в разметку оболочки */
  readonly sheet: ReactNode;
}

/** Реестр изменённых форм оболочки и вопрос перед уходом */
export function useUnsavedGuard(webApp: TelegramWebApp | null): Unsaved {
  const dirty = useRef(new Set<string>());
  // Адрес и запись истории экрана с правками — снимок в момент первой правки
  const held = useRef<{ url: string; state: unknown } | null>(null);
  const [any, setAny] = useState(false);
  const [asking, setAsking] = useState<{ leave: () => void } | null>(null);

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
    }),
    [],
  );

  const guard = useRef<LeaveGuard>({
    holding: () => (dirty.current.size > 0 ? held.current : null),
    // Вопрос — после текущего нажатия: шторка «Ещё», из которой ушли, успеет закрыться и
    // вернуть фокус на свою кнопку, а подтверждение откроется уже от неё
    ask: (leave) => setTimeout(() => setAsking({ leave }), 0),
  });

  const confirmLeave = useCallback((leave: () => void) => {
    if (guard.current.holding()) guard.current.ask(leave);
    else leave();
  }, []);

  // Перезагрузка и закрытие вкладки: браузер спрашивает своим окном (текст — его). Есть ли что
  // терять — по реестру в момент ухода, а не по отрисовке: стёрли поле и сразу обновили
  // страницу — вопроса нет
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
    if (!any || !supports(webApp, "6.2")) return;
    webApp?.enableClosingConfirmation?.();
    return () => webApp?.disableClosingConfirmation?.();
  }, [any, webApp]);

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

  return { guard, confirmLeave, registry, sheet };
}
