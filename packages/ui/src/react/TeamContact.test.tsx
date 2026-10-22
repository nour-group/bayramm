// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { TeamContact } from "./TeamContact";
import { cleanup, click, render } from "./test/harness";

afterEach(cleanup);

const labels = { telegramLabel: "Написать в Telegram", phoneLabel: (phone: string) => `Позвонить: ${phone}` };

describe("TeamContact", () => {
  it("не указано ничего — ничего и не рисует", () => {
    render(<TeamContact team={{ telegram: null, phone: null }} {...labels} />);
    expect(document.querySelector(".ui-team")).toBeNull();
    render(<TeamContact team={null} {...labels} />);
    expect(document.querySelector(".ui-team")).toBeNull();
  });

  it("Telegram — ссылкой наружу, телефон — tel:; подписи — от приложения", () => {
    render(<TeamContact team={{ telegram: "bayramm_team", phone: "+998901112233" }} {...labels} />);
    const links = [...document.querySelectorAll<HTMLAnchorElement>(".ui-team a")];
    expect(links.map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["Написать в Telegram", "https://t.me/bayramm_team"],
      ["Позвонить: +998901112233", "tel:+998901112233"],
    ]);
    expect(links[0]?.getAttribute("rel")).toContain("noopener");
    expect(links.every((a) => a.classList.contains("ui-btn"))).toBe(true);
  });

  it("ссылками строкой (подвал); Telegram приложение может открыть само", async () => {
    const onTelegram = vi.fn((_href: string, event: { preventDefault(): void }) => event.preventDefault());
    render(
      <TeamContact
        team={{ telegram: "bayramm_team", phone: null }}
        variant="links"
        onTelegram={onTelegram}
        {...labels}
      />,
    );
    expect(document.querySelector(".ui-team")?.classList.contains("ui-team-links")).toBe(true);
    expect(document.querySelector(".ui-team a")?.classList.contains("ui-btn")).toBe(false);
    await click(document.querySelector(".ui-team a"));
    expect(onTelegram).toHaveBeenCalledWith("https://t.me/bayramm_team", expect.anything());
  });
});
