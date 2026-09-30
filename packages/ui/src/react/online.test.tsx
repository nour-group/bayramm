// @vitest-environment jsdom
import { act, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectivityProvider, OfflineBanner, useConnectivity, useOnReconnect } from "./online";
import { cleanup, render } from "./test/harness";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const fire = (type: "online" | "offline") => act(() => void window.dispatchEvent(new Event(type)));

function Probe() {
  const { online, returns } = useConnectivity();
  const [retries, setRetries] = useState(0);
  useOnReconnect(() => setRetries((n) => n + 1));
  return <p id="probe">{`${online ? "online" : "offline"} ${returns} ${retries}`}</p>;
}

const probe = () => document.getElementById("probe")?.textContent;
const banner = () => document.querySelector('[role="status"].ui-net');

describe("связь", () => {
  it("события offline и online: состояние, счётчик возвратов, повтор загрузки", () => {
    render(
      <ConnectivityProvider>
        <Probe />
      </ConnectivityProvider>,
    );
    expect(probe()).toBe("online 0 0");
    fire("offline");
    expect(probe()).toBe("offline 0 0");
    fire("offline");
    fire("online");
    expect(probe()).toBe("online 1 1");
    // online без offline перед ним — не возврат
    fire("online");
    expect(probe()).toBe("online 1 1");
  });

  it("начальное значение — navigator.onLine, если он есть", () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    render(
      <ConnectivityProvider>
        <Probe />
      </ConnectivityProvider>,
    );
    expect(probe()).toBe("offline 0 0");
  });

  it("без провайдера — «сеть есть»: старые экраны работают как раньше", () => {
    render(<Probe />);
    expect(probe()).toBe("online 0 0");
  });

  it("баннер: живая область есть всегда; «нет связи», затем ненадолго «связь вернулась»", () => {
    vi.useFakeTimers();
    render(
      <ConnectivityProvider>
        <OfflineBanner offline="Нет связи" back="Связь вернулась" backMs={1000} />
      </ConnectivityProvider>,
    );
    expect(banner()?.textContent).toBe("");
    fire("offline");
    expect(banner()?.textContent).toBe("Нет связи");
    fire("online");
    expect(banner()?.textContent).toBe("Связь вернулась");
    act(() => void vi.advanceTimersByTime(1000));
    expect(banner()?.textContent).toBe("");
  });
});
