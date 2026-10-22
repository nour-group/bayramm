/* «Назад» закрывает открытый слой (шторку, диалог, список), а не весь экран.

   В Telegram — кнопка «Назад» клиента (её же нажимает системное «назад» Android): пока слой
   открыт, она видна и закрывает верхний слой. Без неё «назад» Android закрыл бы Mini App целиком.
   Кнопку даёт приложение (setBackButton): набор не знает про SDK и версии клиента.
   В обычном браузере — запись истории на каждый открытый слой: «назад» браузера закрывает
   верхний; закрыли слой сами (крестик, Esc, сохранили) — его запись уходит из истории.

   Закрытие идёт тем же путём, что крестик (onClose слоя): форма с правками спросит «Уйти без
   сохранения?», шторка останется открытой — и её запись вернётся в историю.
   Обработчики «назад» экранов приложения проверяют backLayerOpen(): нажатие, которое закрыло
   слой, экран не уводит (Telegram зовёт все обработчики кнопки). */

import { useEffect, useRef } from "react";

/** Кнопка «Назад» клиента Telegram; каждый метод — через проверку наличия */
export interface BackButtonLike {
  readonly isVisible?: boolean;
  show?(): unknown;
  hide?(): unknown;
  onClick?(handler: () => void): unknown;
  offClick?(handler: () => void): unknown;
}

interface Layer {
  readonly back: () => void;
}

const layers: Layer[] = [];
let source: (() => BackButtonLike | null) | null = null;

/** Кнопка «Назад» Telegram для слоёв; null — нет (обычный браузер, старый клиент) */
export function setBackButton(get: (() => BackButtonLike | null) | null): void {
  source = get;
}

function telegramButton(): BackButtonLike | null {
  try {
    const button = source?.() ?? null;
    return button && typeof button.show === "function" && typeof button.onClick === "function"
      ? button
      : null;
  } catch {
    return null;
  }
}

// Нажатие, закрывшее слой, ещё обходит обработчики экранов: до конца задачи слой «открыт»
let consuming = false;

/** Открыт слой — «назад» закрывает его; обработчик «назад» экрана в это время ничего не делает */
export function backLayerOpen(): boolean {
  return layers.length > 0 || consuming;
}

function backTop(): void {
  const top = layers[layers.length - 1];
  if (!top) return;
  consuming = true;
  setTimeout(() => {
    consuming = false;
  }, 0);
  top.back();
}

/* ---------- Telegram ---------- */

let shown: BackButtonLike | null = null;
/** Экран сейчас показывает свою «Назад» (вложенный экран): закрыв слой, кнопку не прячем */
let screenWants = false;
const onTelegramBack = () => backTop();

/**
 * Обработчик «назад» экрана приложения показал кнопку Telegram (on) или убрал её (off). Не снимок
 * при открытии слоя: из шторки могли перейти на вложенный экран, и кнопка нужна уже ему
 */
export function markScreenBack(on: boolean): void {
  screenWants = on;
}

function syncTelegram(button: BackButtonLike): void {
  if (layers.length > 0 && shown === null) {
    shown = button;
    button.onClick?.(onTelegramBack);
    button.show?.();
  } else if (layers.length === 0 && shown !== null) {
    shown.offClick?.(onTelegramBack);
    if (screenWants) shown.show?.();
    else shown.hide?.();
    shown = null;
  }
}

/* ---------- история браузера ---------- */

const MARK = "uiLayer";
/** Сколько записей слоёв сейчас поверх записи экрана */
let entries = 0;
/** Свой шаг назад (убрали запись закрытого слоя): его popstate экрану не показываем */
let ownPop: { readonly href: string } | null = null;
/** Шаг назад экрана мимо записей слоёв (historyBack): его popstate — маршрутизатору */
let screenPop = false;
let historyOn = true;
let timer: ReturnType<typeof setTimeout> | null = null;

const depthOf = (state: unknown): number => {
  const value = state && typeof state === "object" ? (state as Record<string, unknown>)[MARK] : undefined;
  return typeof value === "number" && value > 0 ? value : 0;
};

