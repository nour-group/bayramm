import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CACHE_FALLBACK,
  CACHE_VARIANT,
  createMediaHandler,
  type Fetch,
  negotiateFormat,
  originUrl,
} from "./handler";

const SUPABASE_URL = "https://project.supabase.example";
const ENV = { SUPABASE_URL };
const KEY = "listings/0b5c2a3e-1111-4a2b-9c3d-000000000101/7f0e6d5c-2222-4b3a-8d4e-0000000000f1.webp";
const ORIGIN = `${SUPABASE_URL}/storage/v1/object/public/listing-photos/${KEY}`;
const CHROME_ACCEPT = "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8";

interface Call {
  url: string;
  init: RequestInit<RequestInitCfProperties> | undefined;
}

/** fetch, который отвечает по сценарию: сначала на запрос с cf.image, потом без */
function fakeFetch(respond: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetcher: Fetch = async (url, init) => {
    const call = { url, init };
    calls.push(call);
    return respond(call);
  };
  return { fetcher, calls };
}

const imageResponse = (type: string, extra: Record<string, string> = {}) =>
  new Response(new Uint8Array([1, 2, 3]), {
    headers: {
      "content-type": type,
      "content-length": "3",
      etag: '"abc"',
      "x-amz-request-id": "internal",
      "set-cookie": "sb=1",
      ...extra,
    },
  });

const notFoundFromStorage = () =>
  Response.json({ statusCode: "404", error: "not_found", message: "Object not found" }, { status: 400 });

async function get(fetcher: Fetch, path: string, init: RequestInit = {}) {
  return createMediaHandler(fetcher)(new Request(`https://media.bayramm.uz${path}`, init), ENV);
}

afterEach(() => vi.restoreAllMocks());

describe("negotiateFormat", () => {
  it("AVIF → WebP → JPEG по Accept", () => {
    expect(negotiateFormat(CHROME_ACCEPT)).toBe("avif");
    expect(negotiateFormat("image/webp,*/*")).toBe("webp");
    expect(negotiateFormat("image/png,image/*;q=0.8")).toBe("jpeg");
    expect(negotiateFormat("*/*")).toBe("jpeg");
    expect(negotiateFormat(null)).toBe("jpeg");
  });

  it("адрес оригинала — публичный объект бакета", () => {
    expect(originUrl(`${SUPABASE_URL}/`, KEY)).toBe(ORIGIN);
  });
});

