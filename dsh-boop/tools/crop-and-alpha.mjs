/**
 * Crop + backdrop removal for asset extraction.
 *
 * Reuses the pure-Node PNG codec from png-white-to-alpha.mjs. Used to lift the
 * three state figures (倾听 / 思考 / 完成) out of the approved KV board, where
 * they were drawn small inside a dark scene — this keeps the user's own art
 * instead of redrawing it.
 *
 * Usage:
 *   node tools/crop-and-alpha.mjs <in.png> <out.png> <x> <y> <w> <h> [previewHex]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodePng, encodePng, removeBackdrop, compositeOn } from './png-white-to-alpha.mjs'

export function crop(image, rect) {
  const { x, y, width, height } = rect
  if (x < 0 || y < 0 || x + width > image.width || y + height > image.height) {
    throw new Error(`crop ${JSON.stringify(rect)} is outside ${image.width}x${image.height}`)
  }
  const out = Buffer.alloc(width * height * 4)
  for (let row = 0; row < height; row += 1) {
    const from = ((y + row) * image.width + x) * 4
    image.pixels.copy(out, row * width * 4, from, from + width * 4)
  }
  return { width, height, pixels: out }
}

/** Nearest-neighbour scale, adequate for inspection crops. */
export function scale(image, factor) {
  const width = Math.round(image.width * factor)
  const height = Math.round(image.height * factor)
  const out = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    const sy = Math.floor(y / factor)
    for (let x = 0; x < width; x += 1) {
      const sx = Math.floor(x / factor)
      const src = (sy * image.width + sx) * 4
      const dst = (y * width + x) * 4
      out[dst] = image.pixels[src]
      out[dst + 1] = image.pixels[src + 1]
      out[dst + 2] = image.pixels[src + 2]
      out[dst + 3] = image.pixels[src + 3]
    }
  }
  return { width, height, pixels: out }
}

/** Trim fully transparent margins so the extracted layer is tight. */
export function trim(image, threshold = 8) {
  let minX = image.width
  let minY = image.height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (image.pixels[(y * image.width + x) * 4 + 3] > threshold) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return image
  const rect = { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
  const trimmed = crop(image, rect)
  // Keep a small transparent margin so later CSS transforms have room.
  const pad = 4
  const width = trimmed.width + pad * 2
  const height = trimmed.height + pad * 2
  const out = Buffer.alloc(width * height * 4)
  // Row by row: a single bulk copy would mis-align every row after the first.
  for (let row = 0; row < trimmed.height; row += 1) {
    trimmed.pixels.copy(
      out,
      ((pad + row) * width + pad) * 4,
      row * trimmed.width * 4,
      (row + 1) * trimmed.width * 4,
    )
  }
  return { width, height, pixels: out }
}

function main() {
  const [, , input, output, xs, ys, ws, hs, previewHex] = process.argv
  if (!input || !output || !xs || !ys || !ws || !hs) {
    console.error('usage: node tools/crop-and-alpha.mjs <in.png> <out.png> <x> <y> <w> <h> [previewHex]')
    process.exit(1)
  }
  const decoded = decodePng(fs.readFileSync(input))
  const region = crop(decoded, { x: Number(xs), y: Number(ys), width: Number(ws), height: Number(hs) })
  // KV crops sit on a light gradient, not pure white, so the default is more
  // permissive than the character sheet; the belly stays protected because it is
  // enclosed by the blue body and never reachable from the border.
  const result = removeBackdrop(region, {
    backgroundFloor: Number(process.env.BOOP_BG_FLOOR ?? 232),
    backgroundSaturation: Number(process.env.BOOP_BG_SAT ?? 20),
  })
  const tight = trim(result)
  fs.writeFileSync(output, encodePng(tight))
  console.log(`cropped ${xs},${ys} ${ws}x${hs} → ${tight.width}x${tight.height}`)
  if (previewHex) fs.writeFileSync(`${output.replace(/\.png$/, '')}-preview.png`, encodePng(compositeOn(tight, previewHex)))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main()