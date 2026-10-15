import type { CatalogSuggest } from "@bayramm/shared/api";
import { searchQuery } from "@bayramm/shared/search";
import { SearchSuggest, type SuggestGroup, type SuggestOption } from "@bayramm/ui/react";
import { type Ref, useEffect, useMemo, useRef, useState } from "react";
import { isAbort } from "../api/errors";
import { categoryIcon, categoryName } from "../categories";
import { useDictionaries, useLang, useServices } from "../context";
import { Icon } from "../icons";
import { hrefFor, useNav } from "../router";
import { Photo } from "./Photo";

/* Поиск по каталогу: поле с подсказками (SearchSuggest из @bayramm/ui/react). Пока человек
   печатает — с двух символов и через 250 мс тишины — подсказки GET /catalog/suggest: разделы,
   районы в разделе («Чиланзар — тойханы»), до пяти исполнителей; прежний запрос отменяется.
   Подсказка ведёт сразу туда (раздел, район в разделе, страница исполнителя), Enter — в каталог
   с ?q= (onSubmit решает, с какими фильтрами). Текст запроса нигде не сохраняется: он только в
   адресе каталога и в запросе к API. */

/** Пауза после последней буквы, мс */
export const SUGGEST_DEBOUNCE_MS = 250;

/** id поля каталога: на него ставит фокус значок поиска в шапке телефона */
export const CATALOG_SEARCH_ID = "catalog-search";

// Значок поиска в шапке открыл каталог: поле само возьмёт фокус, когда появится
let focusRequested = false;
export const requestSearchFocus = () => {
  focusRequested = true;
};
const takeSearchFocus = () => {
  const requested = focusRequested;
  focusRequested = false;
  return requested;
};

/** Первая буква — строчная, если это не сокращение («ЗАГС», «FHDYo» — как есть) */
export function lowerFirst(text: string): string {
  const [first = "", second = ""] = [...text];
  if (second !== "" && second === second.toUpperCase() && second !== second.toLowerCase()) return text;
  return first.toLowerCase() + text.slice(first.length);
}

type Suggest =
  | { readonly status: "idle" }
  | { readonly status: "loading"; readonly text: string }
  | { readonly status: "ready"; readonly text: string; readonly data: CatalogSuggest };

/** Подсказки по тексту: с паузой, прежний запрос отменяется; ошибка — просто без подсказок */
function useSuggest(text: string): Suggest {
  const { api } = useServices();
  const [state, setState] = useState<Suggest>({ status: "idle" });
  useEffect(() => {
    if (searchQuery(text) === null) {
      setState({ status: "idle" });
      return;
    }
    const controller = new AbortController();
    setState((prev) => (prev.status === "ready" ? prev : { status: "loading", text }));
    const timer = setTimeout(() => {
      api.suggest(text, controller.signal).then(
        (data) => setState({ status: "ready", text, data }),
        (error: unknown) => {
          if (!isAbort(error)) setState({ status: "idle" });
        },
      );
    }, SUGGEST_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [api, text]);
  return state;
}

export interface CatalogSearchProps {
  /** Текст в поле снаружи (запрос из адреса): сменился — поле показывает его */
  readonly value: string;
  /** Enter: искать текст (пустой — снять поиск) */
  readonly onSubmit: (text: string) => void;
  /** Поле очистили крестиком или Esc */
  readonly onClear?: () => void;
  /** Дата выдачи — с ней же ведут подсказки разделов и районов */
  readonly date?: string | null;
  readonly id?: string;
  readonly className?: string;
  readonly inputRef?: Ref<HTMLInputElement>;
  /** Поле каталога: берёт фокус, если его попросил значок поиска в шапке */
  readonly takeFocus?: boolean;
}

export function CatalogSearch({
  value,
  onSubmit,
  onClear,
  date = null,
  id = CATALOG_SEARCH_ID,
  className,
  inputRef,
  takeFocus = false,
}: CatalogSearchProps) {
  const { t, lang } = useLang();
  const { districtName } = useDictionaries();
  const { navigate } = useNav();
  const [text, setText] = useState(value);
  const input = useRef<HTMLInputElement | null>(null);
  const suggest = useSuggest(text);

  // Запрос сменился снаружи («назад», сброс поиска) — поле показывает его
  useEffect(() => setText(value), [value]);

  // Открыли значком поиска в шапке — фокус в поле (без прокрутки: ловушка №3)
  useEffect(() => {
    if (takeFocus && takeSearchFocus()) input.current?.focus({ preventScroll: true });
  }, [takeFocus]);

  const setInput = (node: HTMLInputElement | null) => {
    input.current = node;
    if (typeof inputRef === "function") inputRef(node);
    else if (inputRef) inputRef.current = node;
  };

  const groups = useMemo((): readonly SuggestGroup[] => {
    if (suggest.status !== "ready") return [];
    const { categories, districts, listings } = suggest.data;
    const section = (code: string) => categoryName(code, t, lang) ?? code;
    return [
      {
        id: "sections",
        label: t.srSections,
        options: categories.map((c) => ({
          id: `c:${c.code}`,
          label: section(c.code),
          media: <Icon name={categoryIcon(c.code)} size={20} />,
        })),
      },
      {
        id: "districts",
        label: t.srAreas,
        options: districts.map((d) => ({
          id: `d:${d.code}:${d.category}`,
          label: t.srDistrictIn(d.name[lang], lowerFirst(section(d.category))),
          media: <Icon name="pin" size={20} />,
        })),
      },
      {
        id: "listings",
        label: t.srListings,
        options: listings.map((l) => ({
          id: `l:${l.slug}`,
          label: l.name,
          hint: [section(l.categoryCode), districtName(l.districtCode)].filter(Boolean).join(" · "),
          media: <Photo photo={l.cover} alt="" sizes="44px" />,
        })),
      },
    ];
  }, [suggest, t, lang, districtName]);

  const count = groups.reduce((n, g) => n + g.options.length, 0);
  const status =
    suggest.status === "idle"
      ? ""
      : suggest.status === "loading"
        ? t.srLoading
        : count > 0
          ? t.srFound(count)
          : t.srNoHints;

  const pick = (option: SuggestOption) => {
    const [kind = "", code = "", category = ""] = option.id.split(":");
    setText("");
    if (kind === "c") navigate(hrefFor({ name: "catalog" }, { category: code, date }));
    else if (kind === "d") navigate(hrefFor({ name: "catalog" }, { category, district: code, date }));
    else if (kind === "l") navigate(hrefFor({ name: "venue", slug: code }));
  };

  return (
    <SearchSuggest
      id={id}
      className={className}
      inputRef={setInput}
      label={t.srLabel}
      placeholder={t.srPh}
      maxLength={100}
      value={text}
      onChange={(next) => {
        setText(next);
        if (next === "" && value !== "") onClear?.();
      }}
      groups={groups}
      status={status}
      onPick={pick}
      onSubmit={(next) => onSubmit(next.trim())}
    />
  );
}
