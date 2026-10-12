import { PENDING_PHOTOS_CAP } from "@bayramm/shared/api/staff";
import { describe, expect, it } from "vitest";
import { groupPendingPhotos, type PendingPhotoRow } from "./pending-photos";

const row = (
  listing: string,
  n: number,
  size: [number | null, number | null] = [1600, 1200],
): PendingPhotoRow => ({
  id: `p-${listing}-${n}`,
  listing_id: listing,
  storage_key: `listings/${listing}/${n}.webp`,
  width: size[0],
  height: size[1],
});

describe("groupPendingPhotos", () => {
  it("фото — по карточкам, в порядке строк", () => {
    const map = groupPendingPhotos([row("a", 1), row("b", 1), row("a", 2)]);
    expect([...map.keys()]).toEqual(["a", "b"]);
    expect(map.get("a")?.map((p) => p.id)).toEqual(["p-a-1", "p-a-2"]);
    expect(map.get("b")).toEqual([{ id: "p-b-1", key: "listings/b/1.webp", width: 1600, height: 1200 }]);
  });

  it("больше предела на карточку не отдаём: остальное — на странице витрины", () => {
    const rows = Array.from({ length: PENDING_PHOTOS_CAP + 5 }, (_, i) => row("a", i));
    expect(groupPendingPhotos(rows).get("a")).toHaveLength(PENDING_PHOTOS_CAP);
    expect(
      groupPendingPhotos(rows, 3)
        .get("a")
        ?.map((p) => p.id),
    ).toEqual(["p-a-0", "p-a-1", "p-a-2"]);
  });

  it("размеров нет — нули, а не null: карточке для разметки нужны числа", () => {
    expect(groupPendingPhotos([row("a", 1, [null, null])]).get("a")).toEqual([
      { id: "p-a-1", key: "listings/a/1.webp", width: 0, height: 0 },
    ]);
  });

  it("пустых строк нет — пустая карта", () => {
    expect(groupPendingPhotos([]).size).toBe(0);
  });
});
