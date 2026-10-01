/* Раздел «Заявки». На телефоне и планшете — по одному экрану: список, из него — карточка
   заявки. На компьютере — рядом: список слева, карточка справа; адрес тот же
   (/requests/:id), поэтому ссылка, «назад» браузера и обновление страницы ведут себя
   одинаково в обеих раскладках.

   Заявку сами не открываем: открытие делает новую заявку просмотренной (это видит
   клиент), поэтому без выбора справа — подсказка «Выберите заявку». Открыли по ссылке
   (из бота, закладки) заявку с другой вкладки — список переходит на её вкладку, чтобы она
   была видна. Выбранная в списке новая заявка становится просмотренной и уходит во «В
   работе» — вкладку не переключаем: человек разбирает новые подряд. */

import { type RequestTab, TAB_STATUSES, type VendorRequestDetail } from "@bayramm/shared/api/vendor";
import { useCallback, useRef, useState } from "react";
import { RequestDetail } from "./RequestDetail";
import { Requests } from "./Requests";
import type { Navigate } from "./router";
import { Empty, type ScreenProps } from "./ui";

/** Вкладка списка, на которой заявка с этим статусом */
export function tabOf(status: VendorRequestDetail["status"]): RequestTab {
  const tabs = Object.keys(TAB_STATUSES) as RequestTab[];
  return tabs.find((tab) => (TAB_STATUSES[tab] as readonly string[]).includes(status)) ?? "closed";
}

interface InboxProps extends ScreenProps {
  /** Открытая заявка (/requests/:id) */
  readonly id: string | null;
  /** Список и карточка рядом (компьютер) */
  readonly split: boolean;
  readonly tab: RequestTab;
  readonly onTab: (tab: RequestTab) => void;
  readonly navigate: Navigate;
  readonly listingCount: number;
  readonly onCounts: (counts: Readonly<Record<RequestTab, number>>) => void;
}

export function Inbox({
  id,
  split,
  tab,
  onTab,
  navigate,
  listingCount,
  onCounts,
  headingRef,
  ...screen
}: InboxProps) {
  // Растёт, когда карточка рядом изменила заявку: список перечитывается
  const [version, setVersion] = useState(0);
  const changed = useCallback(() => setVersion((n) => n + 1), []);
  // Заявка, открытая по ссылке (с ней раздел и открылся), — не выбранная в списке
  const linked = useRef(id);
  const loaded = useCallback(
    (status: VendorRequestDetail["status"]) => {
      if (linked.current === null || linked.current !== id) return;
      linked.current = null;
      const own = tabOf(status);
      if (own !== tab) onTab(own);
    },
    [id, tab, onTab],
  );

  const list = (
    <Requests
      {...screen}
      headingRef={split && id ? undefined : headingRef}
      tab={tab}
      onTab={onTab}
      navigate={navigate}
      listingCount={listingCount}
      selectedId={split ? (id ?? undefined) : undefined}
      version={version}
      onCounts={onCounts}
    />
  );

  if (!split) {
    return id ? (
      <RequestDetail key={id} id={id} navigate={navigate} headingRef={headingRef} {...screen} />
    ) : (
      list
    );
  }

  return (
    <div className="inbox">
      {list}
      <div className="inbox-detail">
        {id ? (
          <RequestDetail
            key={id}
            id={id}
            navigate={navigate}
            headingRef={headingRef}
            split
            onChanged={changed}
            onLoaded={loaded}
            {...screen}
          />
        ) : (
          <Empty icon="requests" title={screen.t.pickRequest} text={screen.t.pickRequestText} />
        )}
      </div>
    </div>
  );
}
