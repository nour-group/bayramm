import { describe, expect, it } from "vitest";
import { listingPhotoStorage, OBJECT_CACHE_CONTROL, StorageError, supabaseStorage } from "./supabase";

const URL_BASE = "https://project.supabase.example";
const KEY = "listings/0b5c2a3e-1111-4a2b-9c3d-000000000101/7f0e6d5c-2222-4b3a-8d4e-0000000000f1.webp";
const OBJECT_URL = `${URL_BASE}/storage/v1/object/listing-photos/${KEY}`;

function fakeFetch(respond: (request: Request) => Response | Promise<Response>) {
  const requests: Request[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    return respond(request);
  }) as typeof fetch;
  return { fetcher, requests };
}

function storage(respond: (request: Request) => Response | Promise<Response>) {
  const fake = fakeFetch(respond);
  const client = supabaseStorage({
    url: `${URL_BASE}/`,
    serviceKey: "service-key",
    bucket: "listing-photos",
    fetch: fake.fetcher,
  });
  return { client, requests: fake.requests };
}

const storageError = (statusCode: string, httpStatus = 400) =>
  Response.json({ statusCode, error: "e", message: "m" }, { status: httpStatus });

async function caught(run: () => Promise<unknown>): Promise<StorageError> {
  try {
    await run();
  } catch (err) {
    if (err instanceof StorageError) return err;
    throw err;
  }
  throw new Error("ожидалась StorageError");
}

describe("supabaseStorage.put", () => {
  it("POST объекта: ключ service_role, тип, без перезаписи, долгий кэш", async () => {
    const { client, requests } = storage(() => Response.json({ Key: `listing-photos/${KEY}` }));
    const body = new Uint8Array([1, 2, 3, 4]);
    await client.put(KEY, body, "image/webp");

    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request?.method).toBe("POST");
    expect(request?.url).toBe(OBJECT_URL);
    expect(request?.headers.get("apikey")).toBe("service-key");
    expect(request?.headers.get("authorization")).toBe("Bearer service-key");
    expect(request?.headers.get("content-type")).toBe("image/webp");
    expect(request?.headers.get("x-upsert")).toBe("false");
    expect(request?.headers.get("cache-control")).toBe(OBJECT_CACHE_CONTROL);
    expect(new Uint8Array(await (request as Request).arrayBuffer())).toEqual(body);
  });

  it("объект уже есть: statusCode 409 в JSON при HTTP 400 и честный HTTP 409", async () => {
    for (const res of [() => storageError("409"), () => storageError("409", 409)]) {
      const { client } = storage(res);
      const err = await caught(() => client.put(KEY, new Uint8Array(1), "image/webp"));
      expect(err).toMatchObject({ reason: "exists", status: 409 });
    }
  });

  it("причины отказа", async () => {
    const cases: [() => Response, string][] = [
      [() => storageError("413", 413), "rejected"],
      [() => storageError("415"), "rejected"],
      [() => storageError("403", 403), "misconfigured"],
      [() => new Response("Unauthorized", { status: 401 }), "misconfigured"],
      [() => storageError("404"), "misconfigured"], // нет бакета
      [() => new Response("upstream", { status: 502 }), "unavailable"],
    ];
    for (const [respond, reason] of cases) {
      const { client } = storage(respond);
      expect((await caught(() => client.put(KEY, new Uint8Array(1), "image/webp"))).reason).toBe(reason);
    }
  });

  it("нет ответа — unavailable со статусом 0", async () => {
    const { client } = storage(() => {
      throw new TypeError("fetch failed");
    });
    expect(await caught(() => client.put(KEY, new Uint8Array(1), "image/webp"))).toMatchObject({
      reason: "unavailable",
      status: 0,
    });
  });
});

describe("supabaseStorage.remove", () => {
  it("DELETE объекта", async () => {
    const { client, requests } = storage(() => Response.json({ message: "Successfully deleted" }));
    await client.remove(KEY);
    expect(requests[0]?.method).toBe("DELETE");
    expect(requests[0]?.url).toBe(OBJECT_URL);
    expect(requests[0]?.headers.get("apikey")).toBe("service-key");
  });

  it("объекта нет — не ошибка", async () => {
    for (const res of [() => storageError("404"), () => new Response("Not found", { status: 404 })]) {
      const { client } = storage(res);
      await expect(client.remove(KEY)).resolves.toBeUndefined();
    }
  });

  it("хранилище недоступно — ошибка", async () => {
    const { client } = storage(() => new Response("boom", { status: 500 }));
    expect((await caught(() => client.remove(KEY))).reason).toBe("unavailable");
  });
});

