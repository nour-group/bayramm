import type { AnchorHTMLAttributes, MouseEvent } from "react";
import { useNav } from "../router";

type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; replace?: boolean };

/** Ссылка внутри приложения: переход без перезагрузки, но настоящий href для новой вкладки */
export function Link({ href, replace, onClick, ...rest }: LinkProps) {
  const { navigate } = useNav();
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    // Новая вкладка, окно, скачивание — пусть решает браузер
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(href, { replace });
  };
  return <a href={href} onClick={handleClick} {...rest} />;
}
