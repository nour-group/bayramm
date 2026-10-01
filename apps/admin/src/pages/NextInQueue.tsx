/* После решения по объекту очереди модерации (предложение изменений, витрина на проверке) —
   сразу к следующему: модератор на телефоне разбирает очередь подряд, не возвращаясь в
   «Модерацию» после каждого решения. Следующий — первый ждущий, кроме только что решённого;
   его нет — «очередь пуста» и путь в «Модерацию». Кнопка получает фокус: решённое уже не
   ждёт действий, и фокус не теряется в странице. */

import type { ListingList, RevisionList } from "@bayramm/shared/api/staff";
import { useEffect, useRef } from "react";
import { useLoad } from "../api";
import { t } from "../texts";
import { Link } from "../ui";

interface NextInQueueProps {
  /** Какая очередь: предложения изменений или витрины на проверке */
  readonly queue: "revisions" | "review";
  /** Только что решённый объект — не он «следующий» */
  readonly currentId: string;
}

const PATH = {
  revisions: "/staff/revisions?status=pending&limit=2",
  review: "/staff/listings?status=review&limit=2",
} as const;

export function NextInQueue({ queue, currentId }: NextInQueueProps) {
  const { loaded } = useLoad<RevisionList | ListingList>(PATH[queue]);
  const box = useRef<HTMLDivElement>(null);
  const settled = loaded.state !== "loading";
  useEffect(() => {
    if (settled) box.current?.querySelector<HTMLElement>("a")?.focus();
  }, [settled]);
  if (loaded.state === "loading") return null;
  // Очередь не прочиталась — путь в «Модерацию» всё равно есть
  if (loaded.state === "error") {
    return (
      <div className="next-in-queue" ref={box}>
        <Link to={{ name: "moderation" }} className="btn">
          {t.toModeration}
        </Link>
      </div>
    );
  }

  const next =
    queue === "revisions"
      ? (loaded.data as RevisionList).items
          .filter((item) => item.id !== currentId)
          .map((item) => ({ id: item.id, name: item.listing.name }))[0]
      : (loaded.data as ListingList).items
          .filter((item) => item.id !== currentId)
          .map((item) => ({ id: item.id, name: item.name }))[0];

  return (
    <div className="next-in-queue" ref={box}>
      {next ? (
        <Link
          to={queue === "revisions" ? { name: "revision", id: next.id } : { name: "listing", id: next.id }}
          className="btn btn-primary"
        >
          {queue === "revisions" ? t.nextRevision(next.name) : t.nextReview(next.name)}
        </Link>
      ) : (
        <>
          <p className="muted">{t.queueDone}</p>
          <Link to={{ name: "moderation" }} className="btn">
            {t.toModeration}
          </Link>
        </>
      )}
    </div>
  );
}
