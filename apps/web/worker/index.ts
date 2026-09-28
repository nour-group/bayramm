import { taklifnomaRedirect } from "./legacy";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const legacy = taklifnomaRedirect(url);
    if (legacy) return legacy;

    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      if (!env.API) return Response.json({ error: "api_unavailable" }, { status: 503 });
      const target = new URL(url);
      target.pathname = url.pathname.slice("/api".length) || "/";
      return env.API.fetch(new Request(target, request));
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
