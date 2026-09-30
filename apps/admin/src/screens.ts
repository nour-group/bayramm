/* Экраны панели — отдельными частями сборки (code splitting): первый экран в Telegram
   грузит оболочку и только свой раздел. Раздел и страницы его объектов — один модуль,
   один кусок. Загрузчики — в одной карте: по ней же оболочка заранее подгружает разделы
   нижней панели, пока человек смотрит на первый экран, а тесты — всё сразу. */

import { lazy } from "react";
import type { Section } from "./router";

const LOADERS = {
  vendors: () => import("./pages/Vendors"),
  vendor: () => import("./pages/Vendor"),
  listing: () => import("./pages/Listing"),
  moderation: () => import("./pages/Moderation"),
  requests: () => import("./pages/Requests"),
  metrics: () => import("./pages/Metrics"),
  clients: () => import("./pages/Clients"),
  revision: () => import("./pages/Revision"),
  notifications: () => import("./pages/Notifications"),
  audit: () => import("./pages/Audit"),
  team: () => import("./pages/Team"),
  settings: () => import("./pages/Settings"),
} as const;

export const VendorsPage = lazy(() => LOADERS.vendors().then((m) => ({ default: m.VendorsPage })));
export const VendorPage = lazy(() => LOADERS.vendor().then((m) => ({ default: m.VendorPage })));
export const VendorNewPage = lazy(() => LOADERS.vendor().then((m) => ({ default: m.VendorNewPage })));
export const ListingPage = lazy(() => LOADERS.listing().then((m) => ({ default: m.ListingPage })));
export const ListingNewPage = lazy(() => LOADERS.listing().then((m) => ({ default: m.ListingNewPage })));
export const ModerationPage = lazy(() => LOADERS.moderation().then((m) => ({ default: m.ModerationPage })));
export const RequestsPage = lazy(() => LOADERS.requests().then((m) => ({ default: m.RequestsPage })));
export const RequestPage = lazy(() => LOADERS.requests().then((m) => ({ default: m.RequestPage })));
export const MetricsPage = lazy(() => LOADERS.metrics().then((m) => ({ default: m.MetricsPage })));
export const ClientsPage = lazy(() => LOADERS.clients().then((m) => ({ default: m.ClientsPage })));
export const ClientPage = lazy(() => LOADERS.clients().then((m) => ({ default: m.ClientPage })));
export const RevisionPage = lazy(() => LOADERS.revision().then((m) => ({ default: m.RevisionPage })));
export const NotificationsPage = lazy(() =>
  LOADERS.notifications().then((m) => ({ default: m.NotificationsPage })),
);
export const AuditPage = lazy(() => LOADERS.audit().then((m) => ({ default: m.AuditPage })));
export const TeamPage = lazy(() => LOADERS.team().then((m) => ({ default: m.TeamPage })));
export const SettingsPage = lazy(() => LOADERS.settings().then((m) => ({ default: m.SettingsPage })));

/** Заранее подгрузить разделы: ошибку сети не показываем — раздел загрузится при переходе */
export function preloadSections(sections: readonly Section[]): void {
  for (const section of sections) void LOADERS[section]().catch(() => {});
}

/** Все экраны сразу (тесты: переход не ждёт загрузки куска) */
export function preloadAll(): Promise<unknown> {
  return Promise.all(Object.values(LOADERS).map((load) => load()));
}
