// Фото демо-витрин для workflow «Demo data (staging)»: иллюстрации по категории витрины —
// зал с люстрой, кортеж, камера, букет, торт, казан плова, платье, кольца… Плоские
// фигуры на градиенте в цветах бренда, узор из восьмиконечных звёзд гириха и плашка DEMO.
// Ни людей, ни чужих снимков: всё рисуется здесь же, из SVG.
//
//   node scripts/demo-photos.ts <папка>   → demo-01.webp … demo-75.webp
//
// Порядок файлов — порядок витрин в src/demo/venues.ts, по три на витрину: у каждой
// категории три сюжета, у второй витрины той же категории — другие цвета и зеркальный
// рисунок. Буквы DEMO — линии, а не шрифт: картинка одинакова на любой машине. WebP без
// метаданных — sharp не пишет EXIF, XMP и ICC, пока его об этом не попросить; POST
// /ops/demo всё равно проверяет каждый файл тем же assertUploadable, что и любую загрузку.
//
// Файл — только со стираемым синтаксисом TS: Node запускает его напрямую (снятие типов).

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import { DEMO_PHOTOS_PER_VENUE, DEMO_VENUES } from "../src/demo/venues.ts";

export const DEMO_PHOTO_WIDTH = 1280;
export const DEMO_PHOTO_HEIGHT = 853;
/** По три на каждую демо-витрину (src/demo/venues.ts: DEMO_PHOTO_COUNT) */
export const DEMO_PHOTO_FILES = DEMO_VENUES.length * DEMO_PHOTOS_PER_VENUE;
const QUALITY = 72;

const W = DEMO_PHOTO_WIDTH;
const H = DEMO_PHOTO_HEIGHT;

// Цвета бренда (packages/ui/src/tokens.ts) и тёплое золото для металла и огней
const C = {
  plum: "#2C1B47",
  plumDeep: "#1B1030",
  plumMid: "#4E3170",
  coral: "#ED6545",
  coralDeep: "#BB4225",
  peach: "#F9CDB2",
  cream: "#FFF4EA",
  white: "#FFFFFF",
  lilac: "#F1EAF9",
  teal: "#237870",
  tealSoft: "#E2F1EF",
  berry: "#A82F52",
  gold: "#F2B84B",
  goldDeep: "#C98A1E",
  leaf: "#3E8E6E",
} as const;

// Фон: пары градиента
const BACKGROUNDS: readonly (readonly [string, string])[] = [
  ["#2C1B47", "#A82F52"],
  ["#1B1030", "#237870"],
  ["#4E3170", "#ED6545"],
  ["#1E2A4F", "#4E3170"],
  ["#237870", "#2C1B47"],
  ["#A82F52", "#F9CDB2"],
  ["#2C1B47", "#ED6545"],
  ["#1B1030", "#4E3170"],
  ["#BB4225", "#F2B84B"],
  ["#1E2A4F", "#237870"],
  ["#4E3170", "#F9CDB2"],
];

// ── примитивы ────────────────────────────────────────────────────────────────

const f = (n: number) => Number(n.toFixed(1));

function shadow(cx: number, cy: number, rx: number, ry: number, opacity = 0.22): string {
  return `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="#000" fill-opacity="${opacity}"/>`;
}

/** Восьмиконечная звезда гириха (два квадрата): вершины через 22,5°, внутренние — на 0,765 R */
function star(cx: number, cy: number, r: number, turn: number): string {
  const inner = r * (Math.SQRT1_2 / Math.cos(Math.PI / 8));
  const points: string[] = [];
  for (let i = 0; i < 16; i++) {
    const angle = ((turn + i * 22.5) * Math.PI) / 180;
    const radius = i % 2 === 0 ? r : inner;
    points.push(`${f(cx + radius * Math.cos(angle))},${f(cy + radius * Math.sin(angle))}`);
  }
  return `<polygon points="${points.join(" ")}"/>`;
}

/** Искра — четырёхлучевая звёздочка */
function sparkle(x: number, y: number, r: number, color: string = C.white, opacity = 0.9): string {
  const k = r * 0.22;
  return `<path d="M${x} ${y - r} Q${x + k} ${y - k} ${x + r} ${y} Q${x + k} ${y + k} ${x} ${y + r} Q${x - k} ${y + k} ${x - r} ${y} Q${x - k} ${y - k} ${x} ${y - r}Z" fill="${color}" fill-opacity="${opacity}"/>`;
}

/** Цветок: лепестки кругом и серединка */
function flower(x: number, y: number, r: number, petal: string, heart: string = C.gold, petals = 6): string {
  const parts: string[] = [];
  for (let i = 0; i < petals; i++) {
    const a = (i * 2 * Math.PI) / petals;
    parts.push(
      `<circle cx="${f(x + Math.cos(a) * r * 0.62)}" cy="${f(y + Math.sin(a) * r * 0.62)}" r="${f(r * 0.48)}" fill="${petal}"/>`,
    );
  }
  parts.push(`<circle cx="${x}" cy="${y}" r="${f(r * 0.36)}" fill="${heart}"/>`);
  return parts.join("");
}

/** Роза сверху: круг и спираль */
function rose(x: number, y: number, r: number, color: string, line: string): string {
  return `<circle cx="${x}" cy="${y}" r="${r}" fill="${color}"/><path d="M${x} ${y} m${f(-r * 0.15)} 0 a${f(r * 0.15)} ${f(r * 0.15)} 0 1 1 ${f(r * 0.3)} 0 a${f(r * 0.35)} ${f(r * 0.35)} 0 1 1 ${f(-r * 0.6)} 0 a${f(r * 0.55)} ${f(r * 0.55)} 0 1 1 ${f(r * 1.0)} 0" fill="none" stroke="${line}" stroke-width="${f(r * 0.12)}" stroke-linecap="round"/>`;
}

/** Лист — эллипс под углом */
function leaf(x: number, y: number, len: number, angle: number, color: string = C.leaf): string {
  return `<ellipse cx="${x}" cy="${y}" rx="${f(len / 2)}" ry="${f(len / 5)}" fill="${color}" transform="rotate(${angle} ${x} ${y})"/>`;
}

/** Детерминированный ГПСЧ (mulberry32) — рисунок одинаков при каждом запуске */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Россыпь искр по фону, мимо центра */
function sparkles(seed: number, count = 9): string {
  const rnd = random(seed);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const x = 60 + rnd() * (W - 120);
    const y = 50 + rnd() * (H * 0.45);
    if (Math.abs(x - W / 2) < 260 && y > 160) continue;
    out.push(sparkle(f(x), f(y), f(6 + rnd() * 12), C.white, f(0.35 + rnd() * 0.5)));
  }
  return out.join("");
}

/** Пол — светлая полоса внизу */
function floor(y = 640, opacity = 0.1): string {
  return `<rect x="0" y="${y}" width="${W}" height="${H - y}" fill="#fff" fill-opacity="${opacity}"/>`;
}

// ── сюжеты ───────────────────────────────────────────────────────────────────

type Scene = () => string;

// Зал: люстра и столы; тор с аркой; праздничный стол крупно
const hallBanquet: Scene = () => {
  const crystals = Array.from({ length: 9 }, (_, i) => {
    const x = 520 + i * 30;
    const drop = 40 + (i % 2) * 22 + (i === 4 ? 30 : 0);
    return `<line x1="${x}" y1="190" x2="${x}" y2="${190 + drop}" stroke="${C.gold}" stroke-width="2"/><circle cx="${x}" cy="${194 + drop}" r="7" fill="${C.cream}"/>`;
  }).join("");
  const table = (cx: number, cy: number, s: number) =>
    `${shadow(cx, cy + 92 * s, 150 * s, 18 * s)}` +
    `<rect x="${cx - 60 * s}" y="${cy - 70 * s}" width="${36 * s}" height="${70 * s}" rx="${10 * s}" fill="${C.plumMid}"/>` +
    `<rect x="${cx + 24 * s}" y="${cy - 70 * s}" width="${36 * s}" height="${70 * s}" rx="${10 * s}" fill="${C.plumMid}"/>` +
    `<path d="M${cx - 140 * s} ${cy} Q${cx} ${cy + 40 * s} ${cx + 140 * s} ${cy} L${cx + 128 * s} ${cy + 90 * s} Q${cx} ${cy + 118 * s} ${cx - 128 * s} ${cy + 90 * s}Z" fill="${C.cream}"/>` +
    `<ellipse cx="${cx}" cy="${cy}" rx="${140 * s}" ry="${32 * s}" fill="${C.white}"/>` +
    flower(cx - 20 * s, cy - 10 * s, 16 * s, C.coral) +
    flower(cx + 14 * s, cy - 18 * s, 14 * s, C.peach, C.coralDeep) +
    leaf(cx + 34 * s, cy - 2 * s, 30 * s, -20);
  return (
    sparkles(11) +
    floor(600) +
    `<line x1="640" y1="0" x2="640" y2="120" stroke="${C.gold}" stroke-width="4"/>` +
    `<path d="M500 180 Q640 100 780 180Z" fill="${C.gold}"/>` +
    `<ellipse cx="640" cy="184" rx="150" ry="16" fill="${C.goldDeep}"/>` +
    crystals +
    table(330, 560, 0.85) +
    table(950, 560, 0.85) +
    table(640, 640, 1.1)
  );
};

