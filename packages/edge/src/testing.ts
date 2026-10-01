/* Подделки привязок для тестов воркеров. В код воркеров не импортировать. */

import type { FetcherLike } from "./api-proxy";

/** Привязка, которая запоминает полученные запросы */
export interface RecordingFetcher extends FetcherLike {
  readonly requests: Request[];
}

export function recordingFetcher(
  respond: (request: Request) => Response | Promise<Response>,
): RecordingFetcher {
  const requests: Request[] = [];
  return {
    requests,
    async fetch(request) {
      requests.push(request);
      return respond(request);
    },
  };
}

export interface StaticFile {
  readonly body: string;
  readonly type: string;
}

/**
 * ASSETS как у Cloudflare с `not_found_handling: "single-page-application"`: файл по пути,
 * а для неизвестного пути — /index.html со статусом 200. Без index.html — 404.
 */
export function spaAssets(files: Readonly<Record<string, StaticFile>>): RecordingFetcher {
  return recordingFetcher((request) => {
    const { pathname } = new URL(request.url);
    const file = files[pathname === "/" ? "/index.html" : pathname] ?? files["/index.html"];
    if (!file) return new Response("Not Found", { status: 404 });
    return new Response(request.method === "HEAD" ? null : file.body, {
      headers: { "content-type": file.type, etag: `"${file.body.length}"` },
    });
  });
}

/** Минимальная сборка SPA: index.html, скрипт и шрифт с хэшем, файлы public без хэша */
export const SPA_FILES: Readonly<Record<string, StaticFile>> = {
  "/index.html": {
    body: '<!doctype html><div id="root"></div><script type="module" src="/assets/index.js"></script>',
    type: "text/html",
  },
  "/assets/index.js": { body: "console.log(1)", type: "text/javascript" },
  "/assets/manrope-latin-Cq3x8a.woff2": { body: "wOF2", type: "font/woff2" },
  "/og.png": { body: "PNG", type: "image/png" },
  "/robots.txt": { body: "User-agent: *", type: "text/plain" },
};

/** API, которое отвечает JSON с тем, что к нему пришло */
export function echoApi(): RecordingFetcher {
  return recordingFetcher(async (request) => {
    const url = new URL(request.url);
    return Response.json({
      method: request.method,
      path: url.pathname,
      search: url.search,
      body: request.body ? await request.text() : null,
    });
  });
}
