import { useLang } from "../context";
import { useFavorites } from "../favorites";
import { Icon } from "../icons";

/**
 * Сердечко «Сохранить» — на карточке в выдаче и на странице площадки, как в прототипе.
 * Кнопка-переключатель: aria-pressed и подпись с названием площадки. Рисунок меньше 44px —
 * зона нажатия расширена невидимым слоем в стилях (.fav-btn::after)
 */
export function FavoriteButton({
  listing,
  className = "fav-btn",
}: {
  listing: { readonly id: string; readonly name: string };
  className?: string;
}) {
  const { t } = useLang();
  const { ids, toggle } = useFavorites();
  const on = ids.has(listing.id);
  return (
    <button
      type="button"
      className={className}
      aria-pressed={on}
      aria-label={t.favToggle(listing.name)}
      onClick={() => toggle(listing)}
    >
      <Icon name={on ? "heartFill" : "heart"} size={20} />
    </button>
  );
}