const hallStage: Scene = () => {
  const clusters = [
    [380, 610],
    [420, 560],
    [860, 610],
    [820, 560],
    [400, 450],
    [880, 450],
  ]
    .map(
      ([x = 0, y = 0], i) =>
        flower(x, y, 30, i % 2 ? C.peach : C.coral, i % 2 ? C.coralDeep : C.gold) +
        leaf(x + 34, y + 10, 46, 30) +
        leaf(x - 34, y + 12, 40, -30),
    )
    .join("");
  return (
    sparkles(12, 12) +
    floor(680) +
    `<path d="M300 0 Q330 300 250 700 L180 700 Q240 300 200 0Z" fill="${C.coral}" fill-opacity="0.85"/>` +
    `<path d="M980 0 Q950 300 1030 700 L1100 700 Q1040 300 1080 0Z" fill="${C.coral}" fill-opacity="0.85"/>` +
    `<path d="M400 690 V420 A240 240 0 0 1 880 420 V690" fill="none" stroke="${C.gold}" stroke-width="26"/>` +
    `<path d="M440 690 V430 A200 200 0 0 1 840 430 V690Z" fill="${C.white}" fill-opacity="0.12"/>` +
    `<g stroke="${C.gold}" stroke-opacity="0.5" fill="none" stroke-width="3">${star(640, 360, 90, 0)}</g>` +
    shadow(640, 690, 230, 20) +
    `<rect x="470" y="560" width="340" height="110" rx="30" fill="${C.cream}"/>` +
    `<rect x="440" y="610" width="400" height="70" rx="26" fill="${C.white}"/>` +
    `<rect x="520" y="700" width="240" height="20" rx="6" fill="${C.goldDeep}"/>` +
    `<rect x="480" y="720" width="320" height="20" rx="6" fill="${C.gold}"/>` +
    clusters
  );
};

const hallTable: Scene = () => {
  const plate = (x: number, y: number) =>
    `<ellipse cx="${x}" cy="${y}" rx="78" ry="30" fill="${C.white}"/><ellipse cx="${x}" cy="${y}" rx="54" ry="20" fill="${C.lilac}"/>`;
  const glass = (x: number, y: number) =>
    `<path d="M${x - 16} ${y - 80} H${x + 16} L${x + 12} ${y - 34} Q${x} ${y - 24} ${x - 12} ${y - 34}Z" fill="${C.white}" fill-opacity="0.85"/><rect x="${x - 2}" y="${y - 30}" width="4" height="26" fill="${C.white}"/><ellipse cx="${x}" cy="${y - 4}" rx="16" ry="5" fill="${C.white}"/>`;
  const candle = (x: number, h: number) =>
    `<rect x="${x - 10}" y="${560 - h}" width="20" height="${h}" rx="4" fill="${C.cream}"/><path d="M${x} ${532 - h} Q${x + 12} ${548 - h} ${x} ${556 - h} Q${x - 12} ${548 - h} ${x} ${532 - h}Z" fill="${C.gold}"/>`;
  return (
    sparkles(13, 6) +
    `<path d="M0 560 H1280 V853 H0Z" fill="${C.cream}"/>` +
    `<path d="M0 560 H1280 V600 H0Z" fill="${C.white}"/>` +
    `<path d="M0 600 Q160 640 320 600 Q480 640 640 600 Q800 640 960 600 Q1120 640 1280 600 V620 H0Z" fill="${C.peach}"/>` +
    candle(250, 140) +
    candle(300, 100) +
    candle(1030, 120) +
    shadow(640, 640, 250, 34, 0.15) +
    `<ellipse cx="640" cy="620" rx="240" ry="70" fill="${C.gold}"/>` +
    `<ellipse cx="640" cy="606" rx="214" ry="56" fill="${C.goldDeep}"/>` +
    `<path d="M470 600 Q640 430 810 600Z" fill="#F7D28A"/>` +
    Array.from(
      { length: 26 },
      (_, i) =>
        `<circle cx="${f(500 + ((i * 37) % 280))}" cy="${f(560 - ((i * 23) % 70))}" r="6" fill="${i % 3 ? C.coral : C.cream}" fill-opacity="0.9"/>`,
    ).join("") +
    plate(330, 720) +
    plate(950, 720) +
    glass(450, 700) +
    glass(830, 700) +
    flower(1120, 520, 34, C.coral) +
    flower(1170, 560, 26, C.peach, C.coralDeep) +
    leaf(1090, 570, 50, 40)
  );
};

// Кортеж: машина с бантом; две машины; ретро
function car(x: number, y: number, s: number, body: string, glass: string = C.tealSoft): string {
  const wheel = (cx: number) =>
    `<circle cx="${cx}" cy="${y + 70 * s}" r="${44 * s}" fill="${C.plumDeep}"/><circle cx="${cx}" cy="${y + 70 * s}" r="${20 * s}" fill="${C.lilac}"/>`;
  return (
    shadow(x, y + 112 * s, 330 * s, 18 * s) +
    `<path d="M${x - 300 * s} ${y + 60 * s} Q${x - 310 * s} ${y - 10 * s} ${x - 220 * s} ${y - 20 * s} L${x - 120 * s} ${y - 30 * s} Q${x - 60 * s} ${y - 110 * s} ${x + 40 * s} ${y - 110 * s} Q${x + 130 * s} ${y - 110 * s} ${x + 170 * s} ${y - 30 * s} L${x + 270 * s} ${y - 14 * s} Q${x + 320 * s} ${y} ${x + 310 * s} ${y + 60 * s} Q${x + 300 * s} ${y + 84 * s} ${x + 270 * s} ${y + 84 * s} H${x - 270 * s} Q${x - 300 * s} ${y + 84 * s} ${x - 300 * s} ${y + 60 * s}Z" fill="${body}"/>` +
    `<path d="M${x - 92 * s} ${y - 32 * s} Q${x - 46 * s} ${y - 94 * s} ${x - 2 * s} ${y - 94 * s} V${y - 32 * s}Z" fill="${glass}"/>` +
    `<path d="M${x + 14 * s} ${y - 94 * s} Q${x + 112 * s} ${y - 94 * s} ${x + 142 * s} ${y - 32 * s} H${x + 14 * s}Z" fill="${glass}"/>` +
    `<rect x="${x + 270 * s}" y="${y + 2 * s}" width="${30 * s}" height="${14 * s}" rx="${6 * s}" fill="${C.gold}"/>` +
    wheel(x - 190 * s) +
    wheel(x + 190 * s)
  );
}

function bow(x: number, y: number, s: number, color: string): string {
  return (
    `<path d="M${x} ${y} Q${x - 70 * s} ${y - 60 * s} ${x - 80 * s} ${y} Q${x - 70 * s} ${y + 60 * s} ${x} ${y}Z" fill="${color}"/>` +
    `<path d="M${x} ${y} Q${x + 70 * s} ${y - 60 * s} ${x + 80 * s} ${y} Q${x + 70 * s} ${y + 60 * s} ${x} ${y}Z" fill="${color}"/>` +
    `<path d="M${x - 6 * s} ${y + 6 * s} L${x - 40 * s} ${y + 80 * s} M${x + 6 * s} ${y + 6 * s} L${x + 44 * s} ${y + 76 * s}" stroke="${color}" stroke-width="${12 * s}" stroke-linecap="round"/>` +
    `<circle cx="${x}" cy="${y}" r="${16 * s}" fill="${C.white}" fill-opacity="0.5"/>`
  );
}

const road = (y: number) =>
  `<rect x="0" y="${y}" width="${W}" height="${H - y}" fill="#000" fill-opacity="0.18"/>` +
  Array.from(
    { length: 7 },
    (_, i) =>
      `<rect x="${i * 200 + 20}" y="${y + 90}" width="120" height="10" rx="5" fill="#fff" fill-opacity="0.5"/>`,
  ).join("");

