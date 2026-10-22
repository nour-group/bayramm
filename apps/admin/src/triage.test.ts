import { describe, expect, it } from "vitest";
import { deliveryProblem } from "./delivery";
import { opsTrail } from "./pages/Requests";
import { shareParts, telegramShareUrl } from "./share";
import { teamInviteText } from "./team-invite";
import { t } from "./texts";

/* Разбор очередей командой: что уже сделали по заявке, почему не дошло уведомление и что
   делать, текст приглашения в команду и «Отправить в Telegram». */

describe("строка заявки: что команда уже сделала", () => {
  const now = Date.parse("2026-10-22T06:00:00Z");
  it("напомнили и кто последним что-то делал — одной строкой; ничего — пусто", () => {
    expect(opsTrail({ reminders: 2, lastOpsAt: "2026-10-22T04:12:00Z", lastOpsBy: "Дильноза" }, now)).toBe(
      `${t.remindedTimes(2)} · ${t.opsLast("09:12", "Дильноза")}`,
    );
    expect(opsTrail({ reminders: 1, lastOpsAt: null, lastOpsBy: null }, now)).toBe(t.remindedTimes(1));
    // Старый ответ API — полей нет
    expect(opsTrail({ reminders: 0 }, now)).toBe("");
  });
});

describe("недоставленное: словами и что делать", () => {
  it("бот заблокирован, аккаунт удалён, чата нет — позвонить, повтор не поможет", () => {
    expect(deliveryProblem("api 403: Forbidden: bot was blocked by the user")).toEqual({
      text: t.delivery.blocked,
      retry: false,
      call: true,
    });
    expect(deliveryProblem("api 403: Forbidden: user is deactivated").text).toBe(t.delivery.deactivated);
    expect(deliveryProblem("api 400: Bad Request: chat not found")).toMatchObject({
      retry: false,
      call: true,
    });
    expect(deliveryProblem("skipped: vendor_user_unlinked")).toMatchObject({ retry: false, call: true });
  });

  it("Telegram не отвечал или сотрудник ещё не писал боту — повтор может помочь", () => {
    expect(deliveryProblem("attempts_exhausted: network")).toMatchObject({ retry: true, call: false });
    expect(deliveryProblem("attempts_exhausted: api 502: Bad Gateway").retry).toBe(true);
    expect(deliveryProblem("skipped: staff_no_chat").retry).toBe(true);
    expect(deliveryProblem(null).retry).toBe(true);
  });

  it("клиент выключил уведомления, объекта нет — ни повтора, ни звонка", () => {
    expect(deliveryProblem("skipped: client_not_notifiable")).toMatchObject({ retry: false, call: false });
    expect(deliveryProblem("skipped: not_found")).toMatchObject({ retry: false, call: false });
  });
});

describe("приглашение в команду", () => {
  const facts = {
    name: "Дильноза",
    role: "manager" as const,
    by: "telegram" as const,
    username: "dilnoza",
    bot: "bayramm_bot",
    adminUrl: "https://admin.bayramm.uz/",
    phoneLogin: true,
  };

  it("бот → /start → панель; вход — с того аккаунта Telegram; сайт — запасной путь", () => {
    const text = teamInviteText(facts);
    expect(text).toContain("https://t.me/bayramm_bot");
    expect(text).toContain("/start");
    expect(text).toContain("@dilnoza");
    expect(text).toContain("https://admin.bayramm.uz/?signin=1");
    // Номера в тексте нет
    expect(text).not.toMatch(/\+998/);
  });

  it("бота нет (Telegram не ответил) — только сайт", () => {
    const text = teamInviteText({ ...facts, bot: null, by: "phone", username: null });
    expect(text).not.toContain("t.me");
    expect(text).toContain("https://admin.bayramm.uz/?signin=1");
  });

  it("«Отправить в Telegram»: первая ссылка — ссылкой сообщения, текст целиком", () => {
    const text = teamInviteText(facts);
    expect(shareParts(text)).toEqual({ link: "https://t.me/bayramm_bot", text });
    expect(shareParts("без ссылок")).toBeNull();
    const url = new URL(telegramShareUrl("https://t.me/bayramm_bot", "Привет & пока"));
    expect(url.origin + url.pathname).toBe("https://t.me/share/url");
    expect(url.searchParams.get("url")).toBe("https://t.me/bayramm_bot");
    expect(url.searchParams.get("text")).toBe("Привет & пока");
  });
});
