// До Bayramm корень bayramm.uz занимал сайт цифровых приглашений («taklifnomas»).
// Он переехал на поддомен; старые ссылки, разосланные клиентам, ведём туда же.
export const TAKLIFNOMA_ORIGIN = "https://taklifnoma.bayramm.uz";

const PAGES = new Set(["/paketlar", "/classic", "/arabic", "/envelope"]);
// /og.png и /sitemap.xml теперь свои: превью ссылок Bayramm и карта сайта (worker/seo.ts)
const FILES = new Set(["/apple-touch-icon.png", "/manifest.webmanifest"]);

export function isTaklifnomaPath(pathname: string): boolean {
  if (pathname.startsWith("/demo/")) return true;
  if (FILES.has(pathname)) return true;
  const page = pathname.replace(/\.html$/, "").replace(/\/$/, "");
  return PAGES.has(page);
}

export function taklifnomaRedirect(url: URL): Response | null {
  if (!isTaklifnomaPath(url.pathname)) return null;
  return Response.redirect(`${TAKLIFNOMA_ORIGIN}${url.pathname}${url.search}`, 301);
}