describe("настройка", () => {
  it("без ключа или с кривым адресом — ошибка сразу, а не на первом запросе", () => {
    expect(() => supabaseStorage({ url: URL_BASE, serviceKey: "", bucket: "b" })).toThrow(TypeError);
    expect(() => supabaseStorage({ url: "project.supabase.co", serviceKey: "k", bucket: "b" })).toThrow(
      TypeError,
    );
  });

  it("listingPhotoStorage берёт адрес и ключ из окружения, бакет — listing-photos", async () => {
    expect(() =>
      listingPhotoStorage({ SUPABASE_URL: "http://127.0.0.1:54321", SUPABASE_SERVICE_ROLE_KEY: "" }),
    ).toThrow(TypeError);
    expect(
      listingPhotoStorage({ SUPABASE_URL: "http://127.0.0.1:54321", SUPABASE_SERVICE_ROLE_KEY: "k" }),
    ).toBeDefined();
  });
});

describe("supabaseStorage.list", () => {
  it("list-v2: все объекты под префиксом, страницами по курсору", async () => {
    const { client, requests } = storage(() =>
      Response.json({
        hasNext: true,
        nextCursor: "c2",
        folders: [],
        objects: [
          { name: KEY, created_at: "2026-09-30T10:00:00.000Z", metadata: { size: 1 } },
          { name: 42, created_at: "x" },
          { name: `${KEY}.bak`, created_at: "not a date" },
        ],
      }),
    );
    const page = await client.list("listings/", null, 500);
    expect(page).toEqual({
      objects: [
        { key: KEY, createdAt: new Date("2026-09-30T10:00:00.000Z") },
        { key: `${KEY}.bak`, createdAt: null },
      ],
      cursor: "c2",
    });
    const [request] = requests;
    expect(request?.method).toBe("POST");
    expect(request?.url).toBe(`${URL_BASE}/storage/v1/object/list-v2/listing-photos`);
    expect(request?.headers.get("authorization")).toBe("Bearer service-key");
    expect(await request?.json()).toEqual({ prefix: "listings/", limit: 500, with_delimiter: false });

    await client.list("listings/", "c2", 500);
    expect(await requests[1]?.json()).toMatchObject({ cursor: "c2" });
  });

  it("последняя страница — курсора нет; ошибка и странный ответ — StorageError", async () => {
    const last = storage(() => Response.json({ hasNext: false, objects: [] }));
    expect(await last.client.list("listings/", null, 10)).toEqual({ objects: [], cursor: null });
    const failing = storage(() => storageError("500", 500));
    expect((await caught(() => failing.client.list("x/", null, 1))).reason).toBe("unavailable");
    const odd = storage(() => Response.json({ nope: 1 }));
    expect((await caught(() => odd.client.list("x/", null, 1))).reason).toBe("unavailable");
  });
});

describe("supabaseStorage.removeMany", () => {
  it("одним запросом DELETE на бакет; ответ — сколько удалено", async () => {
    const { client, requests } = storage(() => Response.json([{ name: KEY }]));
    expect(await client.removeMany([KEY, `${KEY}.missing`])).toBe(1);
    const [request] = requests;
    expect(request?.method).toBe("DELETE");
    expect(request?.url).toBe(`${URL_BASE}/storage/v1/object/listing-photos`);
    expect(await request?.json()).toEqual({ prefixes: [KEY, `${KEY}.missing`] });
  });

  it("пусто — без запроса; больше 1000 — ошибка кода; отказ хранилища — StorageError", async () => {
    const { client, requests } = storage(() => Response.json([]));
    expect(await client.removeMany([])).toBe(0);
    expect(requests).toHaveLength(0);
    await expect(client.removeMany(Array.from({ length: 1001 }, () => KEY))).rejects.toBeInstanceOf(
      RangeError,
    );
    const failing = storage(() => storageError("403", 400));
    expect((await caught(() => failing.client.removeMany([KEY]))).reason).toBe("misconfigured");
  });
});
