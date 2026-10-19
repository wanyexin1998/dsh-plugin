/**
 * PNG 编解码 + 泛洪去白（纯 Node，零依赖）。
 *
 * 用途：把 `baseline/assets/boop-character-approved.png`（白底、无 alpha）
 * 转成透明底母版，作为 2.5D 分层动画的素材来源。
 *
 * 为什么泛洪而不是"按白色删像素"：角色的奶白腹面本身接近白色，逐像素去白会
 * 啃掉腹面。泛洪只从画布边缘出发，且要求"亮且低饱和"，腹面被蓝色身体包住，
 * 永远不会被波及；底部接触阴影与背景相连，因此会一并被去掉（母版不带地影）。
 *
 * 用法：node tools/png-white-to-alpha.mjs <in.png> <out.png> [preview.png]
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

/* ── PNG decode ─────────────────────────────────────────────────────── */

export function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG')
  let offset = 8
  let width = 0
  let height = 0
  let colorType = 0
  let bitDepth = 0
  let interlace = 0
  const idat = []
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      interlace = data[12]
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    offset += 12 + length
  }
  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`)
  if (interlace !== 0) throw new Error('interlaced PNG is not supported')
  const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : colorType === 0 ? 1 : null
  if (!channels) throw new Error(`unsupported color type ${colorType}`)
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = Buffer.alloc(width * height * 4)
  let previous = Buffer.alloc(stride)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const current = Buffer.alloc(stride)
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? current[x - channels] : 0
      const b = previous[x]
      const c = x >= channels ? previous[x - channels] : 0
      const value = line[x]
      switch (filter) {
        case 0: current[x] = value; break
        case 1: current[x] = (value + a) & 0xff; break
        case 2: current[x] = (value + b) & 0xff; break
        case 3: current[x] = (value + ((a + b) >> 1)) & 0xff; break
        case 4: {
          const p = a + b - c
          const pa = Math.abs(p - a)
          const pb = Math.abs(p - b)
          const pc = Math.abs(p - c)
          const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
          current[x] = (value + pred) & 0xff
          break
        }
        default: throw new Error(`unknown filter ${filter}`)
      }
    }
    // Copy from the UNFILTERED row, not the raw filtered bytes.
    for (let x = 0; x < width; x += 1) {
      const src = x * channels
      const dst = (y * width + x) * 4
      if (channels === 1) {
        out[dst] = out[dst + 1] = out[dst + 2] = current[src]
        out[dst + 3] = 255
      } else {
        out[dst] = current[src]
        out[dst + 1] = current[src + 1]
        out[dst + 2] = current[src + 2]
        out[dst + 3] = channels === 4 ? current[src + 3] : 255
      }
    }
    previous = current
  }
  return { width, height, pixels: out }
}

/* ── PNG encode ─────────────────────────────────────────────────────── */

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let crc = -1
  for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

export function encodePng({ width, height, pixels }) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/* ── background removal ─────────────────────────────────────────────── */

/** Bright and low-saturation: background and its soft shadow, never the belly. */
function isBackdrop(r, g, b, luminanceFloor, saturationCeiling) {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
  return luminance >= luminanceFloor && max - min <= saturationCeiling
}

/**
 * Remove the backdrop with a border flood fill, then feather the alpha edge.
 *
 * @param image decoded PNG
 * @param options luminanceFloor/saturationCeiling tune the backdrop test;
 *        featherRadius softens the cut edge (1–3 is plenty).
 */
export function removeBackdrop(image, options = {}) {
  const {
    // Pass A removes only the true backdrop (near-pure white).
    backgroundFloor = 246,
    backgroundSaturation = 8,
    // Pass B removes the soft contact shadow from the bottom edge only; the
    // threshold is lower because the shadow is gray, not white.
    // Conservative on purpose: the design sheet keeps the original ground
    // shadow as part of the character, so only its brightest halo is trimmed.
    // A tighter threshold would nibble at the cream belly (lum 200-238).
    shadowFloor = 226,
    shadowSaturation = 10,
    shadowCeiling = 240,
    featherRadius = 1,
  } = options
  const { width, height, pixels } = image
  const total = width * height
  const removed = new Uint8Array(total)

  /** Flood from a set of seed pixels across pixels matching a test. */
  const flood = (seeds, test) => {
    const stack = []
    const push = (index) => {
      if (removed[index]) return
      const p = index * 4
      if (!test(pixels[p], pixels[p + 1], pixels[p + 2])) return
      removed[index] = 1
      stack.push(index)
    }
    for (const index of seeds) {
      // A seed may already be removed (pass B seeds from the removed region);
      // it must still enter the stack so the flood can grow through it.
      if (removed[index]) stack.push(index)
      else push(index)
    }
    while (stack.length) {
      const index = stack.pop()
      const x = index % width
      const y = (index - x) / width
      if (x > 0) push(index - 1)
      if (x < width - 1) push(index + 1)
      if (y > 0) push(index - width)
      if (y < height - 1) push(index + width)
    }
  }

  const border = []
  for (let x = 0; x < width; x += 1) { border.push(x); border.push((height - 1) * width + x) }
  for (let y = 1; y < height - 1; y += 1) { border.push(y * width); border.push(y * width + width - 1) }

  // Pass A: pure backdrop from every border.
  flood(border, (r, g, b) =>
    isBackdrop(r, g, b, backgroundFloor, backgroundSaturation))

  // Pass B: the contact shadow rises from the bottom edge. It is gray, so a
  // white-only test would leave it behind; it is bounded by the blue body, so a
  // bottom-up flood cannot reach the cream belly.
  // The shadow is an ISLAND of gray inside the already-removed backdrop, so it
  // is never reachable from the canvas border: grow from the removed region
  // itself. The upper luminance bound keeps the cream belly (brighter than the
  // shadow) out of reach even if the two touch.
  const seeds = []
  for (let i = 0; i < total; i += 1) if (removed[i]) seeds.push(i)
  flood(seeds, (r, g, b) => {
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
    const saturation = Math.max(r, g, b) - Math.min(r, g, b)
    return luminance >= shadowFloor && luminance <= shadowCeiling && saturation <= shadowSaturation
  })

  // Soften the cut edge so the silhouette is not jagged.
  let alpha = new Float32Array(total)
  for (let i = 0; i < total; i += 1) alpha[i] = removed[i] ? 0 : 1
  for (let pass = 0; pass < featherRadius; pass += 1) {
    const next = Float32Array.from(alpha)
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = y * width + x
        let sum = 0
        let count = 0
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const nx = x + dx
            const ny = y + dy
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
            sum += alpha[ny * width + nx]
            count += 1
          }
        }
        next[i] = sum / count
      }
    }
    alpha = next
  }

  const out = Buffer.from(pixels)
  let cleared = 0
  for (let i = 0; i < total; i += 1) {
    const value = alpha[i]
    if (value === 0) cleared += 1
    const p = i * 4
    // Straight (non-premultiplied) alpha: only the channel changes. Dividing
    // RGB by a fractional alpha — an "un-premultiply" that does not apply here —
    // clips the edge to white and produces streaks.
    out[p + 3] = Math.round(Math.max(0, Math.min(1, value)) * 255)
  }
  return { width, height, pixels: out, removedRatio: cleared / total }
}

/** Composite onto a solid colour so a human can see the cut. */
export function compositeOn(image, hex) {
  const { width, height, pixels } = image
  const out = Buffer.from(pixels)
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  for (let i = 0; i < width * height; i += 1) {
    const a = out[i * 4 + 3] / 255
    const p = i * 4
    out[p] = Math.round(out[p] * a + r * (1 - a))
    out[p + 1] = Math.round(out[p + 1] * a + g * (1 - a))
    out[p + 2] = Math.round(out[p + 2] * a + b * (1 - a))
    out[p + 3] = 255
  }
  return { width, height, pixels: out }
}

/* ── CLI ────────────────────────────────────────────────────────────── */

function main() {
  const [, , input, output, preview] = process.argv
  if (!input || !output) {
    console.error('usage: node tools/png-white-to-alpha.mjs <in.png> <out.png> [preview.png]')
    process.exit(1)
  }
  const decoded = decodePng(fs.readFileSync(input))
  const result = removeBackdrop(decoded)
  fs.writeFileSync(output, encodePng(result))
  console.log(
    `decoded ${result.width}x${result.height}; removed ${(result.removedRatio * 100).toFixed(1)}% as backdrop`,
  )
  if (preview) {
    fs.writeFileSync(preview, encodePng(compositeOn(result, '0B2637')))
    console.log(`preview written to ${preview}`)
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main()