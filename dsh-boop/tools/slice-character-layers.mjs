/**
 * 2.5D layer slicer for the BOOP character master.
 *
 * Splits the transparent master into aligned layers so the client can animate
 * each part with real transforms (tail swing, fin lift, blink, drop sway,
 * breathing). Every layer keeps the FULL master canvas and the same pixel
 * offsets, so they stack exactly without any re-alignment.
 *
 * Layering is geometric + colour based on the approved art — no repainting:
 *   drop    顶部水滴        light blue, above the body
 *   eye     胶囊眼(睁)     near-black pixels
 *   tail    尾鳍           left of the body mass
 *   finL/R  胸鳍           lower left / right of the body mass
 *   base    身体+腹面+地影  everything else
 *
 * Usage: node tools/slice-character-layers.mjs <master.png> <outDir>
 */
import fs from 'node:fs'
import path from 'node:path'
import { decodePng, encodePng } from './png-white-to-alpha.mjs'

const LAYERS = ['drop', 'eye', 'tail', 'finL', 'finR', 'base']

function classify(x, y, width, height, r, g, b, a) {
  if (a < 8) return null
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
  const saturation = Math.max(r, g, b) - Math.min(r, g, b)
  const nx = x / width
  const ny = y / height

  // The eyes are near-black AND unsaturated; the body shading is dark but
  // strongly blue, so a luminance test alone would capture half the whale.
  if (luminance < 96 && saturation < 45) return 'eye'
  // Top droplets: light blue above the body mass.
  if (ny < 0.34 && saturation >= 18 && luminance > 150) return 'drop'
  // Tail: left of the body, upper-middle band.
  if (nx < 0.3 && ny > 0.3 && ny < 0.82) return 'tail'
  // Fins: lower flanks.
  if (ny >= 0.6 && ny < 0.92) {
    if (nx < 0.42) return 'finL'
    if (nx > 0.68) return 'finR'
  }
  return 'base'
}

function main() {
  const [, , masterPath, outDir] = process.argv
  if (!masterPath || !outDir) {
    console.error('usage: node tools/slice-character-layers.mjs <master.png> <outDir>')
    process.exit(1)
  }
  const master = decodePng(fs.readFileSync(masterPath))
  const { width, height, pixels } = master
  fs.mkdirSync(outDir, { recursive: true })

  const counts = Object.fromEntries(LAYERS.map((name) => [name, 0]))
  const layers = Object.fromEntries(
    LAYERS.map((name) => [name, Buffer.alloc(width * height * 4)]),
  )

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x
      const p = index * 4
      const layer = classify(x, y, width, height, pixels[p], pixels[p + 1], pixels[p + 2], pixels[p + 3])
      if (!layer) continue
      counts[layer] += 1
      const target = layers[layer]
      target[p] = pixels[p]
      target[p + 1] = pixels[p + 1]
      target[p + 2] = pixels[p + 2]
      target[p + 3] = pixels[p + 3]
    }
  }

  const manifest = { width, height, layers: {}, source: path.basename(masterPath) }
  for (const name of LAYERS) {
    const file = `boop-${name}.png`
    fs.writeFileSync(path.join(outDir, file), encodePng({ width, height, pixels: layers[name] }))
    manifest.layers[name] = { file, pixels: counts[name] }
  }
  fs.writeFileSync(path.join(outDir, 'layers.json'), JSON.stringify(manifest, null, 2))

  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  console.log(`sliced ${width}x${height}, ${total} foreground pixels`)
  for (const name of LAYERS) {
    console.log(`  ${name.padEnd(5)} ${counts[name]} px (${((100 * counts[name]) / total).toFixed(1)}%)`)
  }
}

main()