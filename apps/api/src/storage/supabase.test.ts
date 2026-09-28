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
