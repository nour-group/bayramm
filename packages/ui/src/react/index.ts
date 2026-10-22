/* Свои контролы Bayramm вместо системных: выпадающий список (и список с поиском), галочка, переключатель,
   группа вариантов, число, дата, время, файлы, поиск (и поиск с подсказками), диалог, уведомления, подсказка;
   связь (есть ли сеть и баннер «нет связи»); прилипшие панели (высота — в scroll-padding); «назад»
   закрывает открытый слой (back.ts); тихое перечитывание списков и «сейчас» для сроков (revalidate.ts);
   граница экрана (кусок не загрузился — «Повторить» вместо пустой страницы).
   Стили — @bayramm/ui/kit.css (только токены), тексты — из словаря приложения. */

export {
  type BackButtonLike,
  backLayerOpen,
  historyBack,
  markScreenBack,
  pushScreen,
  setBackButton,
  setBackHistory,
  useBackLayer,
} from "./back";
export { Calendar, type CalendarProps, type CalendarTexts } from "./Calendar";
export { Combobox, type ComboboxProps } from "./Combobox";
export { Checkbox, RadioGroup, type RadioGroupProps, type RadioOption, Switch } from "./choices";
export { DateField, type DateFieldProps } from "./DateField";
export { ConfirmSheet, type ConfirmSheetProps, Dialog, type DialogProps } from "./Dialog";
export { accepts, FileDrop, type FileDropProps } from "./FileDrop";
export { UiIcon, type UiIconName } from "./icons";
export { NumberStepper, type NumberStepperProps } from "./NumberStepper";
export {
  type Connectivity,
  ConnectivityProvider,
  OfflineBanner,
  type OfflineBannerProps,
  useConnectivity,
  useOnReconnect,
} from "./online";
export { SHEET_BELOW } from "./overlay";
export { type RevalidateOptions, useNow, useRevalidate } from "./revalidate";
export {
  chunkUrlOf,
  isChunkLoadError,
  retryableLazy,
  ScreenErrorBoundary,
  type ScreenErrorBoundaryProps,
  type ScreenErrorTexts,
} from "./ScreenErrorBoundary";
export { SearchField, type SearchFieldProps } from "./SearchField";
export {
  fitSuggest,
  SearchSuggest,
  type SearchSuggestProps,
  type SuggestGroup,
  type SuggestOption,
} from "./SearchSuggest";
export { Select, type SelectOption, type SelectProps } from "./Select";
export { type StickyEdge, stickyBar, useStickyBar } from "./sticky";
export { TimeField, type TimeFieldProps, timeOptions } from "./TimeField";
export {
  type ToastAction,
  type ToastOptions,
  ToastProvider,
  type ToastProviderProps,
  type ToastTone,
  useOptionalToast,
  useToast,
} from "./Toast";
export { Tooltip, type TooltipProps, type TooltipTriggerProps } from "./Tooltip";
export { type UiTexts, UiTextsProvider, useUiTexts } from "./texts";