const carBride: Scene = () =>
  sparkles(21) +
  road(600) +
  car(640, 500, 1.15, C.white) +
  `<path d="M300 470 Q640 520 980 470" fill="none" stroke="${C.coral}" stroke-width="10"/>` +
  bow(560, 430, 0.9, C.coral) +
  flower(820, 400, 24, C.peach, C.coralDeep) +
  flower(860, 410, 18, C.coral);

const carMotorcade: Scene = () =>
  sparkles(22) +
  road(620) +
  car(930, 470, 0.7, C.lilac, C.plumMid) +
  car(470, 540, 1.0, C.white) +
  bow(420, 470, 0.6, C.berry) +
  bow(900, 418, 0.45, C.berry);

const carRetro: Scene = () => {
  const x = 640;
  const y = 520;
  return (
    sparkles(23) +
    road(630) +
    shadow(x, y + 118, 360, 20) +
    `<path d="M${x - 360} ${y + 70} Q${x - 360} ${y - 20} ${x - 250} ${y - 30} Q${x - 160} ${y - 40} ${x - 110} ${y - 40} Q${x - 80} ${y - 150} ${x + 30} ${y - 150} Q${x + 130} ${y - 150} ${x + 160} ${y - 40} Q${x + 300} ${y - 40} ${x + 350} ${y + 10} Q${x + 380} ${y + 60} ${x + 340} ${y + 90} H${x - 340} Q${x - 370} ${y + 90} ${x - 360} ${y + 70}Z" fill="${C.cream}"/>` +
    `<path d="M${x - 300} ${y + 90} Q${x - 300} ${y - 10} ${x - 200} ${y - 10} Q${x - 110} ${y - 10} ${x - 100} ${y + 90}Z" fill="${C.peach}"/>` +
    `<path d="M${x + 110} ${y + 90} Q${x + 110} ${y - 10} ${x + 210} ${y - 10} Q${x + 300} ${y - 10} ${x + 310} ${y + 90}Z" fill="${C.peach}"/>` +
    `<path d="M${x - 70} ${y - 46} Q${x - 50} ${y - 128} ${x + 20} ${y - 128} V${y - 46}Z" fill="${C.tealSoft}"/>` +
    `<path d="M${x + 36} ${y - 128} Q${x + 110} ${y - 128} ${x + 130} ${y - 46} H${x + 36}Z" fill="${C.tealSoft}"/>` +
    `<rect x="${x - 380}" y="${y + 50}" width="760" height="18" rx="9" fill="${C.gold}"/>` +
    `<circle cx="${x + 330}" cy="${y + 10}" r="18" fill="${C.gold}"/>` +
    [x - 200, x + 210]
      .map(
        (cx) =>
          `<circle cx="${cx}" cy="${y + 96}" r="52" fill="${C.plumDeep}"/><circle cx="${cx}" cy="${y + 96}" r="30" fill="${C.cream}"/><circle cx="${cx}" cy="${y + 96}" r="10" fill="${C.gold}"/>`,
      )
      .join("") +
    flower(x - 10, y - 160, 22, C.coral) +
    flower(x + 40, y - 168, 18, C.peach, C.coralDeep) +
    leaf(x + 76, y - 156, 36, 20)
  );
};

// Фото и видео: камера; дрон над городом; карточки снимков
const photoCamera: Scene = () =>
  sparkles(31) +
  shadow(640, 690, 300, 26) +
  `<rect x="360" y="300" width="560" height="360" rx="50" fill="${C.plumDeep}"/>` +
  `<rect x="360" y="380" width="560" height="200" fill="${C.plumMid}"/>` +
  `<rect x="440" y="250" width="160" height="70" rx="20" fill="${C.plumDeep}"/>` +
  `<rect x="760" y="270" width="90" height="40" rx="12" fill="${C.coral}"/>` +
  `<rect x="800" y="340" width="70" height="38" rx="10" fill="${C.cream}"/>` +
  `<circle cx="640" cy="480" r="150" fill="${C.cream}"/>` +
  `<circle cx="640" cy="480" r="124" fill="${C.plumDeep}"/>` +
  `<circle cx="640" cy="480" r="92" fill="${C.teal}"/>` +
  `<circle cx="640" cy="480" r="58" fill="${C.plumDeep}"/>` +
  `<circle cx="610" cy="450" r="20" fill="${C.white}" fill-opacity="0.75"/>` +
  `<circle cx="672" cy="508" r="9" fill="${C.white}" fill-opacity="0.5"/>` +
  `<path d="M360 360 Q250 520 330 720" fill="none" stroke="${C.coral}" stroke-width="16" stroke-linecap="round"/>`;

const photoDrone: Scene = () => {
  const domes = [
    [180, 140],
    [420, 200],
    [700, 160],
    [980, 220],
    [1180, 130],
  ]
    .map(
      ([x = 0, h = 0], i) =>
        `<rect x="${x - 60}" y="${853 - h}" width="120" height="${h}" fill="${i % 2 ? C.plumMid : C.plum}" fill-opacity="0.9"/>` +
        `<path d="M${x - 60} ${853 - h} Q${x} ${853 - h - 90} ${x + 60} ${853 - h}Z" fill="${i % 2 ? C.teal : C.tealSoft}" fill-opacity="${i % 2 ? 0.9 : 0.6}"/>`,
    )
    .join("");
  const rotor = (x: number) =>
    `<rect x="${x - 6}" y="250" width="12" height="40" fill="${C.plumDeep}"/><ellipse cx="${x}" cy="246" rx="90" ry="12" fill="${C.white}" fill-opacity="0.65"/>`;
  return (
    sparkles(32, 12) +
    domes +
    `<path d="M560 380 L480 520 H800 L720 380Z" fill="${C.white}" fill-opacity="0.12"/>` +
    `<path d="M410 290 L520 330 M870 290 L760 330" stroke="${C.plumDeep}" stroke-width="16" stroke-linecap="round"/>` +
    rotor(410) +
    rotor(870) +
    `<rect x="500" y="300" width="280" height="90" rx="40" fill="${C.cream}"/>` +
    `<circle cx="640" cy="400" r="34" fill="${C.plumDeep}"/>` +
    `<circle cx="640" cy="400" r="16" fill="${C.teal}"/>` +
    `<circle cx="700" cy="330" r="8" fill="${C.coral}"/>`
  );
};

const photoPrints: Scene = () => {
  const print = (x: number, y: number, a: number, sky: string, sun: string) =>
    `<g transform="rotate(${a} ${x} ${y})">` +
    shadow(x + 8, y + 12, 170, 140, 0.18) +
    `<rect x="${x - 170}" y="${y - 150}" width="340" height="300" rx="10" fill="${C.white}"/>` +
    `<rect x="${x - 146}" y="${y - 126}" width="292" height="200" fill="${sky}"/>` +
    `<circle cx="${x + 70}" cy="${y - 70}" r="28" fill="${sun}"/>` +
    `<path d="M${x - 146} ${y + 74} L${x - 60} ${y - 20} L${x} ${y + 30} L${x + 60} ${y - 40} L${x + 146} ${y + 74}Z" fill="${C.teal}"/>` +
    `</g>`;
  return (
    sparkles(33) +
    print(470, 460, -10, C.peach, C.coral) +
    print(800, 420, 8, C.lilac, C.gold) +
    `<path d="M600 640 q-30 -40 0 -60 q30 20 0 60z M600 640 q30 -40 0 -60" fill="${C.coral}"/>` +
    `<path d="M612 668 C 560 630 560 590 596 590 C 612 590 612 604 612 604 C 612 604 612 590 628 590 C 664 590 664 630 612 668Z" fill="${C.coral}"/>`
  );
};

// Студия: софтбоксы и фон; окно со светом; циклорама
const studioSoftbox: Scene = () => {
  const lamp = (x: number, flip: number) =>
    `<line x1="${x}" y1="360" x2="${x}" y2="720" stroke="${C.plumDeep}" stroke-width="8"/>` +
    `<path d="M${x - 50} 720 L${x} 680 L${x + 50} 720" stroke="${C.plumDeep}" stroke-width="8" fill="none"/>` +
    `<path d="M${x - 90 * flip} 220 L${x + 70 * flip} 260 L${x + 70 * flip} 420 L${x - 90 * flip} 460Z" fill="${C.cream}"/>` +
    `<path d="M${x + 70 * flip} 260 L${x + 110 * flip} 300 L${x + 110 * flip} 380 L${x + 70 * flip} 420Z" fill="${C.plumDeep}"/>`;
  return (
    sparkles(41, 6) +
    floor(720, 0.12) +
    `<rect x="430" y="110" width="420" height="40" rx="20" fill="${C.plumDeep}"/>` +
    `<path d="M450 140 H830 V640 Q830 740 930 740 H350 Q450 740 450 640Z" fill="${C.peach}"/>` +
    lamp(240, 1) +
    lamp(1040, -1) +
    `<path d="M380 330 L280 280 L280 430Z" fill="${C.white}" fill-opacity="0.12"/>` +
    shadow(640, 730, 110, 14) +
    `<rect x="580" y="600" width="120" height="24" rx="8" fill="${C.coral}"/>` +
    `<path d="M592 624 L572 730 M688 624 L708 730 M640 624 V730" stroke="${C.plumDeep}" stroke-width="8"/>`
  );
};

