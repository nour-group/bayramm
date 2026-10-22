/* Поиск во входящих (что ищут, дата праздника, порядок) — в памяти страницы: переживает переход
   в заявку и обратно, но не перезагрузку, смену кабинета и выход. Нигде не хранится: ни в
   адресе, ни в истории, ни во вкладке — там имя и цифры номера клиента. Отдельный крошечный
   модуль: оболочка стирает поиск, не подтягивая к себе входящие. */

export interface InboxFind {
  readonly q: string;
  readonly date: string | null;
  readonly sort: "default" | "event";
}

const EMPTY: InboxFind = { q: "", date: null, sort: "default" };

let remembered: InboxFind = EMPTY;

export function rememberedFind(): InboxFind {
  return remembered;
}

export function rememberFind(next: InboxFind): void {
  remembered = next;
}

/** Смена кабинета и выход: поиск прежнего не переносится */
export function forgetFind(): void {
  remembered = EMPTY;
}
