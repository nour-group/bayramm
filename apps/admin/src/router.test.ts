// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  goBack,
  HOME,
  historyIndex,
  homeOf,
  hrefOf,
  isNested,
  matchRoute,
  matchSection,
  NAV,
  parentOf,
  parseView,
  pathOf,
  ROUTES,
  readQuery,
  restoreScroll,
  SECTION_PERMISSION,
  savedScroll,
  sectionOf,
  TAB_SECTIONS,
  tabsFor,
  writeQuery,
} from "./router";
import { t } from "./texts";

describe("маршруты панели оператора", () => {
  it.each([
    ["/", HOME],
    ["/vendors", "vendors"],
    ["/moderation/", "moderation"],
    ["/requests", "requests"],
    ["/clients", "clients"],
    ["/login", "login"],
    ["/auth/callback", "authCallback"],
  ])("%s → %s", (path, route) => {
    expect(matchRoute(path)).toBe(route);
  });

  it.each(["/api", "/vendors/3", "/index.html", "/login/other"])("%s — не найдено", (path) => {
    expect(matchRoute(path)).toBeNull();
  });

  it("разделы — только из навигации; страницы входа разделами не считаются", () => {
    expect(matchSection("/moderation")).toBe("moderation");
    expect(matchSection("/")).toBe(HOME);
    expect(matchSection("/login")).toBeNull();
    expect(matchSection("/auth/callback")).toBeNull();
    expect(matchSection("/nope")).toBeNull();
  });

  it("пути не повторяются; в навигации все разделы — в порядке нижней панели, потом остальные", () => {
    const paths = Object.values(ROUTES);
    expect(new Set(paths).size).toBe(paths.length);
    expect(NAV).toEqual([
      "requests",
      "moderation",
      "vendors",
      "metrics",
      "clients",
      "notifications",
      "audit",
      "team",
      "settings",
    ]);
    // Компьютер и телефон — один порядок: кнопки нижней панели идут в навигации первыми
    expect(NAV.slice(0, TAB_SECTIONS.length)).toEqual(TAB_SECTIONS);
  });

  it("главный экран — первый раздел нижней панели, доступный роли", () => {
    // Администратор и менеджер — заявки
    expect(homeOf(NAV)).toBe("requests");
    expect(homeOf(["vendors", "moderation", "requests", "metrics", "clients", "notifications"])).toBe(
      "requests",
    );
    // Модератор заявок не видит — модерация
    expect(homeOf(["vendors", "moderation", "metrics"])).toBe("moderation");
    // Роль без ежедневных разделов — первый свой; без разделов — запасной
    expect(homeOf(["audit", "team"])).toBe("audit");
    expect(homeOf([])).toBe(HOME);
  });

  it("ссылка с параметрами: /requests?sla=late, пустые значения в адрес не попадают", () => {
    expect(hrefOf({ name: "requests", query: { sla: "late" } })).toBe("/requests?sla=late");
    expect(hrefOf({ name: "requests", query: { q: "V101", status: "" } })).toBe("/requests?q=V101");
    expect(hrefOf({ name: "listing", id: "x", query: { focus: "photos" } })).toBe("/listings/x?focus=photos");
    expect(hrefOf({ name: "vendors" })).toBe("/vendors");
    // Путь экрана — без параметров: им сравниваются экраны
    expect(pathOf({ name: "requests", query: { sla: "late" } })).toBe("/requests");
  });

  it("параметры адреса: читаются только свои ключи, пишутся без новой записи истории", () => {
    window.history.replaceState({ idx: 3 }, "", "/requests?sla=late&q=%20V101%20&foreign=1");
    expect(readQuery(["sla", "q", "status"] as const)).toEqual({ sla: "late", q: "V101" });
    const length = window.history.length;
    writeQuery(["sla", "status"] as const, { status: "new" });
    expect(window.location.pathname + window.location.search).toBe("/requests?q=+V101+&foreign=1&status=new");
    // Номер записи истории и её длина — те же: «назад» панели не сбивается
    expect(historyIndex()).toBe(3);
    expect(window.history.length).toBe(length);
    // Ушли с экрана — запоздавшая запись адрес не трогает
    writeQuery(["status"] as const, {}, "/vendors");
    expect(window.location.search).toContain("status=new");
  });

  it("прокрутка записи истории: возвращается, когда страница до неё дорастёт", () => {
    window.history.replaceState({ idx: 1, scroll: 640 }, "", "/vendors");
    expect(savedScroll()).toBe(640);
    window.history.replaceState({ idx: 1 }, "", "/vendors");
    expect(savedScroll()).toBeNull();

    vi.useFakeTimers();
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    let height = 300;
    const doc = vi.spyOn(document.documentElement, "scrollHeight", "get").mockImplementation(() => height);
    restoreScroll(640);
    expect(scrollTo).not.toHaveBeenCalled();
    // Список догрузился — страница выросла: прокрутка туда же, где была
    height = 640 + window.innerHeight;
    vi.advanceTimersByTime(60);
    expect(scrollTo).toHaveBeenCalledWith(0, 640);
    scrollTo.mockClear();
    vi.advanceTimersByTime(5000);
    expect(scrollTo).not.toHaveBeenCalled();
    doc.mockRestore();
    scrollTo.mockRestore();
    vi.useRealTimers();
  });

  it("у каждого раздела — право, без которого его нет в навигации; команда, настройки и журнал — только администратору", () => {
    for (const section of NAV) expect(SECTION_PERMISSION[section]).toBeTruthy();
    expect(SECTION_PERMISSION.team).toBe("team.manage");
    expect(SECTION_PERMISSION.settings).toBe("settings.write");
    expect(SECTION_PERMISSION.audit).toBe("audit.read");
  });

  it.each([
    [
      "/clients/aaaaaaaa-0000-0000-0000-000000000001",
      { name: "client", id: "aaaaaaaa-0000-0000-0000-000000000001" },
    ],
    [
      "/revisions/BBBBBBBB-0000-0000-0000-000000000001",
      { name: "revision", id: "bbbbbbbb-0000-0000-0000-000000000001" },
    ],
    ["/audit", { name: "audit" }],
  ] as const)("экран %s ↔ путь", (path, view) => {
    expect(parseView(path)).toEqual(view);
    expect(pathOf(view)).toBe(path.toLowerCase());
  });

  it("клиент — в разделе «Клиенты», правка карточки — в «Модерации»", () => {
    expect(sectionOf({ name: "client", id: "x" })).toBe("clients");
    expect(sectionOf({ name: "revision", id: "x" })).toBe("moderation");
  });

  it("нижняя панель: разделов больше пяти — четыре частых и «Ещё» с остальными в порядке навигации", () => {
    expect(tabsFor(NAV)).toEqual({
      tabs: ["requests", "moderation", "vendors", "metrics"],
      more: ["clients", "notifications", "audit", "team", "settings"],
    });
  });

  it("нижняя панель: ежедневные разделы — кнопками по частоте; пять и меньше — без «Ещё»", () => {
    expect(tabsFor(["vendors", "moderation", "requests", "clients", "metrics"])).toEqual({
      tabs: ["requests", "moderation", "vendors", "metrics", "clients"],
      more: [],
    });
    expect(tabsFor(["vendors", "moderation"])).toEqual({ tabs: ["moderation", "vendors"], more: [] });
    // Кнопки — разделы навигации, каждый один раз
    expect(TAB_SECTIONS.every((section) => NAV.includes(section))).toBe(true);
    expect(new Set(TAB_SECTIONS).size).toBe(TAB_SECTIONS.length);
  });

  it("нижняя панель: «Уведомления», журнал, команда, настройки — только в «Ещё», без сокращений", () => {
    // Роль с пятью разделами, среди них уведомления: четыре кнопки и «Ещё»
    expect(tabsFor(["vendors", "moderation", "requests", "metrics", "notifications"])).toEqual({
      tabs: ["requests", "moderation", "vendors", "metrics"],
      more: ["notifications"],
    });
    // Менеджер (шесть разделов) и модератор (три) — как и были
    expect(tabsFor(["vendors", "moderation", "requests", "metrics", "clients", "notifications"])).toEqual({
      tabs: ["requests", "moderation", "vendors", "metrics"],
      more: ["clients", "notifications"],
    });
    expect(tabsFor(["vendors", "moderation", "metrics"])).toEqual({
      tabs: ["moderation", "vendors", "metrics"],
      more: [],
    });
    for (const section of ["notifications", "audit", "team", "settings"] as const)
      expect(TAB_SECTIONS).not.toContain(section);
  });

  it("экран объекта вложен в раздел; «назад» без истории — к разделу, новая карточка — к вендору", () => {
    const id = "aaaaaaaa-0000-0000-0000-000000000001";
    expect(isNested({ name: "requests" })).toBe(false);
    expect(isNested({ name: "request", id })).toBe(true);
    expect(isNested(null)).toBe(false);
    expect(parentOf({ name: "request", id })).toEqual({ name: "requests" });
    expect(parentOf({ name: "revision", id })).toEqual({ name: "moderation" });
    expect(parentOf({ name: "listingNew", vendorId: id })).toEqual({ name: "vendor", id });
  });

  it("«назад»: переходили внутри панели — по истории, открыли сразу здесь — к разделу вместо записи", () => {
    const id = "aaaaaaaa-0000-0000-0000-000000000001";
    const navigate = vi.fn();
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    window.history.replaceState(null, "", `/clients/${id}`);
    expect(historyIndex()).toBe(0);
    goBack({ name: "client", id }, navigate);
    expect(navigate).toHaveBeenCalledWith({ name: "clients" }, { replace: true });
    expect(back).not.toHaveBeenCalled();

    window.history.replaceState({ idx: 2 }, "", `/clients/${id}`);
    goBack({ name: "client", id }, navigate);
    expect(back).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledTimes(1);
    back.mockRestore();
  });

  it("у каждого раздела есть название и пояснение", () => {
    for (const route of NAV) {
      expect(t[route]).toBeTruthy();
      expect(t[`${route}Lead`]).toBeTruthy();
    }
  });
});