const studioWindow: Scene = () =>
  sparkles(42, 5) +
  floor(700, 0.12) +
  `<path d="M420 700 V300 A220 220 0 0 1 860 300 V700Z" fill="${C.cream}"/>` +
  `<path d="M450 700 V306 A190 190 0 0 1 830 306 V700Z" fill="${C.tealSoft}"/>` +
  `<path d="M640 120 V700 M450 420 H830" stroke="${C.cream}" stroke-width="14"/>` +
  `<path d="M450 700 L330 853 H1000 L830 700Z" fill="${C.white}" fill-opacity="0.16"/>` +
  `<circle cx="720" cy="240" r="40" fill="${C.gold}" fill-opacity="0.8"/>` +
  shadow(1010, 760, 90, 14) +
  `<path d="M950 660 H1070 L1050 760 H970Z" fill="${C.coral}"/>` +
  leaf(990, 600, 110, -60) +
  leaf(1040, 590, 120, -110) +
  leaf(1010, 560, 120, -85, "#2F7A5C") +
  leaf(960, 630, 80, -30);

const studioCyclorama: Scene = () =>
  sparkles(43, 6) +
  `<path d="M140 120 H1140 V600 Q1140 760 980 760 H300 Q140 760 140 600Z" fill="${C.white}" fill-opacity="0.92"/>` +
  `<path d="M140 600 Q140 760 300 760 H980 Q1140 760 1140 600 V680 Q1140 800 1000 800 H280 Q140 800 140 680Z" fill="${C.lilac}"/>` +
  `<path d="M300 0 L520 600 H760 L980 0Z" fill="${C.gold}" fill-opacity="0.18"/>` +
  shadow(640, 700, 120, 16, 0.16) +
  `<rect x="560" y="560" width="160" height="30" rx="10" fill="${C.plum}"/>` +
  `<rect x="580" y="470" width="120" height="100" rx="18" fill="${C.plum}"/>` +
  `<path d="M576 590 L560 700 M704 590 L720 700" stroke="${C.plumDeep}" stroke-width="10"/>` +
  flower(860, 650, 34, C.coral) +
  flower(900, 690, 26, C.peach, C.coralDeep) +
  leaf(820, 690, 60, 30);

// Цветы: букет; ваза с тюльпанами; венок
const flowersBouquet: Scene = () => {
  const heads = [
    [560, 300, 50, C.coral],
    [650, 260, 56, C.peach],
    [740, 300, 48, C.berry],
    [600, 380, 46, C.cream],
    [700, 380, 50, C.coral],
    [520, 390, 36, C.peach],
    [780, 390, 38, C.cream],
  ] as const;
  return (
    sparkles(51) +
    shadow(640, 760, 140, 18) +
    leaf(500, 320, 120, -40) +
    leaf(790, 320, 120, 40) +
    leaf(560, 230, 100, -70) +
    leaf(730, 230, 100, 70) +
    heads
      .map(([x, y, r, color], i) =>
        i % 2 ? rose(x, y, r, color, C.coralDeep) : flower(x, y, r, color, C.gold),
      )
      .join("") +
    `<path d="M520 420 L640 760 L760 420 Q640 470 520 420Z" fill="${C.lilac}"/>` +
    `<path d="M560 430 L640 760 L600 430Z" fill="${C.white}" fill-opacity="0.6"/>` +
    bow(640, 560, 0.7, C.coral)
  );
};

const flowersTulips: Scene = () => {
  const tulip = (x: number, top: number, color: string, tilt: number) =>
    `<path d="M640 560 Q${(640 + x) / 2 + tilt} ${(560 + top) / 2} ${x} ${top + 40}" fill="none" stroke="${C.leaf}" stroke-width="8"/>` +
    `<path d="M${x - 34} ${top} Q${x - 40} ${top + 60} ${x} ${top + 66} Q${x + 40} ${top + 60} ${x + 34} ${top} L${x + 16} ${top + 20} L${x} ${top - 6} L${x - 16} ${top + 20}Z" fill="${color}"/>`;
  return (
    sparkles(52) +
    floor(730, 0.1) +
    tulip(470, 240, C.coral, -20) +
    tulip(560, 180, C.berry, -10) +
    tulip(650, 150, C.coral, 0) +
    tulip(740, 190, C.peach, 10) +
    tulip(820, 250, C.berry, 20) +
    leaf(560, 470, 140, -60) +
    leaf(720, 470, 140, 60) +
    shadow(640, 740, 150, 18) +
    `<path d="M540 540 H740 Q760 640 720 740 H560 Q520 640 540 540Z" fill="${C.teal}"/>` +
    `<path d="M560 590 H720" stroke="${C.gold}" stroke-width="8"/>` +
    `<g stroke="${C.gold}" stroke-width="3" fill="none">${star(640, 660, 30, 0)}</g>`
  );
};

const flowersWreath: Scene = () => {
  const out: string[] = [];
  for (let i = 0; i < 18; i++) {
    const a = (i * 2 * Math.PI) / 18;
    const x = f(640 + Math.cos(a) * 230);
    const y = f(430 + Math.sin(a) * 230);
    out.push(
      leaf(f(x + Math.cos(a + 0.6) * 30), f(y + Math.sin(a + 0.6) * 30), 70, f((a * 180) / Math.PI + 60)),
    );
    out.push(
      i % 3 === 0
        ? rose(x, y, 40, C.coral, C.coralDeep)
        : flower(x, y, i % 3 === 1 ? 34 : 28, i % 3 === 1 ? C.peach : C.cream, C.gold),
    );
  }
  return (
    sparkles(53) +
    `<circle cx="640" cy="430" r="180" fill="${C.white}" fill-opacity="0.08"/>` +
    out.join("") +
    `<g stroke="${C.gold}" stroke-width="4" fill="none">${star(640, 430, 80, 11)}</g>`
  );
};

// Торты: ярусный торт; капкейки; кэнди-бар
const cakeTiered: Scene = () => {
  const tier = (y: number, w: number, h: number, color: string) =>
    `<rect x="${640 - w / 2}" y="${y}" width="${w}" height="${h}" rx="14" fill="${color}"/>` +
    `<path d="M${640 - w / 2} ${y + 18} ${Array.from({ length: Math.round(w / 40) }, (_, i) => `q20 ${i % 2 ? 28 : 18} 40 0`).join(" ")}" fill="none" stroke="${C.white}" stroke-width="10" stroke-linecap="round"/>`;
  return (
    sparkles(61) +
    shadow(640, 760, 260, 20) +
    `<rect x="380" y="720" width="520" height="24" rx="12" fill="${C.gold}"/>` +
    `<path d="M600 744 L560 790 H720 L680 744Z" fill="${C.goldDeep}"/>` +
    tier(560, 440, 160, C.cream) +
    tier(420, 320, 140, C.peach) +
    tier(300, 200, 120, C.cream) +
    flower(560, 560, 22, C.coral) +
    flower(720, 420, 20, C.berry, C.gold) +
    flower(600, 300, 18, C.coral) +
    leaf(590, 578, 30, -30) +
    `<path d="M640 290 C 590 250 590 210 620 210 C 636 210 640 224 640 224 C 640 224 644 210 660 210 C 690 210 690 250 640 290Z" fill="${C.coral}"/>`
  );
};