describe("вариант фото", () => {
  it("идёт в Storage с cf.image: ширина, scale-down, качество 85, формат по Accept, без метаданных", async () => {
    const { fetcher, calls } = fakeFetch(() =>
      imageResponse("image/avif", { "cf-resized": "internal=ok/- q=0" }),
    );
    const res = await get(fetcher, `/640/${KEY}`, { headers: { accept: CHROME_ACCEPT } });

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(ORIGIN);
    expect(calls[0]?.init?.cf?.image).toEqual({
      width: 640,
      fit: "scale-down",
      quality: 85,
      format: "avif",
      metadata: "none",
      anim: false,
    });
    expect(res.headers.get("content-type")).toBe("image/avif");
    expect(res.headers.get("cache-control")).toBe(CACHE_VARIANT);
    expect(res.headers.get("vary")).toBe("Accept");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("strict-transport-security")).toBe("max-age=31536000");
    expect(res.headers.get("etag")).toBe('"abc"');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("служебные заголовки хранилища наружу не уходят", async () => {
    const { fetcher } = fakeFetch(() => imageResponse("image/webp"));
    const res = await get(fetcher, `/320/${KEY}`, { headers: { accept: "image/webp" } });
    expect(res.headers.get("x-amz-request-id")).toBeNull();
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("старый браузер без WebP получает JPEG", async () => {
    const { fetcher, calls } = fakeFetch(() => imageResponse("image/jpeg"));
    await get(fetcher, `/1920/${KEY}`, { headers: { accept: "*/*" } });
    expect(calls[0]?.init?.cf?.image?.format).toBe("jpeg");
  });

  it("HEAD — заголовки без тела", async () => {
    const { fetcher } = fakeFetch(() => imageResponse("image/webp"));
    const res = await get(fetcher, `/960/${KEY}`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(res.body).toBeNull();
  });
});

describe("чего не бывает — 404 без похода в хранилище", () => {
  for (const path of [
    "/",
    "/favicon.ico",
    `/641/${KEY}`,
    `/3840/${KEY}`,
    `/640/${KEY.replace(".webp", ".svg")}`,
    "/640/listings/../secret.webp",
    `/640/other/${KEY}`,
  ]) {
    it(path, async () => {
      const { fetcher, calls } = fakeFetch(() => imageResponse("image/webp"));
      const res = await get(fetcher, path);
      expect(res.status).toBe(404);
      expect(calls).toHaveLength(0);
    });
  }

  it("по http — 301 на https, без похода в хранилище", async () => {
    const { fetcher, calls } = fakeFetch(() => imageResponse("image/webp"));
    const res = await createMediaHandler(fetcher)(new Request(`http://media.bayramm.uz/640/${KEY}`), ENV);
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe(`https://media.bayramm.uz/640/${KEY}`);
    expect(calls).toHaveLength(0);
  });

  it("кроме GET и HEAD — 405", async () => {
    const { fetcher, calls } = fakeFetch(() => imageResponse("image/webp"));
    const res = await get(fetcher, `/640/${KEY}`, { method: "POST", body: "x" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
    expect(calls).toHaveLength(0);
  });
});

describe("когда преобразование не удалось", () => {
  it("квота или выключенные преобразования — оригинал с коротким кэшем", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fetcher, calls } = fakeFetch(({ init }) =>
      init?.cf?.image
        ? new Response("quota", { status: 403, headers: { "cf-resized": "err=9422" } })
        : imageResponse("image/webp"),
    );
    const res = await get(fetcher, `/640/${KEY}`, { headers: { accept: CHROME_ACCEPT } });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.init?.cf).toBeUndefined();
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(res.headers.get("cache-control")).toBe(CACHE_FALLBACK);
    // Формат и здесь зависел бы от Accept, когда преобразования вернутся: кэши это учитывают
    expect(res.headers.get("vary")).toBe("Accept");
  });

  it("ошибка в Cf-Resized при статусе 200 — тоже не вариант", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fetcher, calls } = fakeFetch(({ init }) =>
      imageResponse("image/webp", init?.cf?.image ? { "cf-resized": "err=9401" } : {}),
    );
    const res = await get(fetcher, `/640/${KEY}`);
    expect(calls).toHaveLength(2);
    expect(res.headers.get("cache-control")).toBe(CACHE_FALLBACK);
  });

  it("объекта нет: Storage отвечает 400/404 — наружу 404, а не 500", async () => {
    for (const missing of [notFoundFromStorage, () => new Response("Not found", { status: 404 })]) {
      const { fetcher, calls } = fakeFetch(({ init }) =>
        init?.cf?.image
          ? new Response("x", { status: 404, headers: { "cf-resized": "err=9404" } })
          : missing(),
      );
      const res = await get(fetcher, `/640/${KEY}`);
      expect(res.status).toBe(404);
      expect(calls).toHaveLength(2);
      expect(res.headers.get("cache-control")).toBe("public, max-age=60");
      expect(res.headers.get("vary")).toBe("Accept");
    }
  });

  it("хранилище падает или недоступно — 502 без подробностей", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const down = fakeFetch(() => new Response("upstream exploded at 10.0.0.1", { status: 503 }));
    const res = await get(down.fetcher, `/640/${KEY}`);
    expect(res.status).toBe(502);
    expect(await res.text()).toBe("Bad gateway");

    const offline = await get(async () => {
      throw new TypeError("network");
    }, `/640/${KEY}`);
    expect(offline.status).toBe(502);
    expect(error).toHaveBeenCalled();
  });

  it("в ответ хранилища подложили не картинку — не отдаём", async () => {
    const { fetcher } = fakeFetch(
      () => new Response("<script>alert(1)</script>", { headers: { "content-type": "text/html" } }),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await get(fetcher, `/640/${KEY}`);
    expect(res.status).toBe(502);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  });
});