function onPop(event: PopStateEvent): void {
  if (screenPop) {
    screenPop = false;
    entries = Math.min(entries, depthOf(event.state));
    return;
  }
  if (ownPop) {
    const { href } = ownPop;
    ownPop = null;
    event.stopImmediatePropagation();
    // Пока слой был открыт, адрес меняли (фильтры в шторке — replaceState): перенести на запись экрана
    if (window.location.href !== href) window.history.replaceState(window.history.state, "", href);
    later();
    return;
  }
  const depth = depthOf(event.state);
  if (layers.length === 0 || depth >= entries) {
    // Не запись слоя: переход экрана (в том числе на старую запись слоя)
    entries = Math.min(entries, depth);
    return;
  }
  // «Назад» браузера снял запись верхнего слоя: закрыть его, экран не трогать
  entries = depth;
  event.stopImmediatePropagation();
  backTop();
  // Слой не закрылся (спросили о несохранённом) — запись вернётся
  later();
}

/** Записи истории для слоёв; тесты экранов (jsdom) выключают: шаг назад одного теста пришёл бы в следующий */
export function setBackHistory(enabled: boolean): void {
  historyOn = enabled;
}

// Слушаем с загрузки модуля: обработчики одного объекта зовутся по порядку подписки, и наш должен
// успеть раньше маршрутизатора приложения, чтобы остановить popstate своей записи
if (typeof window !== "undefined" && typeof window.addEventListener === "function")
  window.addEventListener("popstate", onPop, true);

function syncHistory(): void {
  if (!historyOn || typeof window === "undefined" || typeof window.history?.pushState !== "function") return;
  // Свой шаг назад ещё идёт — досчитаем, когда придёт
  if (ownPop) return;
  // Экран сменился, пока слой был открыт (новая запись без отметки): записи слоёв — под ней
  entries = Math.min(entries, depthOf(window.history.state));
  while (entries < layers.length) {
    entries += 1;
    const state = window.history.state;
    window.history.pushState(
      { ...(state && typeof state === "object" ? state : {}), [MARK]: entries },
      "",
      window.location.href,
    );
  }
  if (entries > layers.length) {
    const steps = entries - layers.length;
    entries = layers.length;
    ownPop = { href: window.location.href };
    window.history.go(-steps);
  }
}

function sync(): void {
  const button = telegramButton();
  if (button || shown) syncTelegram(button ?? (shown as BackButtonLike));
  else syncHistory();
}

/**
 * Переход маршрутизатора на новый экран (вместо history.pushState). Слой открыт и его запись
 * сверху (ссылка в шторке, «Уйти» в вопросе о несохранённом) — новый экран встаёт на её место:
 * иначе запись закрытого слоя осталась бы под ним, и «назад» пришлось бы жать дважды
 */
export function pushScreen(state: unknown, url: string): void {
  if (typeof window === "undefined") return;
  if (historyOn && depthOf(window.history.state) > 0 && ownPop === null) {
    window.history.replaceState(state, "", url);
    // Записей слоёв поверх экрана больше нет; слой, что остался открытым, получит новую
    entries = 0;
    later();
    return;
  }
  window.history.pushState(state, "", url);
}

/**
 * «Назад» экрана из кода приложения (ушли без сохранения, «назад» в шапке) — мимо записей открытых
 * слоёв: history.back() снял бы запись шторки, и закрылась бы шторка, а не экран
 */
export function historyBack(): void {
  if (typeof window === "undefined") return;
  const steps = historyOn ? entries + 1 : 1;
  entries = 0;
  ownPop = null;
  screenPop = true;
  window.history.go(-steps);
}

/** Закрытие — следующей задачей: переход, начатый в том же нажатии (ссылка в шторке), успеет записаться */
function later(): void {
  if (timer !== null) return;
  timer = setTimeout(() => {
    timer = null;
    sync();
  }, 0);
}

/**
 * Пока active, слой — верхний для «назад»: кнопка Telegram или запись истории браузера.
 * onBack — закрыть слой тем же путём, что крестик
 */
export function useBackLayer(active: boolean, onBack: () => void): void {
  const handler = useRef(onBack);
  handler.current = onBack;
  useEffect(() => {
    if (!active) return;
    const layer: Layer = { back: () => handler.current() };
    layers.push(layer);
    sync();
    return () => {
      const index = layers.indexOf(layer);
      if (index >= 0) layers.splice(index, 1);
      later();
    };
  }, [active]);
}

/** Для тестов: забыть слои и записи */
export function resetBackLayers(): void {
  layers.length = 0;
  entries = 0;
  ownPop = null;
  screenPop = false;
  screenWants = false;
  consuming = false;
  if (timer !== null) clearTimeout(timer);
  timer = null;
  if (shown) {
    shown.offClick?.(onTelegramBack);
    shown = null;
  }
}