const cakeCupcakes: Scene = () => {
  const cup = (x: number, cream: string, cherry: boolean) =>
    shadow(x, 700, 90, 12) +
    `<path d="M${x - 80} 540 H${x + 80} L${x + 60} 690 H${x - 60}Z" fill="${C.coral}"/>` +
    `<path d="M${x - 50} 540 L${x - 40} 690 M${x} 540 V690 M${x + 50} 540 L${x + 40} 690" stroke="${C.coralDeep}" stroke-width="6"/>` +
    `<path d="M${x - 92} 548 Q${x - 100} 480 ${x - 40} 470 Q${x - 40} 400 ${x + 10} 410 Q${x + 70} 400 ${x + 60} 470 Q${x + 100} 480 ${x + 92} 548Z" fill="${cream}"/>` +
    `<path d="M${x - 60} 500 Q${x} 470 ${x + 60} 500" fill="none" stroke="${C.white}" stroke-width="8" stroke-linecap="round" stroke-opacity="0.7"/>` +
    (cherry
      ? `<circle cx="${x + 10}" cy="392" r="22" fill="${C.berry}"/><path d="M${x + 10} 372 q10 -30 34 -36" stroke="${C.leaf}" stroke-width="5" fill="none"/>`
      : sparkle(x + 10, 392, 22, C.gold, 1));
  return (
    sparkles(62) +
    floor(700, 0.1) +
    cup(380, C.cream, true) +
    cup(640, C.peach, false) +
    cup(900, C.lilac, true)
  );
};

const cakeCandyBar: Scene = () => {
  const jar = (x: number, h: number, fill: string) =>
    `<rect x="${x - 60}" y="${560 - h}" width="120" height="${h}" rx="22" fill="${C.white}" fill-opacity="0.85"/>` +
    `<rect x="${x - 48}" y="${600 - h}" width="96" height="${h - 50}" rx="16" fill="${fill}"/>` +
    `<rect x="${x - 66}" y="${548 - h}" width="132" height="24" rx="10" fill="${C.gold}"/>`;
  const macaron = (x: number, y: number, color: string) =>
    `<ellipse cx="${x}" cy="${y}" rx="34" ry="16" fill="${color}"/><rect x="${x - 30}" y="${y - 4}" width="60" height="8" fill="${C.cream}"/><ellipse cx="${x}" cy="${y - 14}" rx="34" ry="14" fill="${color}"/>`;
  return (
    sparkles(63) +
    `<rect x="160" y="560" width="960" height="40" rx="10" fill="${C.cream}"/>` +
    `<path d="M180 600 H1100 V740 Q1060 700 1020 740 Q980 700 940 740 Q900 700 860 740 Q820 700 780 740 Q740 700 700 740 Q660 700 620 740 Q580 700 540 740 Q500 700 460 740 Q420 700 380 740 Q340 700 300 740 Q260 700 220 740 Q200 720 180 740Z" fill="${C.peach}"/>` +
    jar(320, 200, C.coral) +
    jar(500, 260, C.berry) +
    jar(780, 230, C.teal) +
    `<rect x="890" y="470" width="180" height="16" rx="8" fill="${C.gold}"/><rect x="972" y="486" width="16" height="74" fill="${C.goldDeep}"/>` +
    macaron(930, 450, C.coral) +
    macaron(1010, 450, C.lilac) +
    macaron(970, 418, C.peach) +
    macaron(640, 540, C.lilac)
  );
};

// Подарки: коробка с бантом; стопка; бонбоньерки
function giftBox(x: number, y: number, w: number, h: number, box: string, ribbon: string): string {
  return (
    shadow(x, y + h + 10, w * 0.62, 16) +
    `<rect x="${x - w / 2}" y="${y}" width="${w}" height="${h}" rx="12" fill="${box}"/>` +
    `<rect x="${x - w / 2 - 14}" y="${y - 50}" width="${w + 28}" height="64" rx="12" fill="${box}"/>` +
    `<rect x="${x - w / 2 - 14}" y="${y + 6}" width="${w + 28}" height="10" fill="#000" fill-opacity="0.12"/>` +
    `<rect x="${x - 20}" y="${y - 50}" width="40" height="${h + 50}" fill="${ribbon}"/>` +
    bow(x, y - 56, w / 340, ribbon)
  );
}

const giftsBox: Scene = () =>
  sparkles(71, 12) +
  giftBox(640, 420, 380, 290, C.berry, C.gold) +
  `<g stroke="${C.gold}" stroke-opacity="0.6" stroke-width="3" fill="none">${star(520, 560, 40, 0)}${star(760, 560, 40, 0)}</g>`;

const giftsStack: Scene = () =>
  sparkles(72, 10) +
  giftBox(560, 520, 420, 200, C.teal, C.coral) +
  giftBox(600, 380, 280, 130, C.cream, C.berry) +
  giftBox(900, 600, 200, 130, C.coral, C.cream);

const giftsBonbonniere: Scene = () => {
  const small = (x: number, color: string) =>
    shadow(x, 670, 80, 10) +
    `<path d="M${x - 70} 560 H${x + 70} L${x + 56} 660 H${x - 56}Z" fill="${color}"/>` +
    `<path d="M${x - 70} 560 Q${x} 500 ${x + 70} 560Z" fill="${color}" fill-opacity="0.75"/>` +
    bow(x, 540, 0.35, C.gold) +
    `<path d="M${x + 30} 600 l40 20 l-6 34 l-34 -10z" fill="${C.cream}"/>` +
    `<path d="M${x + 48} 628 c-8 -6 -8 -14 -2 -14 c3 0 4 3 4 3 c0 0 1 -3 4 -3 c6 0 6 8 -6 14z" fill="${C.coral}"/>`;
  return (
    sparkles(73) +
    floor(660, 0.1) +
    small(250, C.lilac) +
    small(450, C.peach) +
    small(650, C.cream) +
    small(850, C.lilac) +
    small(1050, C.peach)
  );
};

// Декор: арка с драпировкой; стол со свечами; фонарики и гирлянда
const decorArch: Scene = () => {
  const lantern = (x: number, y: number) =>
    `<line x1="${x}" y1="${y - 80}" x2="${x}" y2="${y - 30}" stroke="${C.gold}" stroke-width="3"/>` +
    `<path d="M${x - 20} ${y - 30} H${x + 20} L${x + 26} ${y + 30} H${x - 26}Z" fill="${C.gold}" fill-opacity="0.9"/>` +
    `<rect x="${x - 10}" y="${y - 16}" width="20" height="34" rx="6" fill="${C.cream}"/>`;
  return (
    sparkles(81, 10) +
    floor(700) +
    `<path d="M380 700 V380 A260 260 0 0 1 900 380 V700" fill="none" stroke="${C.cream}" stroke-width="30"/>` +
    `<path d="M380 380 Q500 520 640 360 Q780 520 900 380" fill="none" stroke="${C.lilac}" stroke-width="40" stroke-opacity="0.8"/>` +
    Array.from({ length: 11 }, (_, i) => {
      const a = Math.PI + (i * Math.PI) / 10;
      const x = f(640 + Math.cos(a) * 260);
      const y = f(380 + Math.sin(a) * 260);
      return i % 2 ? flower(x, y, 30, C.coral) : rose(x, y, 30, C.peach, C.coralDeep);
    }).join("") +
    lantern(500, 520) +
    lantern(780, 520) +
    flower(380, 690, 40, C.coral) +
    flower(900, 690, 40, C.coral) +
    leaf(330, 690, 60, -20) +
    leaf(950, 690, 60, 20)
  );
};

const decorCandles: Scene = () => {
  const candle = (x: number, h: number) =>
    `<rect x="${x - 14}" y="${600 - h}" width="28" height="${h}" rx="6" fill="${C.cream}"/>` +
    `<path d="M${x} ${560 - h} Q${x + 16} ${582 - h} ${x} ${594 - h} Q${x - 16} ${582 - h} ${x} ${560 - h}Z" fill="${C.gold}"/>` +
    `<circle cx="${x}" cy="${580 - h}" r="40" fill="${C.gold}" fill-opacity="0.15"/>`;
  return (
    sparkles(82, 12) +
    `<rect x="0" y="600" width="${W}" height="${H - 600}" fill="${C.cream}" fill-opacity="0.9"/>` +
    `<rect x="0" y="600" width="${W}" height="24" fill="${C.white}"/>` +
    `<path d="M560 600 Q640 520 720 600" fill="${C.goldDeep}"/>` +
    `<rect x="630" y="420" width="20" height="180" fill="${C.gold}"/>` +
    `<path d="M500 420 Q500 470 640 470 Q780 470 780 420" fill="none" stroke="${C.gold}" stroke-width="16"/>` +
    candle(500, 140) +
    candle(640, 200) +
    candle(780, 140) +
    flower(330, 600, 40, C.coral) +
    flower(390, 620, 30, C.peach, C.coralDeep) +
    leaf(290, 620, 70, -20) +
    flower(950, 600, 40, C.berry) +
    flower(890, 620, 30, C.peach, C.coralDeep) +
    leaf(1000, 620, 70, 20)
  );
};

