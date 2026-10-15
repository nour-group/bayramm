// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { stickyBar } from "./sticky";

/* В jsdom нет раскладки: высоту панели задаём подменой getBoundingClientRect */
function bar(height: number): HTMLElement {
  const el = document.createElement("div");
  el.getBoundingClientRect = () => ({ height }) as DOMRect;
  document.body.append(el);
  return el;
}

const value = (name: string) => document.documentElement.style.getPropertyValue(name);

afterEach(() => {
  document.body.replaceChildren();
});

describe("stickyBar: высота прилипших панелей → --sticky-t и --sticky-b", () => {
  it("панели у одного края складываются, снятая — уходит из суммы", () => {
    const off = [stickyBar(bar(61), "top"), stickyBar(bar(67), "bottom"), stickyBar(bar(64.4), "bottom")];
    expect(value("--sticky-t")).toBe("61px");
    expect(value("--sticky-b")).toBe("132px");
    off[2]?.();
    expect(value("--sticky-b")).toBe("67px");
    off[0]?.();
    off[1]?.();
    expect(value("--sticky-t")).toBe("0px");
    expect(value("--sticky-b")).toBe("0px");
  });

  it("панель вне документа не считается", () => {
    const el = bar(80);
    const off = stickyBar(el, "bottom");
    el.remove();
    const other = stickyBar(bar(10), "bottom");
    expect(value("--sticky-b")).toBe("10px");
    off();
    other();
  });
});
