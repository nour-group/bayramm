// Фикстуры для тестов: настоящие маленькие WebP, JPEG и PNG, собранные прямо в
// коде — без фотографий и без чьих-либо данных. В прод-код не импортировать.
//
//   webpFixture — WebP без потерь (VP8L) сплошного цвета: все коды Хаффмана из
//                 одного символа, пиксели занимают 0 бит, поэтому файл 640×480
//                 весит 32 байта. Декодеры открывают его как обычную картинку
//                 (некоторые — только до ~1 Мп: слишком «сжатый» файл принимают
//                 за бомбу распаковки, поэтому для декодирования брать ≤ 1024×768);
//   jpegFixture — baseline JPEG в оттенках серого: у каждого блока 8×8 только
//                 DC = 0 и EOB, по 2 бита на блок — тоже декодируемый;
//   pngFixture  — PNG в оттенках серого, deflate без сжатия (stored-блоки).
//
// Метаданные (EXIF, XMP, комментарий, миниатюра) добавляются явными сегментами
// и чанками — так тесты проверяют, что их находит проверка и вырезает очистка.

const ascii = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));

export function concat(...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function u16be(value: number) {
  return Uint8Array.of(value >>> 8, value & 0xff);
}

function u32be(value: number) {
  return Uint8Array.of(value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}

function u32le(value: number) {
  return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24);
}

function u24le(value: number) {
  return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff);
}

// ── WebP ───────────────────────────────────────────────────────────────────

/** Биты VP8L пишутся начиная с младшего */
class BitWriter {
  private readonly bytes: number[] = [];
  private acc = 0;
  private count = 0;

  put(value: number, bits: number): this {
    for (let i = 0; i < bits; i++) {
      this.acc |= ((value >>> i) & 1) << this.count;
      if (++this.count === 8) {
        this.bytes.push(this.acc);
        this.acc = 0;
        this.count = 0;
      }
    }
    return this;
  }

  finish(): Uint8Array {
    if (this.count > 0) this.bytes.push(this.acc);
    return Uint8Array.from(this.bytes);
  }
}

/** Кадр VP8L сплошного цвета (серый 128, непрозрачный) */
export function vp8lSolid(width: number, height: number): Uint8Array {
  const bits = new BitWriter()
    .put(0x2f, 8) // сигнатура
    .put(width - 1, 14)
    .put(height - 1, 14)
    .put(0, 1) // альфа не используется
    .put(0, 3) // версия 0
    .put(0, 1) // без преобразований
    .put(0, 1) // без кэша цветов
    .put(0, 1); // без мета-кодов
  // Пять «простых» кодов по одному символу: зелёный, красный, синий, альфа, расстояние
  for (const symbol of [128, 128, 128, 255, 0]) {
    bits.put(1, 1).put(0, 1); // простой код, один символ
    if (symbol < 2) bits.put(0, 1).put(symbol, 1);
    else bits.put(1, 1).put(symbol, 8);
  }
  return bits.finish();
}

/** Заголовок кадра VP8 (с потерями) нужного размера. Только для разбора: пикселей в нём нет */
export function vp8HeaderOnly(width: number, height: number): Uint8Array {
  return concat(
    Uint8Array.of(0x10, 0x02, 0x00), // ключевой кадр, show_frame
    Uint8Array.of(0x9d, 0x01, 0x2a), // стартовый код
    Uint8Array.of(width & 0xff, width >>> 8, height & 0xff, height >>> 8),
    new Uint8Array(8),
  );
}

export function webpChunk(fourcc: string, data: Uint8Array): Uint8Array {
  const pad = data.length % 2 === 1 ? Uint8Array.of(0) : new Uint8Array(0);
  return concat(ascii(fourcc), u32le(data.length), data, pad);
}

export function riff(chunks: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const body = concat(ascii("WEBP"), ...chunks);
  return concat(ascii("RIFF"), u32le(body.length), body);
}

export const VP8X_FLAGS = { icc: 0x20, alpha: 0x10, exif: 0x08, xmp: 0x04, animation: 0x02 } as const;

export interface WebpFixtureOptions {
  readonly width: number;
  readonly height: number;
  /** Кадр с потерями (только заголовок) вместо декодируемого без потерь */
  readonly lossy?: boolean;
  /** Расширенный формат: VP8X с этими флагами, затем кадр, затем extra */
  readonly vp8x?: number;
  /** Чанки после кадра (EXIF, XMP, …) */
  readonly extra?: readonly Uint8Array[];
}

export function webpFixture({ width, height, lossy = false, vp8x, extra = [] }: WebpFixtureOptions) {
  const frame = lossy
    ? webpChunk("VP8 ", vp8HeaderOnly(width, height))
    : webpChunk("VP8L", vp8lSolid(width, height));
  const header =
    vp8x === undefined
      ? []
      : [webpChunk("VP8X", concat(Uint8Array.of(vp8x, 0, 0, 0), u24le(width - 1), u24le(height - 1)))];
  return riff([...header, frame, ...extra]);
}

// ── JPEG ───────────────────────────────────────────────────────────────────

export interface JpegSegment {
  readonly marker: number;
  readonly data: Uint8Array;
}

function segment({ marker, data }: JpegSegment): Uint8Array {
  return concat(Uint8Array.of(0xff, marker), u16be(data.length + 2), data);
}

/** TIFF-заголовок и один IFD с одной записью (Orientation = 1) */
const TIFF_MINIMAL = concat(
  Uint8Array.of(0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08), // MM, 42, IFD0 по смещению 8
  Uint8Array.of(0x00, 0x01), // одна запись
  Uint8Array.of(0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00), // Orientation = 1
  Uint8Array.of(0x00, 0x00, 0x00, 0x00), // следующего IFD нет
);