const decorLanterns: Scene = () => {
  const bulbs = Array.from({ length: 16 }, (_, i) => {
    const x = 60 + i * 76;
    const y = f(140 + Math.sin((i / 15) * Math.PI) * 80);
    return `<circle cx="${x}" cy="${y + 10}" r="10" fill="${C.gold}"/><circle cx="${x}" cy="${y + 10}" r="22" fill="${C.gold}" fill-opacity="0.18"/>`;
  }).join("");
  const lantern = (x: number, y: number, s: number, color: string) =>
    `<line x1="${x}" y1="0" x2="${x}" y2="${y - 90 * s}" stroke="${C.gold}" stroke-width="3"/>` +
    `<path d="M${x - 20 * s} ${y - 90 * s} H${x + 20 * s} L${x + 60 * s} ${y - 30 * s} Q${x + 70 * s} ${y + 40 * s} ${x + 20 * s} ${y + 80 * s} H${x - 20 * s} Q${x - 70 * s} ${y + 40 * s} ${x - 60 * s} ${y - 30 * s}Z" fill="${color}"/>` +
    `<g stroke="${C.gold}" stroke-width="${3 * s}" fill="none">${star(x, y + 10 * s, 26 * s, 0)}</g>` +
    `<path d="M${x - 12 * s} ${y + 80 * s} L${x} ${y + 110 * s} L${x + 12 * s} ${y + 80 * s}Z" fill="${C.gold}"/>`;
  return (
    `<path d="M60 150 Q640 330 1200 150" fill="none" stroke="${C.cream}" stroke-width="3" stroke-opacity="0.6"/>` +
    bulbs +
    lantern(360, 480, 1.1, C.coral) +
    lantern(640, 420, 1.4, C.teal) +
    lantern(920, 500, 1.0, C.berry) +
    sparkles(83, 8)
  );
};

// Кейтеринг: казан плова; ляган с лепёшками; фуршет
function plovDome(cx: number, cy: number, rx: number, ry: number): string {
  const rnd = random(cx + cy);
  const bits = Array.from({ length: 34 }, () => {
    const a = rnd() * Math.PI;
    const r = Math.sqrt(rnd());
    const x = f(cx + Math.cos(a) * rx * r * 0.9);
    const y = f(cy - Math.sin(a) * ry * r * 0.85);
    return rnd() > 0.55
      ? `<rect x="${x}" y="${y}" width="16" height="6" rx="3" fill="${C.coral}" transform="rotate(${f(rnd() * 180)} ${x} ${y})"/>`
      : `<circle cx="${x}" cy="${y}" r="4" fill="${C.cream}"/>`;
  }).join("");
  return `<path d="M${cx - rx} ${cy} Q${cx} ${cy - ry * 2} ${cx + rx} ${cy}Z" fill="#F2C46A"/>${bits}`;
}

const steam = (x: number) =>
  `<path d="M${x} 300 q-30 -40 0 -80 q30 -40 0 -80" fill="none" stroke="${C.white}" stroke-width="10" stroke-linecap="round" stroke-opacity="0.45"/>`;

const foodKazan: Scene = () =>
  sparkles(91, 6) +
  floor(700, 0.1) +
  steam(560) +
  steam(660) +
  steam(760) +
  shadow(640, 740, 320, 24) +
  `<path d="M300 420 H980 Q960 700 640 720 Q320 700 300 420Z" fill="${C.plumDeep}"/>` +
  `<path d="M260 420 H340 V450 H260Z M940 420 H1020 V450 H940Z" fill="${C.plumDeep}"/>` +
  `<ellipse cx="640" cy="420" rx="350" ry="56" fill="${C.plum}"/>` +
  `<ellipse cx="640" cy="420" rx="320" ry="44" fill="#E9B85C"/>` +
  plovDome(640, 430, 300, 70) +
  `<circle cx="640" cy="360" r="26" fill="${C.cream}"/><path d="M628 348 Q640 330 652 348" stroke="${C.peach}" stroke-width="4" fill="none"/>` +
  `<path d="M330 520 Q640 590 950 520" fill="none" stroke="${C.gold}" stroke-width="6" stroke-opacity="0.6"/>`;

const foodLagan: Scene = () => {
  const nan = (x: number, y: number) =>
    `<circle cx="${x}" cy="${y}" r="90" fill="#E3A954"/><circle cx="${x}" cy="${y}" r="56" fill="#F2C46A"/>` +
    Array.from(
      { length: 8 },
      (_, i) =>
        `<circle cx="${f(x + Math.cos(i * 0.785) * 30)}" cy="${f(y + Math.sin(i * 0.785) * 30)}" r="4" fill="${C.goldDeep}"/>`,
    ).join("");
  return (
    sparkles(92, 6) +
    `<rect x="0" y="520" width="${W}" height="${H - 520}" fill="${C.cream}" fill-opacity="0.85"/>` +
    shadow(640, 700, 330, 40, 0.16) +
    `<ellipse cx="640" cy="660" rx="330" ry="110" fill="${C.teal}"/>` +
    `<ellipse cx="640" cy="652" rx="290" ry="92" fill="${C.tealSoft}"/>` +
    // Звезда на дне лягана — сплюснута, как сам ляган в перспективе
    `<g transform="translate(640 652) scale(1 0.4) translate(-640 -652)" stroke="${C.teal}" stroke-width="5" fill="none">${star(640, 652, 210, 0)}</g>` +
    plovDome(640, 680, 220, 90) +
    nan(200, 640) +
    nan(1080, 640) +
    `<path d="M1000 470 H1120 Q1130 560 1060 570 Q990 560 1000 470Z" fill="${C.white}"/>` +
    `<path d="M1120 490 Q1170 490 1160 530" fill="none" stroke="${C.white}" stroke-width="10"/>`
  );
};

const foodBuffet: Scene = () => {
  const cloche = (x: number) =>
    `<ellipse cx="${x}" cy="560" rx="110" ry="16" fill="${C.goldDeep}"/>` +
    `<path d="M${x - 96} 556 Q${x - 96} 430 ${x} 430 Q${x + 96} 430 ${x + 96} 556Z" fill="${C.gold}"/>` +
    `<circle cx="${x}" cy="420" r="14" fill="${C.goldDeep}"/>` +
    `<path d="M${x - 60} 520 Q${x - 60} 470 ${x - 20} 462" stroke="${C.white}" stroke-width="8" fill="none" stroke-opacity="0.6" stroke-linecap="round"/>`;
  return (
    sparkles(93) +
    `<rect x="120" y="570" width="1040" height="40" rx="10" fill="${C.cream}"/>` +
    `<rect x="140" y="610" width="1000" height="160" fill="${C.white}" fill-opacity="0.9"/>` +
    `<path d="M140 610 H1140 V640 Q640 700 140 640Z" fill="${C.peach}"/>` +
    cloche(320) +
    cloche(640) +
    cloche(960) +
    flower(480, 556, 24, C.coral) +
    flower(800, 556, 24, C.coral) +
    leaf(510, 566, 40, 20) +
    leaf(830, 566, 40, 20)
  );
};

// Ресторан: стол с лампами; чайный набор; терраса с арками
const restaurantTable: Scene = () => {
  const pendant = (x: number, len: number) =>
    `<line x1="${x}" y1="0" x2="${x}" y2="${len}" stroke="${C.cream}" stroke-width="3"/>` +
    `<path d="M${x - 60} ${len + 60} Q${x - 50} ${len} ${x} ${len} Q${x + 50} ${len} ${x + 60} ${len + 60}Z" fill="${C.coral}"/>` +
    `<path d="M${x - 120} ${len + 260} L${x - 60} ${len + 60} H${x + 60} L${x + 120} ${len + 260}Z" fill="${C.gold}" fill-opacity="0.12"/>`;
  const chair = (x: number) =>
    `<rect x="${x - 50}" y="440" width="100" height="160" rx="30" fill="${C.plumMid}"/><path d="M${x - 40} 600 V720 M${x + 40} 600 V720" stroke="${C.plumDeep}" stroke-width="10"/>`;
  return (
    sparkles(101, 6) +
    floor(700, 0.08) +
    pendant(460, 160) +
    pendant(820, 200) +
    chair(380) +
    chair(900) +
    shadow(640, 740, 300, 20) +
    `<ellipse cx="640" cy="560" rx="300" ry="60" fill="${C.white}"/>` +
    `<path d="M340 560 Q640 640 940 560 L920 700 Q640 760 360 700Z" fill="${C.cream}"/>` +
    `<ellipse cx="530" cy="560" rx="60" ry="18" fill="${C.lilac}"/><ellipse cx="750" cy="560" rx="60" ry="18" fill="${C.lilac}"/>` +
    flower(640, 530, 24, C.coral) +
    leaf(670, 540, 36, 20)
  );
};

