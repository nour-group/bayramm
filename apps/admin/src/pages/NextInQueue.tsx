/* После решения по объекту очереди модерации (предложение изменений, витрина на проверке, а на
   странице витрины — смена контактов, услуга, фото) — сразу к следующему: модератор на телефоне
   разбирает очередь подряд, не возвращаясь в «Модерацию» после каждого решения. Следующий —
   первый ждущий, кроме только что решённого (у контактов, услуг и фото — кроме этой витрины);
   рядом — «К очереди (n)», сколько в ней ещё ждёт. Следующего нет — «очередь пуста» и путь в
   «Модерацию». Кнопка получает фокус: решённое уже не ждёт действий, и фокус не теряется в
   странице (у услуг и фото фокус уже поставил блок — focus={false}). */

import type { ContactChangeList, ListingList, RevisionList, ServiceQueue } from "@bayramm/shared/api/staff";
import { useEffect, useRef } from "react";
import { useLoad } from "../api";
import type { View } from "../router";
import { t } from "../texts";
import { Link } from "../ui";

/** Очередь «Модерации» — те же ключи, что у ?queue= */
export type ModerationQueue = "revisions" | "review" | "contacts" | "services" | "photos";

interface NextInQueueProps {
  readonly queue: ModerationQueue;
  /**
   * Только что решённое — не оно «следующее»: предложение или витрина на проверке; у контактов,
   * услуг и фото — витрина, на странице которой решали
   */
  readonly currentId: string;
  /** Поставить фокус на ссылку, когда очередь прочиталась; false — фокус уже поставил блок */
  readonly focus?: boolean;
}

// Следующий у очередей по витрине может оказаться той же витриной: берём с запасом
const PATH: Readonly<Record<ModerationQueue, string>> = {
  revisions: "/staff/revisions?status=pending&limit=2",
  review: "/staff/listings?status=review&limit=2",
  contacts: "/staff/contact-changes?limit=10",
  services: "/staff/services?limit=20",
  photos: "/staff/listings?photos=pending&limit=10",
};

type QueueList = RevisionList | ListingList | ContactChangeList | ServiceQueue;

interface Next {
  readonly to: View;
  readonly label: string;
}

/** Первый ждущий, кроме решённого, и сколько в очереди ждёт без него */
function nextOf(
  queue: ModerationQueue,
  data: QueueList,
  currentId: string,
): { next: Next | null; left: number } {
  switch (queue) {
    case "revisions": {
      const items = (data as RevisionList).items.filter((item) => item.id !== currentId);
      const item = items[0];
      return {
        next: item
          ? { to: { name: "revision", id: item.id }, label: t.nextRevision(item.listing.name) }
          : null,
        left: Math.max(0, data.total - ((data as RevisionList).items.length - items.length)),
      };
    }
    case "review": {
      const items = (data as ListingList).items.filter((item) => item.id !== currentId);
      const item = items[0];
      return {
        next: item ? { to: { name: "listing", id: item.id }, label: t.nextReview(item.name) } : null,
        left: Math.max(0, data.total - ((data as ListingList).items.length - items.length)),
      };
    }
    case "contacts": {
      const all = (data as ContactChangeList).items;
      const items = all.filter((item) => item.listing.id !== currentId);
      const item = items[0];
      return {
        next: item
          ? {
              to: { name: "listing", id: item.listing.id, query: { focus: "contacts" } },
              label: t.nextContacts(item.listing.name),
            }
          : null,
        left: Math.max(0, data.total - (all.length - items.length)),
      };
    }
    case "services": {
      const all = (data as ServiceQueue).items;
      const items = all.filter((item) => item.listing.id !== currentId);
      const item = items[0];
      return {
        next: item
          ? {
              to: { name: "listing", id: item.listing.id, query: { focus: "services" } },
              label: t.nextServices(item.listing.name),
            }
          : null,
        left: Math.max(0, data.total - (all.length - items.length)),
      };
    }
    case "photos": {
      const list = data as ListingList;
      const items = list.items.filter((item) => item.id !== currentId);
      const item = items[0];
      // Число очереди фото — сами фото, а не витрины
      const here = list.items.find((entry) => entry.id === currentId)?.photos.pending ?? 0;
      return {
        next: item
          ? {
              to: { name: "listing", id: item.id, query: { focus: "photos" } },
              label: t.nextPhotos(item.name),
            }
          : null,
        left: Math.max(0, (list.pendingPhotosTotal ?? data.total) - here),
      };
    }
  }
}

export function NextInQueue({ queue, currentId, focus = true }: NextInQueueProps) {
  const { loaded } = useLoad<QueueList>(PATH[queue]);
  const box = useRef<HTMLDivElement>(null);
  const settled = loaded.state !== "loading";
  useEffect(() => {
    if (settled && focus) box.current?.querySelector<HTMLElement>("a")?.focus();
  }, [settled, focus]);
  if (loaded.state === "loading") return null;
  const toQueue: View = { name: "moderation", query: { queue } };
  // Очередь не прочиталась — путь в «Модерацию» всё равно есть
  if (loaded.state === "error") {
    return (
      <div className="next-in-queue" ref={box}>
        <Link to={toQueue} className="btn">
          {t.toModeration}
        </Link>
      </div>
    );
  }

  const { next, left } = nextOf(queue, loaded.data, currentId);
  return (
    <div className="next-in-queue" ref={box}>
      {next ? (
        <>
          <Link to={next.to} className="btn btn-primary">
            {next.label}
          </Link>
          <Link to={toQueue} className="btn">
            {t.toQueue(left)}
          </Link>
        </>
      ) : (
        <>
          <p className="muted">{t.queueDone}</p>
          <Link to={toQueue} className="btn">
            {t.toModeration}
          </Link>
        </>
      )}
    </div>
  );
}
