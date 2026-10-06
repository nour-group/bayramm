import { describe, expect, it } from "vitest";
import { ipKey, limitAddress } from "./ip";

const KEY = "k".repeat(32);

describe("адрес для лимитов частоты", () => {
  it("IPv4 и IPv4 в IPv6 — сам адрес", () => {
    expect(limitAddress("203.0.113.7")).toBe("203.0.113.7");
    expect(limitAddress("::ffff:203.0.113.7")).toBe("203.0.113.7");
  });

  it("IPv6 — сеть /64 в любой записи", () => {
    expect(limitAddress("2001:db8:85a3:42:1:2:3:4")).toBe("2001:db8:85a3:42::/64");
    expect(limitAddress("2001:0DB8:85A3:0042:ffff:ffff:ffff:ffff")).toBe("2001:db8:85a3:42::/64");
    expect(limitAddress("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(limitAddress("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
  });

  it("непонятная строка — как есть", () => {
    expect(limitAddress("2001:db8::1::2")).toBe("2001:db8::1::2");
    expect(limitAddress("not-an-ip")).toBe("not-an-ip");
  });

  it("два адреса одной сети /64 — один ключ лимита, разных сетей — разные", async () => {
    const a = await ipKey(KEY, "2001:db8:85a3:42::1");
    expect(await ipKey(KEY, "2001:db8:85a3:42:dead:beef:0:1")).toBe(a);
    expect(await ipKey(KEY, "2001:db8:85a3:43::1")).not.toBe(a);
  });
});