const restaurantTea: Scene = () => {
  const piala = (x: number, y: number) =>
    shadow(x, y + 50, 70, 10, 0.15) +
    `<path d="M${x - 70} ${y} H${x + 70} Q${x + 60} ${y + 60} ${x} ${y + 60} Q${x - 60} ${y + 60} ${x - 70} ${y}Z" fill="${C.white}"/>` +
    `<path d="M${x - 64} ${y + 14} H${x + 64}" stroke="${C.teal}" stroke-width="10"/>` +
    `<ellipse cx="${x}" cy="${y}" rx="70" ry="14" fill="#C9792F"/>`;
  return (
    sparkles(102, 8) +
    `<rect x="0" y="560" width="${W}" height="${H - 560}" fill="${C.cream}" fill-opacity="0.9"/>` +
    shadow(560, 640, 170, 20) +
    `<path d="M420 400 Q400 640 560 640 Q720 640 700 400Z" fill="${C.white}"/>` +
    `<path d="M430 470 H690" stroke="${C.teal}" stroke-width="22"/>` +
    `<g stroke="${C.teal}" stroke-width="4" fill="none">${star(560, 560, 40, 0)}</g>` +
    `<path d="M700 450 Q800 430 820 360" fill="none" stroke="${C.white}" stroke-width="22" stroke-linecap="round"/>` +
    `<path d="M420 440 Q360 440 370 520 Q380 580 430 560" fill="none" stroke="${C.white}" stroke-width="16"/>` +
    `<ellipse cx="560" cy="400" rx="140" ry="24" fill="${C.white}"/>` +
    `<ellipse cx="560" cy="380" rx="60" ry="20" fill="${C.teal}"/><circle cx="560" cy="358" r="14" fill="${C.teal}"/>` +
    piala(900, 600) +
    piala(1080, 650) +
    `<ellipse cx="230" cy="660" rx="120" ry="30" fill="${C.teal}"/>` +
    Array.from(
      { length: 9 },
      (_, i) =>
        `<circle cx="${180 + (i % 5) * 26}" cy="${630 - Math.floor(i / 5) * 22}" r="14" fill="${i % 2 ? C.gold : C.coral}"/>`,
    ).join("")
  );
};

const restaurantTerrace: Scene = () => {
  const arch = (x: number) =>
    `<path d="M${x - 110} 640 V340 A110 110 0 0 1 ${x + 110} 340 V640Z" fill="${C.tealSoft}" fill-opacity="0.85"/>` +
    `<path d="M${x - 110} 640 V340 A110 110 0 0 1 ${x + 110} 340 V640" fill="none" stroke="${C.cream}" stroke-width="16"/>` +
    leaf(x - 40, 280, 70, -60) +
    leaf(x + 30, 290, 80, 50) +
    flower(x, 260, 18, C.coral);
  return (
    sparkles(103, 6) +
    `<rect x="0" y="640" width="${W}" height="${H - 640}" fill="${C.cream}" fill-opacity="0.85"/>` +
    arch(300) +
    arch(640) +
    arch(980) +
    `<circle cx="640" cy="420" r="40" fill="${C.gold}" fill-opacity="0.85"/>` +
    shadow(640, 760, 200, 14) +
    `<rect x="470" y="660" width="340" height="24" rx="10" fill="${C.plumMid}"/><path d="M500 684 V760 M780 684 V760" stroke="${C.plumDeep}" stroke-width="12"/>` +
    flower(600, 650, 20, C.coral) +
    flower(680, 650, 20, C.peach, C.coralDeep)
  );
};

// Наряды: платье; костюм; тюбетейка на атласе
const hanger = (x: number, y: number) =>
  `<path d="M${x} ${y - 70} q0 -24 20 -24 q20 0 20 20 q0 18 -24 26 L${x} ${y - 40} L${x - 120} ${y + 10} H${x + 120}Z" fill="none" stroke="${C.gold}" stroke-width="8" stroke-linejoin="round"/>`;

const attireDress: Scene = () =>
  sparkles(111, 12) +
  floor(740, 0.1) +
  hanger(640, 210) +
  shadow(640, 760, 280, 20) +
  `<path d="M570 220 Q600 200 640 230 Q680 200 710 220 L700 360 Q640 380 580 360Z" fill="${C.white}"/>` +
  `<path d="M580 360 Q640 380 700 360 L900 750 Q640 800 380 750Z" fill="${C.cream}"/>` +
  `<path d="M640 380 Q620 560 520 760 M640 380 Q660 560 760 760 M640 380 V770" fill="none" stroke="${C.peach}" stroke-width="5"/>` +
  `<rect x="576" y="346" width="128" height="22" rx="10" fill="${C.gold}"/>` +
  flower(640, 357, 16, C.coral) +
  sparkle(520, 600, 10, C.gold, 0.9) +
  sparkle(760, 520, 8, C.gold, 0.9) +
  sparkle(680, 680, 9, C.gold, 0.9);

const attireSuit: Scene = () =>
  sparkles(112, 10) +
  floor(740, 0.1) +
  hanger(640, 210) +
  shadow(640, 760, 200, 18) +
  `<path d="M520 230 Q640 200 760 230 L800 740 H480Z" fill="${C.plumDeep}"/>` +
  `<path d="M600 222 L640 420 L680 222Z" fill="${C.white}"/>` +
  `<path d="M560 230 L640 470 L600 230Z M720 230 L640 470 L680 230Z" fill="${C.plum}"/>` +
  `<path d="M612 250 L640 266 L668 250 L668 282 L640 266 L612 282Z" fill="${C.coral}"/>` +
  `<circle cx="640" cy="520" r="10" fill="${C.gold}"/><circle cx="640" cy="580" r="10" fill="${C.gold}"/>` +
  `<path d="M720 330 L770 320 L766 350 Z" fill="${C.coral}"/>` +
  `<path d="M480 740 V760 M800 740 V760" stroke="${C.plumDeep}" stroke-width="8"/>`;

const attireDoppi: Scene = () => {
  // Атлас — зигзаги икат
  const stripes = Array.from({ length: 8 }, (_, i) => {
    const y = 470 + i * 50;
    const color = [C.coral, C.gold, C.teal, C.berry][i % 4];
    return `<path d="M0 ${y} ${Array.from({ length: 17 }, (_, k) => `L${k * 80 + 40} ${y + (k % 2 ? -18 : 18)}`).join(" ")} L${W} ${y} V${y + 30} H0Z" fill="${color}" fill-opacity="0.9"/>`;
  }).join("");
  return (
    sparkles(113, 8) +
    stripes +
    shadow(640, 520, 230, 24, 0.3) +
    `<path d="M420 500 V380 Q420 300 640 290 Q860 300 860 380 V500 Q640 540 420 500Z" fill="${C.plumDeep}"/>` +
    `<path d="M420 380 Q640 420 860 380" fill="none" stroke="${C.white}" stroke-width="6"/>` +
    [500, 580, 660, 740]
      .map(
        (x) =>
          `<path d="M${x} 420 q20 -60 40 0 q-20 30 -40 0z" fill="${C.white}"/><path d="M${x + 20} 400 v24" stroke="${C.plumDeep}" stroke-width="4"/>`,
      )
      .join("") +
    `<path d="M480 360 Q640 320 800 360" fill="none" stroke="${C.white}" stroke-width="4" stroke-dasharray="14 10"/>`
  );
};

// ЗАГС: кольца; арка церемонии со стульями; свидетельство с печатью
const zagsRings: Scene = () =>
  sparkles(121, 14) +
  `<circle cx="640" cy="440" r="250" fill="${C.white}" fill-opacity="0.07"/>` +
  shadow(640, 700, 260, 22) +
  `<circle cx="540" cy="460" r="150" fill="none" stroke="${C.gold}" stroke-width="40"/>` +
  `<circle cx="540" cy="460" r="150" fill="none" stroke="#FFE3A3" stroke-width="10" stroke-dasharray="120 820"/>` +
  `<circle cx="740" cy="460" r="150" fill="none" stroke="${C.cream}" stroke-width="40"/>` +
  `<circle cx="740" cy="460" r="150" fill="none" stroke="${C.white}" stroke-width="10" stroke-dasharray="100 840"/>` +
  `<path d="M650 340 A150 150 0 0 1 680 600" fill="none" stroke="${C.gold}" stroke-width="40"/>` +
  `<path d="M710 290 L740 250 L770 290 L740 330Z" fill="${C.tealSoft}"/>` +
  sparkle(800, 250, 24, C.white, 1) +
  sparkle(470, 280, 14, C.gold, 1);