export const exifSegment = (): JpegSegment => ({
  marker: 0xe1,
  data: concat(ascii("Exif\0\0"), TIFF_MINIMAL),
});
export const xmpSegment = (): JpegSegment => ({
  marker: 0xe1,
  data: ascii("http://ns.adobe.com/xap/1.0/\0<x:xmpmeta xmlns:x='adobe:ns:meta/'/>"),
});
export const commentSegment = (): JpegSegment => ({ marker: 0xfe, data: ascii("fixture comment") });
export const iptcSegment = (): JpegSegment => ({ marker: 0xed, data: ascii("Photoshop 3.0\0") });
/** ICC-профиль (заглушка): не метаданные, очистка его оставляет */
export const iccSegment = (): JpegSegment => ({
  marker: 0xe2,
  data: concat(ascii("ICC_PROFILE\0"), Uint8Array.of(1, 1), new Uint8Array(16)),
});

export interface JpegFixtureOptions {
  readonly width: number;
  readonly height: number;
  /** Сегменты сразу после APP0 */
  readonly segments?: readonly JpegSegment[];
  /** Миниатюра в JFIF (её размеры в заголовке APP0) */
  readonly jfifThumbnail?: boolean;
  /** Байты после EOI */
  readonly trailer?: Uint8Array;
}

export function jpegFixture({
  width,
  height,
  segments = [],
  jfifThumbnail = false,
  trailer,
}: JpegFixtureOptions) {
  const thumb = jfifThumbnail ? [1, 1] : [0, 0];
  const app0 = concat(
    ascii("JFIF\0"),
    Uint8Array.of(1, 1, 0, 0, 1, 0, 1, ...thumb),
    new Uint8Array(thumb[0] ? 3 : 0),
  );
  const dqt = concat(Uint8Array.of(0x00), new Uint8Array(64).fill(1));
  const sof = concat(Uint8Array.of(8), u16be(height), u16be(width), Uint8Array.of(1, 1, 0x11, 0));
  const huffman = (tableClass: number) =>
    concat(Uint8Array.of(tableClass), Uint8Array.of(1), new Uint8Array(15), Uint8Array.of(0));
  const sos = Uint8Array.of(1, 1, 0x00, 0, 63, 0);

  // Каждый блок 8×8: DC-разность 0 (код «0») и EOB (код «0») — 2 бита; хвост байта — единицы
  const blocks = Math.ceil(width / 8) * Math.ceil(height / 8);
  const bits = blocks * 2;
  const scan = new Uint8Array(Math.ceil(bits / 8));
  if (bits % 8 !== 0) scan[scan.length - 1] = (1 << (8 - (bits % 8))) - 1;

  return concat(
    Uint8Array.of(0xff, 0xd8),
    segment({ marker: 0xe0, data: app0 }),
    ...segments.map(segment),
    segment({ marker: 0xdb, data: dqt }),
    segment({ marker: 0xc0, data: sof }),
    segment({ marker: 0xc4, data: huffman(0x00) }),
    segment({ marker: 0xc4, data: huffman(0x10) }),
    segment({ marker: 0xda, data: sos }),
    scan,
    Uint8Array.of(0xff, 0xd9),
    trailer ?? new Uint8Array(0),
  );
}

// ── PNG ────────────────────────────────────────────────────────────────────

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of data) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const body = concat(ascii(type), data);
  return concat(u32be(data.length), body, u32be(crc32(body)));
}

/** zlib-поток из stored-блоков deflate (без сжатия) */
function zlibStored(raw: Uint8Array): Uint8Array {
  const blocks: Uint8Array[] = [Uint8Array.of(0x78, 0x01)];
  for (let offset = 0; offset < raw.length || offset === 0; offset += 0xffff) {
    const chunk = raw.subarray(offset, offset + 0xffff);
    const last = offset + 0xffff >= raw.length;
    const len = chunk.length;
    blocks.push(Uint8Array.of(last ? 1 : 0, len & 0xff, len >>> 8, ~len & 0xff, (~len >>> 8) & 0xff), chunk);
    if (last) break;
  }
  let a = 1;
  let b = 0;
  for (const byte of raw) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  blocks.push(u32be(((b << 16) | a) >>> 0));
  return concat(...blocks);
}

export interface PngFixtureOptions {
  readonly width: number;
  readonly height: number;
  /** Чанки между IHDR и IDAT (tEXt, eXIf, acTL, …) */
  readonly chunks?: readonly Uint8Array[];
}

export function pngFixture({ width, height, chunks = [] }: PngFixtureOptions) {
  const ihdr = concat(u32be(width), u32be(height), Uint8Array.of(8, 0, 0, 0, 0)); // 8 бит, серый
  const raw = new Uint8Array((width + 1) * height);
  for (let y = 0; y < height; y++) raw.fill(128, y * (width + 1) + 1, (y + 1) * (width + 1)); // фильтр 0 + серый
  return concat(
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    pngChunk("IHDR", ihdr),
    ...chunks,
    pngChunk("IDAT", zlibStored(raw)),
    pngChunk("IEND", new Uint8Array(0)),
  );
}

export const pngText = () => pngChunk("tEXt", ascii("Comment\0fixture"));
export const pngExif = () => pngChunk("eXIf", TIFF_MINIMAL);
export const pngXmp = () => pngChunk("iTXt", ascii("XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta/>"));
