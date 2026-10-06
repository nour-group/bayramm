// Фото демо-витрин для workflow «Demo data (staging)»: абстрактные картинки —
// градиент в цветах бренда, узор из восьмиконечных звёзд гириха и слово DEMO.
// Ни людей, ни чужих снимков: всё рисуется здесь же, из SVG.
//
//   node scripts/demo-photos.ts <папка>   → demo-01.webp … demo-30.webp
//
// Порядок файлов — порядок витрин в src/demo/venues.ts, по три на витрину. Буквы — линии,
// а не шрифт: картинка одинакова на любой машине. WebP без метаданных — sharp не пишет
// EXIF, XMP и ICC, пока его об этом не попросить; POST /ops/demo всё равно проверяет
// каждый файл тем же assertUploadable, что и любую загрузку.
//
// Файл — только со стираемым синтаксисом TS: Node запускает его напрямую (снятие типов).

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";

export const DEMO_PHOTO_WIDTH = 1280;
export const DEMO_PHOTO_HEIGHT = 853;
/** По три на каждую из четырнадцати демо-витрин (src/demo/venues.ts: DEMO_PHOTO_COUNT) */
export const DEMO_PHOTO_FILES = 42;
const QUALITY = 70;

// Пары цветов градиента — из палитры бренда (packages/ui/src/tokens.ts)
const PALETTE: readonly (readonly [string, string])[] = [
  ["#2C1B47", "#ED6545"],
  ["#237870", "#4E3170"],
  ["#BB4225", "#F9CDB2"],
  ["#1B1030", "#237870"],
  ["#A82F52", "#ED6545"],
  ["#1E2A4F", "#A3302A"],
  ["#4E3170", "#F1EAF9"],
  ["#237870", "#F9CDB2"],
  ["#2C1B47", "#A82F52"],
];

/** Восьмиконечная звезда гириха (два квадрата): вершины через 22,5°, внутренние — на 0,765 R */
function star(cx: number, cy: number, r: number, turn: number): string {
  const inner = r * (Math.SQRT1_2 / Math.cos(Math.PI / 8));
  const points: string[] = [];
  for (let i = 0; i < 16; i++) {
    const angle = ((turn + i * 22.5) * Math.PI) / 180;
    const radius = i % 2 === 0 ? r : inner;
    points.push(
      `${(cx + radius * Math.cos(angle)).toFixed(1)},${(cy + radius * Math.sin(angle)).toFixed(1)}`,
    );
  }
  return `<polygon points="${points.join(" ")}"/>`;
}

// Буквы DEMO линиями в клетке 5×7
const LETTERS = [
  "M0 0 H2.6 Q5 0 5 2.4 V4.6 Q5 7 2.6 7 H0 Z",
  "M5 0 H0 V7 H5 M0 3.5 H3.8",
  "M0 7 V0 L2.5 3.6 L5 0 V7",
  "M2.5 0 Q5 0 5 2.4 V4.6 Q5 7 2.5 7 Q0 7 0 4.6 V2.4 Q0 0 2.5 0 Z",
];

/** SVG картинки номер index (0…8) */
export function demoPhotoSvg(index: number): string {
  const [from, to] = PALETTE[index % PALETTE.length] ?? ["#2C1B47", "#ED6545"];
  const w = DEMO_PHOTO_WIDTH;
  const h = DEMO_PHOTO_HEIGHT;
  const tile = 120;
  const shift = (index * 17) % tile;

  const tiles: string[] = [];
  for (let y = -tile; y < h + tile; y += tile) {
    for (let x = -tile; x < w + tile; x += tile) tiles.push(star(x + shift, y + shift, 40, 0));
  }

  const unit = 26;
  const gap = 2;
  const wordWidth = (LETTERS.length * 5 + (LETTERS.length - 1) * gap) * unit;
  const left = (w - wordWidth) / 2;
  const top = (h - 7 * unit) / 2;
  const letters = LETTERS.map(
    (d, i) => `<path transform="translate(${left + i * (5 + gap) * unit} ${top}) scale(${unit})" d="${d}"/>`,
  );

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1" gradientTransform="rotate(${index * 11} 0.5 0.5)">
      <stop offset="0" stop-color="${from}"/>
      <stop offset="1" stop-color="${to}"/>
    </linearGradient>
    <radialGradient id="shade" cx="0.5" cy="0.5" r="0.75">
      <stop offset="0.55" stop-color="#000" stop-opacity="0"/>
      <stop offset="1" stop-color="#000" stop-opacity="0.35"/>
    </radialGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#bg)"/>
  <g fill="none" stroke="#fff" stroke-opacity="0.16" stroke-width="2">${tiles.join("")}</g>
  <g fill="none" stroke="#fff" stroke-opacity="0.3" stroke-width="5">${star(w / 2, h / 2, 330, index * 7)}</g>
  <rect width="${w}" height="${h}" fill="url(#shade)"/>
  <rect x="${left - 44}" y="${top - 40}" width="${wordWidth + 88}" height="${7 * unit + 80}" rx="22"
        fill="#000" fill-opacity="0.28"/>
  <g fill="none" stroke="#fff" stroke-width="0.9" stroke-linecap="round" stroke-linejoin="round">${letters.join("")}</g>
</svg>`;
}

/** WebP картинки номер index — без метаданных */
export async function demoPhoto(index: number): Promise<Buffer> {
  return sharp(Buffer.from(demoPhotoSvg(index)))
    .webp({ quality: QUALITY, effort: 6 })
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