const zagsCeremony: Scene = () => {
  const chair = (x: number, y: number, s: number) =>
    `<rect x="${x - 26 * s}" y="${y - 70 * s}" width="${52 * s}" height="${60 * s}" rx="${10 * s}" fill="${C.cream}"/>` +
    `<rect x="${x - 30 * s}" y="${y - 14 * s}" width="${60 * s}" height="${14 * s}" rx="${5 * s}" fill="${C.white}"/>` +
    `<path d="M${x - 24 * s} ${y} V${y + 40 * s} M${x + 24 * s} ${y} V${y + 40 * s}" stroke="${C.gold}" stroke-width="${5 * s}"/>`;
  const rows: string[] = [];
  for (let r = 0; r < 3; r++) {
    const y = 590 + r * 80;
    const s = 0.8 + r * 0.25;
    for (const dx of [140, 240, 340]) {
      rows.push(chair(640 - dx * s * 0.9, y, s));
      rows.push(chair(640 + dx * s * 0.9, y, s));
    }
  }
  return (
    sparkles(122, 10) +
    floor(560, 0.1) +
    `<path d="M600 560 L520 853 H760 L680 560Z" fill="${C.peach}" fill-opacity="0.8"/>` +
    `<path d="M520 560 V330 A120 120 0 0 1 760 330 V560" fill="none" stroke="${C.cream}" stroke-width="20"/>` +
    Array.from({ length: 9 }, (_, i) => {
      const a = Math.PI + (i * Math.PI) / 8;
      return flower(
        f(640 + Math.cos(a) * 120),
        f(330 + Math.sin(a) * 120),
        18,
        i % 2 ? C.coral : C.peach,
        C.gold,
      );
    }).join("") +
    flower(520, 560, 26, C.coral) +
    flower(760, 560, 26, C.coral) +
    rows.join("")
  );
};

const zagsCertificate: Scene = () =>
  sparkles(123, 10) +
  `<g transform="rotate(-6 640 430)">` +
  shadow(650, 700, 300, 20, 0.2) +
  `<rect x="360" y="170" width="560" height="520" rx="16" fill="${C.cream}"/>` +
  `<rect x="390" y="200" width="500" height="460" rx="10" fill="none" stroke="${C.gold}" stroke-width="6"/>` +
  `<g stroke="${C.gold}" stroke-width="3" fill="none">${star(640, 290, 46, 0)}</g>` +
  [380, 420, 460, 500, 540]
    .map(
      (y, i) =>
        `<rect x="${450 + (i % 2) * 30}" y="${y}" width="${380 - (i % 2) * 60}" height="12" rx="6" fill="${C.plumMid}" fill-opacity="0.35"/>`,
    )
    .join("") +
  `<circle cx="790" cy="600" r="54" fill="${C.berry}"/>` +
  `<g stroke="${C.cream}" stroke-width="3" fill="none">${star(790, 600, 32, 0)}</g>` +
  `</g>` +
  `<path d="M880 720 L1080 470 L1110 490 L910 740Z" fill="${C.plumDeep}"/>` +
  `<path d="M880 720 L870 760 L905 738Z" fill="${C.gold}"/>`;

const SCENES: Readonly<Record<string, readonly [Scene, Scene, Scene]>> = {
  hall: [hallBanquet, hallStage, hallTable],
  car: [carBride, carMotorcade, carRetro],
  photo: [photoCamera, photoDrone, photoPrints],
  studio: [studioSoftbox, studioWindow, studioCyclorama],
  flowers: [flowersBouquet, flowersTulips, flowersWreath],
  cake: [cakeTiered, cakeCupcakes, cakeCandyBar],
  gifts: [giftsBox, giftsStack, giftsBonbonniere],
  decor: [decorArch, decorCandles, decorLanterns],
  food: [foodKazan, foodLagan, foodBuffet],
  restaurant: [restaurantTable, restaurantTea, restaurantTerrace],
  attire: [attireDress, attireSuit, attireDoppi],
  zags: [zagsRings, zagsCeremony, zagsCertificate],
};

/** Категории, для которых есть сюжеты (сверяет тест с включёнными) */
export const DEMO_PHOTO_CATEGORIES: readonly string[] = Object.keys(SCENES);

// Буквы DEMO линиями в клетке 5×7
const LETTERS = [
  "M0 0 H2.6 Q5 0 5 2.4 V4.6 Q5 7 2.6 7 H0 Z",
  "M5 0 H0 V7 H5 M0 3.5 H3.8",
  "M0 7 V0 L2.5 3.6 L5 0 V7",
  "M2.5 0 Q5 0 5 2.4 V4.6 Q5 7 2.5 7 Q0 7 0 4.6 V2.4 Q0 0 2.5 0 Z",
];

/** Плашка DEMO в левом верхнем углу: фото демо-витрины не спутать с настоящим */
function demoBadge(): string {
  const unit = 6;
  const gap = 2;
  const wordWidth = (LETTERS.length * 5 + (LETTERS.length - 1) * gap) * unit;
  const left = 56;
  const top = 52;
  const letters = LETTERS.map(
    (d, i) => `<path transform="translate(${left + i * (5 + gap) * unit} ${top}) scale(${unit})" d="${d}"/>`,
  );
  return (
    `<rect x="${left - 22}" y="${top - 18}" width="${wordWidth + 44}" height="${7 * unit + 36}" rx="16" fill="#000" fill-opacity="0.35"/>` +
    `<g fill="none" stroke="#fff" stroke-width="${f(3 / unit)}" stroke-linecap="round" stroke-linejoin="round">${letters.join("")}</g>`
  );
}

/** Какая витрина и какой её сюжет у картинки номер index */
function photoOf(index: number): { category: string; scene: number; venue: number; nth: number } {
  const venue = Math.floor(index / DEMO_PHOTOS_PER_VENUE);
  const category = DEMO_VENUES[venue]?.category ?? "hall";
  // Которая это витрина категории по счёту: вторая — в других цветах и зеркально
  const nth = DEMO_VENUES.slice(0, venue).filter((v) => v.category === category).length;
  return { category, scene: index % DEMO_PHOTOS_PER_VENUE, venue, nth };
}

/** SVG картинки номер index */
export function demoPhotoSvg(index: number): string {
  const { category, scene, venue, nth } = photoOf(index);
  const scenes = SCENES[category] ?? SCENES.hall;
  const draw = scenes?.[(scene + nth) % 3] ?? hallBanquet;
  const [from, to] = BACKGROUNDS[(venue * 2 + scene) % BACKGROUNDS.length] ?? ["#2C1B47", "#ED6545"];
  const mirror = nth % 2 === 1;
  const tile = 120;
  const shift = (index * 17) % tile;
  const tiles: string[] = [];
  for (let y = -tile; y < H + tile; y += tile) {
    for (let x = -tile; x < W + tile; x += tile) tiles.push(star(x + shift, y + shift, 40, 0));
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1" gradientTransform="rotate(${(index * 11) % 60} 0.5 0.5)">
      <stop offset="0" stop-color="${from}"/>
      <stop offset="1" stop-color="${to}"/>
    </linearGradient>
    <radialGradient id="shade" cx="0.5" cy="0.45" r="0.8">
      <stop offset="0.6" stop-color="#000" stop-opacity="0"/>
      <stop offset="1" stop-color="#000" stop-opacity="0.3"/>
    </radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <g fill="none" stroke="#fff" stroke-opacity="0.08" stroke-width="2">${tiles.join("")}</g>
  <g${mirror ? ` transform="translate(${W} 0) scale(-1 1)"` : ""}>${draw()}</g>
  <rect width="${W}" height="${H}" fill="url(#shade)"/>
  ${demoBadge()}
</svg>`;
}

/** WebP картинки номер index — без метаданных */
export async function demoPhoto(index: number): Promise<Buffer> {
  return sharp(Buffer.from(demoPhotoSvg(index)))
    .webp({ quality: QUALITY, effort: 4 })
    .toBuffer();
}

export async function writeDemoPhotos(dir: string): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  const files: string[] = [];
  for (let i = 0; i < DEMO_PHOTO_FILES; i++) {
    const file = join(dir, `demo-${String(i + 1).padStart(2, "0")}.webp`);
    await writeFile(file, await demoPhoto(i));
    files.push(file);
  }
  return files;
}

// Запуск из командной строки: node scripts/demo-photos.ts <папка>
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("Использование: node scripts/demo-photos.ts <папка>");
    process.exit(2);
  }
  const files = await writeDemoPhotos(dir);
  console.log(`демо-фото: ${files.length} файлов в ${dir}`);
}
