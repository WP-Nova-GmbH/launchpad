#!/usr/bin/env node
/**
 * Regenerates the production brand icon set from the Launchpad mascot artwork.
 *
 *   node scripts/generate-brand-icons.ts <source-1024.png>
 *
 * The source is the full logo lockup (mascot, wordmark, terminal, brackets).
 * Icons use the mascot's face alone: the wordmark is illegible below 32px, and
 * the surrounding elements crop into fragments. The plate is the same
 * near-black as the artwork's own outline so the crop edge never shows.
 *
 * Run this when the logo changes; the generated files are committed, so a
 * normal build never needs it.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import sharp from "sharp";

const REPO_ROOT = NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)));
const OUT_DIR = NodePath.join(REPO_ROOT, "assets/prod");

/**
 * The face inside the 1024x1024 lockup: helmet to jaw, headphone to beak tip.
 * The right edge stops before the terminal box at x=745, and the bottom before
 * the mouse cursor that overlaps the feather ruff.
 */
const FACE = { left: 350, top: 175, width: 394, height: 300 } as const;

/** The artwork's own outline colour, sampled from the mascot. */
const PLATE = "#00000b";

const source = process.argv[2];
if (!source) {
  console.error("usage: node scripts/generate-brand-icons.ts <source-1024.png>");
  process.exit(1);
}

const face = (width: number) =>
  sharp(source)
    .extract({ ...FACE })
    .resize({ width })
    .png()
    .toBuffer();

const plate = (canvas: number, inset: number, radiusRatio: number) => {
  const size = canvas - inset * 2;
  const radius = Math.round(size * radiusRatio);
  return Buffer.from(
    `<svg width="${canvas}" height="${canvas}" xmlns="http://www.w3.org/2000/svg">` +
      `<rect x="${inset}" y="${inset}" width="${size}" height="${size}" ` +
      `rx="${radius}" ry="${radius}" fill="${PLATE}"/></svg>`,
  );
};

/** Composites the face onto a plate, sized by width so it fills rather than letterboxes. */
async function icon({
  canvas,
  inset,
  coverage,
  radiusRatio,
  out,
}: {
  canvas: number;
  inset: number;
  coverage: number;
  radiusRatio: number;
  out: string;
}) {
  const plateSize = canvas - inset * 2;
  const artWidth = Math.round(plateSize * coverage);
  const art = await face(artWidth);
  const { height = 0 } = await sharp(art).metadata();
  const buffer = await sharp(plate(canvas, inset, radiusRatio))
    .composite([
      {
        input: art,
        left: inset + Math.round((plateSize - artWidth) / 2),
        top: inset + Math.round((plateSize - height) / 2),
      },
    ])
    .png()
    .toBuffer();
  NodeFS.writeFileSync(NodePath.join(OUT_DIR, out), buffer);
  console.log("wrote", out);
  return buffer;
}

/**
 * Packs PNGs into an .ico. Windows accepts PNG-compressed entries, so this is
 * a header plus the same images — no ImageMagick needed.
 */
function encodeIco(images: ReadonlyArray<{ size: number; data: Buffer }>): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;
  images.forEach((image, index) => {
    const entry = index * 16;
    // 256 is encoded as 0 in a single byte.
    directory.writeUInt8(image.size >= 256 ? 0 : image.size, entry);
    directory.writeUInt8(image.size >= 256 ? 0 : image.size, entry + 1);
    directory.writeUInt8(0, entry + 2);
    directory.writeUInt8(0, entry + 3);
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(image.data.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += image.data.length;
  });

  return Buffer.concat([header, directory, ...images.map((image) => image.data)]);
}

// macOS: the plate floats inside a transparent margin, per Apple's icon grid.
await icon({
  canvas: 1024,
  inset: 100,
  coverage: 0.9,
  radiusRatio: 0.225,
  out: "launchpad-macos-1024.png",
});
// iOS: full bleed, because the system applies its own mask.
await icon({
  canvas: 1024,
  inset: 0,
  coverage: 0.88,
  radiusRatio: 0.225,
  out: "launchpad-ios-1024.png",
});
// Linux, Windows, and the web favicons all derive from the universal plate.
const universal = await icon({
  canvas: 1024,
  inset: 32,
  coverage: 0.9,
  radiusRatio: 0.225,
  out: "launchpad-universal-1024.png",
});

for (const size of [16, 32, 180] as const) {
  const name =
    size === 180
      ? "launchpad-web-apple-touch-180.png"
      : `launchpad-web-favicon-${size}x${size}.png`;
  NodeFS.writeFileSync(
    NodePath.join(OUT_DIR, name),
    await sharp(universal).resize(size, size).png().toBuffer(),
  );
  console.log("wrote", name);
}

const icoSizes = [16, 32, 48, 64, 128, 256] as const;
const icoImages = await Promise.all(
  icoSizes.map(async (size) => ({
    size,
    data: await sharp(universal).resize(size, size).png().toBuffer(),
  })),
);
for (const name of ["launchpad-windows.ico", "launchpad-web-favicon.ico"]) {
  NodeFS.writeFileSync(NodePath.join(OUT_DIR, name), encodeIco(icoImages));
  console.log("wrote", name);
}
