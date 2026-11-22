import { clamp, fbm, hash2, lerp, smoothstep, TAU } from './math'
import { paintGrid } from './grid'

export const PIXEL_SCENES = [
  'forest',
  'space',
  'lighthouse',
  'skyline',
  'dunes',
  'torii',
  'rooftop',
  'aurora',
  'pier',
  'islands',
  'viaduct',
] as const

export type PixelScene = (typeof PIXEL_SCENES)[number]
export type AvoidRect = { x: number; y: number; width: number; height: number }

type RGB = [number, number, number]
type Star = { x: number; y: number; phase: number; speed: number; bright: number }
type Tree = { x: number; base: number; h: number; w: number; seed: number }
type Orbiter = { ang: number; alt: number; kind: number }
type Building = {
  x: number
  w: number
  h: number
  spire: number
  beacon: boolean
  wins: { dx: number; dy: number; warm: boolean; phase: number }[]
  shade: number
}
type Roof = {
  x: number
  w: number
  h: number
  antenna: boolean
  chimney: boolean
  waterTower: boolean
  seed: number
}
type Raindrop = { x: number; y: number; speed: number; len: number }
type Snowflake = { x: number; y: number; speed: number; phase: number }
type Island = { cx: number; cy: number; rx: number; depth: number; phase: number; fall: boolean }
type Mote = { x: number; y: number; phase: number; speed: number }

interface SceneGeo {
  isPortrait: boolean
  stars: Star[]
  forestLayers: { trees: Tree[] }[]
  orbiters: Orbiter[]
  buildings: Building[]
  roofs: Roof[]
  raindrops: Raindrop[]
  tundraTrees: Tree[]
  snowFlakes: Snowflake[]
  islands: Island[]
  toriiMotes: Mote[]
}

const BAYER4 = [
  0, 8, 2, 10,
  12, 4, 14, 6,
  3, 11, 1, 9,
  15, 7, 13, 5,
].map((v) => (v + 0.5) / 16)

function hexRgb(hex: string): RGB {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

const BG_DARK: RGB = hexRgb('#05070d')
const BG_LIGHT: RGB = hexRgb('#f6f8fb')

function pickDither(pal: RGB[], t: number, x: number, y: number, strength = 0.6): RGB {
  const scaled = clamp(t, 0, 1) * (pal.length - 1)
  const i = Math.floor(scaled)
  const f = scaled - i
  const b = 0.5 + (BAYER4[((y & 3) << 2) | (x & 3)] - 0.5) * strength
  return pal[Math.min(pal.length - 1, i + (f > b ? 1 : 0))]
}

function blendPixel(d: Uint8ClampedArray, idx: number, target: RGB, alpha: number) {
  d[idx] = Math.round(d[idx] + (target[0] - d[idx]) * alpha)
  d[idx + 1] = Math.round(d[idx + 1] + (target[1] - d[idx + 1]) * alpha)
  d[idx + 2] = Math.round(d[idx + 2] + (target[2] - d[idx + 2]) * alpha)
}

export function pickRandomScene(exclude?: PixelScene): PixelScene {
  const pool = exclude ? PIXEL_SCENES.filter((s) => s !== exclude) : PIXEL_SCENES
  return pool[Math.floor(Math.random() * pool.length)]
}

export class PixelSceneryEngine {
  private ctx: CanvasRenderingContext2D
  private buf: HTMLCanvasElement
  private bctx: CanvasRenderingContext2D
  private grid: HTMLCanvasElement
  private imgData: ImageData | null = null

  private W = 0
  private H = 0
  private dpr = 1
  private pw = 0
  private ph = 0
  private t = 0
  private last = 0
  private raf = 0
  private visible = true
  private disposed = false

  private avoid: AvoidRect | null = null
  private avoidBuf: { x0: number; x1: number; y0: number; y1: number } | null = null
  private pointer = { x: 0, y: 0, active: false }
  private geo: SceneGeo | null = null

  private reduced: MediaQueryList
  private ro: ResizeObserver
  private io: IntersectionObserver

  constructor(
    private canvas: HTMLCanvasElement,
    private scene: PixelScene,
    private dark = true,
  ) {
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) throw new Error('2D canvas unavailable')
    this.ctx = ctx

    this.buf = document.createElement('canvas')
    const bctx = this.buf.getContext('2d', { alpha: false })
    if (!bctx) throw new Error('2D buffer unavailable')
    this.bctx = bctx

    this.grid = document.createElement('canvas')
    this.reduced = window.matchMedia('(prefers-reduced-motion: reduce)')

    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(canvas)
    this.io = new IntersectionObserver(([e]) => {
      this.visible = e.isIntersecting
      this.schedule()
    })
    this.io.observe(canvas)

    this.reduced.addEventListener('change', this.onMotion)
    window.addEventListener('pointermove', this.onMove, { passive: true })
    window.addEventListener('blur', this.onLeave)
    document.documentElement.addEventListener('pointerleave', this.onLeave)

    this.resize()
    this.schedule()
  }

  getScene(): PixelScene {
    return this.scene
  }

  setScene(scene: PixelScene) {
    this.scene = scene
    this.draw()
  }

  setTheme(dark: boolean) {
    this.dark = dark
    this.paintGridLayer()
    this.draw()
  }

  setAvoidRect(rect: AvoidRect | null) {
    this.avoid = rect
    this.syncAvoidBuf()
    this.draw()
  }

  destroy() {
    this.disposed = true
    cancelAnimationFrame(this.raf)
    this.ro.disconnect()
    this.io.disconnect()
    this.reduced.removeEventListener('change', this.onMotion)
    window.removeEventListener('pointermove', this.onMove)
    window.removeEventListener('blur', this.onLeave)
    document.documentElement.removeEventListener('pointerleave', this.onLeave)
  }

  // ── lifecycle ──────────────────────────────────────────────

  private syncAvoidBuf() {
    if (!this.avoid || !this.W || !this.H || !this.pw || !this.ph) {
      this.avoidBuf = null
      return
    }
    const sx = this.pw / this.W
    const sy = this.ph / this.H
    this.avoidBuf = {
      x0: this.avoid.x * sx,
      x1: (this.avoid.x + this.avoid.width) * sx,
      y0: this.avoid.y * sy,
      y1: (this.avoid.y + this.avoid.height) * sy,
    }
  }

  private paintGridLayer() {
    if (!this.W || !this.H) return
    this.grid.width = this.canvas.width
    this.grid.height = this.canvas.height
    const g = this.grid.getContext('2d')
    if (!g) return
    const cw = clamp(Math.round(this.W / 124), 8, 13)
    const ch = Math.round(cw * 1.45)
    paintGrid(g, this.W, this.H, cw, ch, this.dpr, this.dark)
  }

  private resize() {
    const r = this.canvas.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) return
    this.W = r.width
    this.H = r.height
    this.dpr = Math.min(window.devicePixelRatio || 1, 2)
    this.canvas.width = Math.round(this.W * this.dpr)
    this.canvas.height = Math.round(this.H * this.dpr)

    const pixelSize = this.W < 640 ? 3.2 : 4.0
    this.pw = Math.max(115, Math.round(this.W / pixelSize))
    this.ph = Math.max(130, Math.round(this.H / pixelSize))
    this.buf.width = this.pw
    this.buf.height = this.ph
    this.imgData = this.bctx.createImageData(this.pw, this.ph)

    this.paintGridLayer()
    this.syncAvoidBuf()
    this.buildGeo()

    if (this.reduced.matches) this.drawStill()
    else this.draw()
  }

  private schedule() {
    cancelAnimationFrame(this.raf)
    if (this.disposed || !this.visible || this.reduced.matches) return
    this.last = performance.now()
    this.raf = requestAnimationFrame(this.frame)
  }

  private frame = (now: number) => {
    const dt = Math.min(0.05, (now - this.last) / 1000)
    this.last = now
    this.t += dt
    this.draw()
    this.raf = requestAnimationFrame(this.frame)
  }

  private drawStill() {
    this.t = Math.max(this.t, 4.2)
    this.draw()
  }

  private onMotion = () => {
    if (this.reduced.matches) {
      cancelAnimationFrame(this.raf)
      this.drawStill()
    } else {
      this.schedule()
    }
  }

  private onMove = (e: PointerEvent) => {
    const r = this.canvas.getBoundingClientRect()
    const x = e.clientX - r.left
    const y = e.clientY - r.top
    const inside = x >= 0 && y >= 0 && x <= r.width && y <= r.height
    this.pointer = {
      x: (x / Math.max(1, r.width)) * this.pw,
      y: (y / Math.max(1, r.height)) * this.ph,
      active: inside && e.pointerType !== 'touch',
    }
  }

  private onLeave = () => {
    this.pointer.active = false
  }

  // ── pixel helpers ──────────────────────────────────────────

  private setPx(d: Uint8ClampedArray, x: number, y: number, r: number, g: number, b: number) {
    if (x < 0 || y < 0 || x >= this.pw || y >= this.ph) return
    const idx = (y * this.pw + x) * 4
    d[idx] = r
    d[idx + 1] = g
    d[idx + 2] = b
  }

  private blendPx(d: Uint8ClampedArray, x: number, y: number, col: RGB, a: number) {
    if (x < 0 || y < 0 || x >= this.pw || y >= this.ph || a <= 0.01) return
    blendPixel(d, (y * this.pw + x) * 4, col, clamp(a, 0, 1))
  }

  private clearBg(d: Uint8ClampedArray) {
    const bg = this.dark ? BG_DARK : BG_LIGHT
    for (let i = 0; i < d.length; i += 4) {
      d[i] = bg[0]
      d[i + 1] = bg[1]
      d[i + 2] = bg[2]
      d[i + 3] = 255
    }
  }

  private drawStars(d: Uint8ClampedArray, stars: Star[], time: number, maxY = this.ph, lightAlpha = 0) {
    for (const s of stars) {
      if (s.y >= maxY) continue
      const tw = 0.25 + 0.75 * Math.abs(Math.sin(time * s.speed + s.phase))
      if (this.dark) {
        this.blendPx(d, s.x, s.y, [215, 228, 242], tw * (0.2 + s.bright * 0.5))
      } else if (lightAlpha > 0) {
        this.blendPx(d, s.x, s.y, [75, 95, 118], tw * lightAlpha * (0.4 + s.bright * 0.6))
      }
    }
  }

  private drawPineTree(d: Uint8ClampedArray, tree: Tree, pal: RGB[], sway: number) {
    const { x: cx, base, h, w, seed } = tree
    const topY = base - h
    const tiers = Math.max(4, Math.floor(h / 4))
    for (let dy = 0; dy < h; dy++) {
      const y = topY + dy
      if (y < 0 || y >= this.ph) continue
      const k = dy / h
      const tierPhase = (k * tiers) % 1
      const flare = 0.62 + 0.38 * Math.pow(tierPhase, 0.75)
      const halfW = Math.max(0, Math.round(w * 0.5 * Math.pow(k, 0.78) * flare))
      const tipSway = Math.round(sway * (1 - k) * (1 - k))
      for (let dx = -halfW; dx <= halfW; dx++) {
        const px = cx + dx + tipSway
        if (px < 0 || px >= this.pw) continue
        const edgeRatio = halfW > 0 ? Math.abs(dx) / halfW : 0
        const n = hash2(px, y, seed)
        if (edgeRatio > 0.8 && n > 0.62) continue
        const shade = clamp(0.18 + (1 - k) * 0.35 + (dx < 0 ? 0.16 : 0) + (n - 0.5) * 0.22, 0, 1)
        const col = pickDither(pal, shade, px, y, 0.45)
        this.setPx(d, px, y, col[0], col[1], col[2])
      }
    }
  }

  private drawMistBand(
    d: Uint8ClampedArray,
    pal: RGB[],
    yStart: number,
    yEnd: number,
    density: number,
    driftX: number,
    seed: number,
  ) {
    const { pw, ph } = this
    const y0 = Math.max(0, Math.floor(yStart))
    const y1 = Math.min(ph, Math.ceil(yEnd))
    const span = Math.max(1, y1 - y0)
    for (let y = y0; y < y1; y++) {
      const ny = (y - y0) / span
      const bandEnv = Math.sin(ny * Math.PI)
      for (let x = 0; x < pw; x++) {
        const nx = x / pw
        const wisp = fbm(nx * 4.5 - driftX, (y / ph) * 6.5 + seed * 0.1, seed, 3)
        const alpha = clamp((bandEnv * 0.72 + (wisp - 0.38) * 0.74) * density, 0, 0.88)
        if (alpha <= 0.02) continue
        const shade = clamp(0.25 + (1 - ny) * 0.45 + (wisp - 0.45) * 0.32, 0, 1)
        const col = pickDither(pal, shade, x, y, 0.4)
        blendPixel(d, (y * pw + x) * 4, col, alpha)
      }
    }
  }

  // ── geometry seeding ───────────────────────────────────────

  private buildGeo() {
    const { pw, ph } = this
    const isPortrait = ph > pw * 1.1

    const stars: Star[] = []
    const starCount = Math.round((pw * ph) / 380)
    for (let i = 0; i < starCount; i++) {
      stars.push({
        x: Math.floor(hash2(i, 1, 31) * pw),
        y: Math.floor(hash2(i, 2, 31) * ph * 0.84),
        phase: hash2(i, 3, 31) * TAU,
        speed: 0.35 + hash2(i, 4, 31) * 0.85,
        bright: hash2(i, 5, 31),
      })
    }

    const layerSpecs = [
      { count: Math.round(pw * 0.22), baseY: ph * (isPortrait ? 0.86 : 0.87), minH: ph * 0.08, maxH: ph * 0.14, minW: 7, maxW: 12, seed: 401 },
      { count: Math.round(pw * 0.24), baseY: ph * (isPortrait ? 0.92 : 0.93), minH: ph * 0.1, maxH: ph * 0.17, minW: 9, maxW: 15, seed: 503 },
      { count: Math.round(pw * 0.2), baseY: ph * 1.0, minH: ph * 0.11, maxH: ph * 0.19, minW: 11, maxW: 19, seed: 607 },
    ]
    const forestLayers = layerSpecs.map((L) => {
      const trees: Tree[] = []
      for (let i = 0; i < L.count; i++) {
        const r1 = hash2(i, 1, L.seed)
        const r2 = hash2(i, 2, L.seed)
        const r3 = hash2(i, 3, L.seed)
        const r4 = hash2(i, 4, L.seed)
        const x = Math.round(((i + r1 * 0.9) / L.count) * (pw + 16) - 8)
        const nx = x / pw
        const dip = Math.exp(-Math.pow((nx - 0.5) / 0.28, 2)) * ph * 0.028
        const hill = (fbm(nx * 3.2, L.seed * 0.01, L.seed, 2) - 0.5) * ph * 0.04
        const base = Math.round(L.baseY + dip + hill + (r2 - 0.5) * ph * 0.03)
        trees.push({
          x,
          base,
          h: Math.round(lerp(L.minH, L.maxH, r3)),
          w: Math.round(lerp(L.minW, L.maxW, r4)),
          seed: L.seed + i * 13,
        })
      }
      return { trees }
    })

    const orbiters: Orbiter[] = []
    for (let i = 0; i < 24; i++) {
      orbiters.push({
        ang: hash2(i, 1, 88) * TAU,
        alt: i === 0 ? 0.24 : 0.08 + hash2(i, 2, 88) * 0.65,
        kind: i === 0 ? 1 : i % 10 === 0 ? 2 : 0,
      })
    }

    const buildings: Building[] = []
    let bx = 0
    let bi = 0
    while (bx < pw) {
      const w = Math.round(lerp(7, 18, hash2(bi, 1, 211)))
      const nx = (bx + w / 2) / pw
      const edgeBoost = 0.65 + 0.55 * Math.abs(nx - 0.5) * 2
      const h = Math.round(ph * lerp(0.05, 0.145, hash2(bi, 2, 211)) * edgeBoost)
      const spire = hash2(bi, 3, 211) > 0.78 ? Math.round(lerp(3, 8, hash2(bi, 4, 211))) : 0
      const beacon = spire > 4 && hash2(bi, 5, 211) > 0.4
      const wins: Building['wins'] = []
      for (let wy = 3; wy < h - 3; wy += 3) {
        for (let wx = 2; wx < w - 2; wx += 3) {
          const r = hash2(bx + wx, wy, 223)
          if (r > 0.62) {
            wins.push({ dx: wx, dy: wy, warm: r > 0.72, phase: hash2(bx + wx, wy, 229) * 10 })
          }
        }
      }
      buildings.push({ x: bx, w, h, spire, beacon, wins, shade: hash2(bi, 6, 211) })
      bx += w - Math.round(hash2(bi, 7, 211) * 2)
      bi++
    }

    const roofs: Roof[] = []
    let rx = 0
    let ri = 0
    while (rx < pw) {
      const w = Math.round(lerp(18, 36, hash2(ri, 1, 311)))
      const h = Math.round(ph * lerp(0.09, 0.17, hash2(ri, 2, 311)))
      const antenna = hash2(ri, 3, 311) > 0.5
      const chimney = hash2(ri, 4, 311) > 0.55
      const waterTower = !antenna && hash2(ri, 5, 311) > 0.78
      roofs.push({ x: rx, w, h, antenna, chimney, waterTower, seed: 311 + ri * 7 })
      rx += w - 2
      ri++
    }

    const raindrops: Raindrop[] = []
    const rainN = Math.round((pw * ph) / 280)
    for (let i = 0; i < rainN; i++) {
      raindrops.push({
        x: hash2(i, 1, 337) * pw,
        y: hash2(i, 2, 337) * ph,
        speed: lerp(42, 72, hash2(i, 3, 337)),
        len: Math.round(lerp(3, 6, hash2(i, 4, 337))),
      })
    }

    const tundraTrees: Tree[] = []
    const ttCount = Math.round(pw * 0.08)
    for (let i = 0; i < ttCount; i++) {
      const x = Math.round(hash2(i, 1, 443) * pw)
      if (Math.abs(x / pw - 0.5) < 0.18) continue
      tundraTrees.push({
        x,
        base: Math.round(ph * 0.9 + (hash2(i, 4, 443) - 0.5) * ph * 0.04),
        h: Math.round(lerp(ph * 0.06, ph * 0.12, hash2(i, 2, 443))),
        w: Math.round(lerp(6, 11, hash2(i, 3, 443))),
        seed: 443 + i * 11,
      })
    }

    const snowFlakes: Snowflake[] = []
    for (let i = 0; i < 45; i++) {
      snowFlakes.push({
        x: hash2(i, 1, 449) * pw,
        y: hash2(i, 2, 449) * ph,
        speed: lerp(4, 10, hash2(i, 3, 449)),
        phase: hash2(i, 4, 449) * TAU,
      })
    }

    const islands: Island[] = [
      { cx: pw * (isPortrait ? 0.22 : 0.24), cy: ph * 0.8, rx: Math.round(pw * (isPortrait ? 0.11 : 0.075)), depth: Math.round(ph * 0.09), phase: 0.4, fall: true },
      { cx: pw * 0.54, cy: ph * 0.85, rx: Math.round(pw * (isPortrait ? 0.13 : 0.09)), depth: Math.round(ph * 0.1), phase: 2.1, fall: true },
      { cx: pw * (isPortrait ? 0.82 : 0.79), cy: ph * 0.78, rx: Math.round(pw * (isPortrait ? 0.09 : 0.062)), depth: Math.round(ph * 0.075), phase: 4.3, fall: false },
    ]

    const toriiMotes: Mote[] = []
    for (let i = 0; i < 22; i++) {
      toriiMotes.push({
        x: hash2(i, 1, 619) * pw,
        y: lerp(ph * 0.62, ph * 0.9, hash2(i, 2, 619)),
        phase: hash2(i, 3, 619) * TAU,
        speed: lerp(0.5, 1.4, hash2(i, 4, 619)),
      })
    }

    this.geo = {
      isPortrait,
      stars,
      forestLayers,
      orbiters,
      buildings,
      roofs,
      raindrops,
      tundraTrees,
      snowFlakes,
      islands,
      toriiMotes,
    }
  }

  // ── rendering ──────────────────────────────────────────────

  private draw() {
    if (!this.imgData || !this.geo) return
    const d = this.imgData.data
    const time = this.t

    switch (this.scene) {
      case 'forest': this.renderForest(d, time); break
      case 'space': this.renderSpace(d, time); break
      case 'lighthouse': this.renderLighthouse(d, time); break
      case 'skyline': this.renderSkyline(d, time); break
      case 'dunes': this.renderDunes(d, time); break
      case 'torii': this.renderTorii(d, time); break
      case 'rooftop': this.renderRooftop(d, time); break
      case 'aurora': this.renderAurora(d, time); break
      case 'pier': this.renderPier(d, time); break
      case 'islands': this.renderIslands(d, time); break
      case 'viaduct': this.renderViaduct(d, time); break
    }

    this.bctx.putImageData(this.imgData, 0, 0)
    this.ctx.setTransform(1, 0, 0, 1, 0, 0)
    this.ctx.imageSmoothingEnabled = false
    this.ctx.drawImage(this.buf, 0, 0, this.canvas.width, this.canvas.height)
    this.ctx.drawImage(this.grid, 0, 0)
  }

  private renderForest(d: Uint8ClampedArray, time: number) {
    const { pw, ph, dark, geo } = this
    if (!geo) return
    const pal = dark
      ? {
          mist: ['#9aa2aa', '#bcc3ca', '#dbe0e5', '#f1f4f7'].map(hexRgb),
          farTree: ['#121f1c', '#1a2d28', '#233c35'].map(hexRgb),
          midTree: ['#0c1714', '#13241e', '#1b3329'].map(hexRgb),
          nearTree: ['#060d0b', '#0b1612', '#11211b'].map(hexRgb),
          floor: ['#04070a', '#060c0e'].map(hexRgb),
        }
      : {
          mist: ['#dfe3e6', '#eaedf0', '#f4f6f8', '#fcfdfd'].map(hexRgb),
          farTree: ['#7a8f88', '#8ea39b', '#a3b6af'].map(hexRgb),
          midTree: ['#496157', '#5a7368', '#6e877c'].map(hexRgb),
          nearTree: ['#23362e', '#31473d', '#41594e'].map(hexRgb),
          floor: ['#182620', '#21332b'].map(hexRgb),
        }

    this.clearBg(d)
    if (dark) this.drawStars(d, geo.stars, time, ph * 0.72)
    this.drawMistBand(d, pal.mist, ph * 0.66, ph * 0.88, dark ? 0.16 : 0.52, time * 0.045, 801)
    const [L0, L1, L2] = geo.forestLayers
    for (const tr of L0.trees) this.drawPineTree(d, tr, pal.farTree, Math.sin(time * 0.5 + tr.x * 0.05) * 0.3)
    this.drawMistBand(d, pal.mist, ph * 0.73, ph * 0.92, dark ? 0.22 : 0.68, time * 0.08, 827)
    for (const tr of L1.trees) this.drawPineTree(d, tr, pal.midTree, Math.sin(time * 0.65 + tr.x * 0.06) * 0.45)
    this.drawMistBand(d, pal.mist, ph * 0.82, ph * 0.98, dark ? 0.14 : 0.46, time * 0.12, 853)
    for (let x = 0; x < pw; x++) {
      const hillY = Math.floor(ph * 0.9 + (fbm((x / pw) * 3.0, 9.1, 733, 2) - 0.5) * ph * 0.035)
      for (let y = hillY; y < ph; y++) {
        const col = pickDither(pal.nearTree, 0.18, x, y, 0.4)
        this.setPx(d, x, y, col[0], col[1], col[2])
      }
    }
    for (const tr of L2.trees) this.drawPineTree(d, tr, pal.nearTree, Math.sin(time * 0.8 + tr.x * 0.07) * 0.6)
    const floorTop = Math.floor(ph * 0.91)
    for (let y = floorTop; y < ph; y++) {
      const ny = (y - floorTop) / Math.max(1, ph - floorTop)
      for (let x = 0; x < pw; x++) {
        const wispGap = fbm((x / pw) * 4.5 - time * 0.1, (y / ph) * 5.5, 907, 2)
        const alpha = clamp(smoothstep(0.0, 0.72, ny + (wispGap - 0.5) * 0.16), 0, 1)
        if (alpha <= 0.03) continue
        const col = pickDither(pal.floor, clamp((1 - ny) * 0.5, 0, 1), x, y, 0.4)
        blendPixel(d, (y * pw + x) * 4, col, alpha)
      }
    }
  }

  private renderSpace(d: Uint8ClampedArray, time: number) {
    const { pw, ph, dark, geo, pointer, avoidBuf } = this
    if (!geo) return
    const pal = dark
      ? {
          ocean: ['#08101e', '#0c1c36', '#143059', '#1e467d'].map(hexRgb),
          land: ['#111e1a', '#1b342b', '#284d3c', '#3c6b52'].map(hexRgb),
          cloud: ['#2d3d4f', '#52687e', '#8aa2b8', '#c6d6e6'].map(hexRgb),
          atmo: ['#153d6e', '#2d72b8', '#5fa8e8'].map(hexRgb),
        }
      : {
          ocean: ['#dce8f5', '#c5dbf0', '#a9cae8', '#8bb6df'].map(hexRgb),
          land: ['#bdd3c4', '#9ec0aa', '#7ea98d', '#629073'].map(hexRgb),
          cloud: ['#e4edf5', '#edf3f8', '#f6f9fc', '#ffffff'].map(hexRgb),
          atmo: ['#9ac5eb', '#6ea8de', '#4589c9'].map(hexRgb),
        }

    this.clearBg(d)
    this.drawStars(d, geo.stars, time, ph * 0.85, 0.25)

    const sp = time % 10
    if (sp < 0.7) {
      const p = sp / 0.7
      const hx = Math.round(pw * (0.1 + p * 0.3))
      const hy = Math.round(ph * (0.09 + p * 0.1))
      for (let k = 0; k < 7; k++) {
        const fade = (1 - k / 7) * Math.sin(p * Math.PI)
        this.blendPx(d, hx - k, Math.round(hy - k * 0.35), dark ? [220, 234, 248] : [60, 88, 122], fade * 0.65)
      }
    }

    const cx = pw * 0.5
    const R = ph * 0.78
    const cy = ph * 1.56
    const Lx = -0.5
    const Ly = -0.7
    const Lz = 0.5
    const Ln = Math.hypot(Lx, Ly, Lz)
    const atmoThick = Math.max(4, Math.round(ph * 0.036))
    const yStart = Math.max(0, Math.floor(cy - R - atmoThick))

    for (let y = yStart; y < ph; y++) {
      for (let x = 0; x < pw; x++) {
        const dx = x - cx
        const dy = y - cy
        const dist = Math.hypot(dx, dy)
        const idx = (y * pw + x) * 4
        if (dist < R) {
          const nx = dx / R
          const ny = dy / R
          const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny))
          const light = clamp((nx * Lx + ny * Ly + nz * Lz) / Ln, 0, 1)
          const lon = Math.atan2(nx, nz) + time * 0.014
          const lat = Math.asin(clamp(ny, -1, 1))
          const landN = fbm(lon * 3.0 + 10, lat * 4.0 + 10, 7, 3)
          const cloudN = fbm(lon * 4.8 - time * 0.03, lat * 6.5, 9, 3)
          const botFade = dark ? smoothstep(ph * 1.02, ph * 0.8, y) : 1

          if (light > 0.04) {
            const col = cloudN > 0.63
              ? pickDither(pal.cloud, clamp(0.25 + light * 0.75, 0, 1), x, y, 0.55)
              : landN > 0.54
                ? pickDither(pal.land, clamp(0.2 + light * 0.8, 0, 1), x, y, 0.55)
                : pickDither(pal.ocean, clamp(0.2 + light * 0.8, 0, 1), x, y, 0.55)
            if (botFade < 0.99) blendPixel(d, idx, col, botFade)
            else {
              d[idx] = col[0]
              d[idx + 1] = col[1]
              d[idx + 2] = col[2]
            }
          } else {
            blendPixel(d, idx, dark ? [7, 11, 20] : [202, 218, 235], botFade)
            if (dark && landN > 0.56 && botFade > 0.2) {
              const city = hash2(Math.floor(lon * 46), Math.floor(lat * 46), 5)
              if (city > 0.91) {
                blendPixel(d, idx, [245, 195, 78], (0.35 + (0.5 + 0.5 * Math.sin(time * 1.8 + city * 30)) * 0.4) * botFade)
              }
            }
          }

          const rimDepth = (R - dist) / (atmoThick * 0.75)
          if (rimDepth < 1) {
            blendPixel(d, idx, pickDither(pal.atmo, clamp(0.35 + light * 0.65, 0, 1), x, y, 0.45), Math.pow(1 - rimDepth, 1.8) * (0.28 + light * 0.45))
          }
        } else if (dist < R + atmoThick) {
          const k = 1 - (dist - R) / atmoThick
          const alpha = Math.pow(k, 2.2) * (dark ? 0.52 : 0.36) * clamp(0.45 - (dx / R) * 0.55, 0.15, 1)
          if (alpha > 0.025) blendPixel(d, idx, pickDither(pal.atmo, clamp(k * 0.85, 0, 1), x, y, 0.45), alpha)
        }
      }
    }

    for (const o of geo.orbiters) {
      const rad = R + atmoThick + o.alt * ph * 0.85
      const ang = o.ang - Math.PI / 2 + time * 0.07 * Math.pow(R / rad, 1.4) * (o.kind ? 0.75 : 1)
      let ox = cx + Math.cos(ang) * rad * 1.15
      let oy = cy + Math.sin(ang) * rad * 0.72
      if (pointer.active) {
        const dx = ox - pointer.x
        const dy = oy - pointer.y
        const dd = Math.hypot(dx, dy)
        if (dd < 30 && dd > 0.5) {
          ox += (dx / dd) * (1 - dd / 30) * 11
          oy += (dy / dd) * (1 - dd / 30) * 11
        }
      }
      ox = Math.round(ox)
      oy = Math.round(oy)
      if (ox < 4 || ox >= pw - 4 || oy < 4 || oy >= ph - 4) continue
      if (avoidBuf && ox >= avoidBuf.x0 - 4 && ox <= avoidBuf.x1 + 4 && oy >= avoidBuf.y0 - 2 && oy <= avoidBuf.y1 + 2) continue

      if (o.kind === 1) {
        const panel: RGB = dark ? [65, 125, 200] : [55, 110, 175]
        const hull: RGB = dark ? [205, 218, 232] : [55, 68, 84]
        const blink: RGB = Math.floor(time * 2) % 2 ? [230, 88, 88] : [74, 210, 128]
        for (const dx of [-3, -2, 2, 3]) this.setPx(d, ox + dx, oy, panel[0], panel[1], panel[2])
        for (const dx of [-1, 0, 1]) this.setPx(d, ox + dx, oy, hull[0], hull[1], hull[2])
        this.setPx(d, ox, oy - 1, blink[0], blink[1], blink[2])
      } else if (o.kind === 2) {
        const wing: RGB = dark ? [90, 170, 230] : [45, 115, 185]
        const core: RGB = dark ? [230, 195, 75] : [185, 130, 20]
        this.setPx(d, ox - 1, oy, wing[0], wing[1], wing[2])
        this.setPx(d, ox, oy, core[0], core[1], core[2])
        this.setPx(d, ox + 1, oy, wing[0], wing[1], wing[2])
      } else {
        this.blendPx(d, ox, oy, dark ? [190, 204, 220] : [90, 106, 126], 0.42)
      }
    }
  }

  private renderLighthouse(d: Uint8ClampedArray, time: number) {
    const { pw, ph, dark, geo } = this
    if (!geo) return
    this.clearBg(d)
    const seaY = Math.floor(ph * 0.8)
    if (dark) this.drawStars(d, geo.stars, time, seaY - 4)

    const lhX = Math.round(pw * (geo.isPortrait ? 0.76 : 0.79))
    const rockTop = seaY - Math.round(ph * 0.045)
    const towerH = Math.round(ph * 0.11)
    const lampY = rockTop - towerH

    const sweep = Math.sin(time * 0.65)
    const beamDir = sweep < 0 ? -1 : 1
    const beamLen = pw * (0.28 + 0.18 * Math.abs(sweep))
    const beamColor: RGB = dark ? [252, 232, 165] : [215, 172, 72]
    const beamStrength = (dark ? 0.24 : 0.16) * (0.35 + 0.65 * Math.abs(sweep))
    for (let y = Math.max(0, lampY - 22); y < seaY; y++) {
      for (let x = 0; x < pw; x++) {
        const dx = (x - lhX) * beamDir
        if (dx <= 1 || dx > beamLen) continue
        const dy = y - (lampY + 1) + dx * 0.06
        const halfSpread = 1.5 + dx * 0.13
        const dist = Math.abs(dy)
        if (dist < halfSpread) {
          const fade = (1 - dx / beamLen) * (1 - dist / halfSpread)
          this.blendPx(d, x, y, beamColor, fade * fade * beamStrength)
        }
      }
    }

    const seaPal = dark
      ? ['#07101c', '#0b1829', '#11243b', '#193452'].map(hexRgb)
      : ['#d4e1ed', '#bfd2e4', '#a6c0d9', '#8caac9'].map(hexRgb)
    const crestCol: RGB = dark ? [130, 170, 210] : [248, 251, 255]

    for (let y = seaY; y < ph; y++) {
      const ny = (y - seaY) / Math.max(1, ph - seaY)
      const speed = 0.5 + ny * 1.4
      for (let x = 0; x < pw; x++) {
        const wave = Math.sin(x * 0.16 + time * speed + y * 0.55) * 0.5 + 0.5
        const foam = fbm(x * 0.18 - time * 0.22 * (0.5 + ny), y * 0.45, 711, 2)
        const col = pickDither(seaPal, clamp(0.18 + (1 - ny) * 0.55 + (wave - 0.5) * 0.25, 0, 1), x, y, 0.5)
        this.setPx(d, x, y, col[0], col[1], col[2])
        if (wave > 0.84 && foam > 0.56) {
          this.blendPx(d, x, y, crestCol, (dark ? 0.3 : 0.48) * (0.4 + ny * 0.6))
        }
        const rdx = Math.abs(x - lhX - Math.sin(time * 2 + y * 0.6) * 1.2)
        if (rdx < 2 + ny * 4 && hash2(x, Math.floor(y + time * 4), 719) > 0.55) {
          this.blendPx(d, x, y, beamColor, (1 - ny) * (dark ? 0.32 : 0.2))
        }
      }
    }

    const rockCol: RGB = dark ? [14, 18, 26] : [58, 68, 82]
    const rockHi: RGB = dark ? [26, 33, 46] : [86, 98, 114]
    for (let x = lhX - 18; x < Math.min(pw, lhX + 26); x++) {
      const dist = Math.abs(x - lhX)
      const mound = Math.round(Math.exp(-(dist * dist) / 140) * (seaY - rockTop + 2))
      const crag = Math.round((fbm(x * 0.25, 1.2, 727, 2) - 0.5) * 3)
      const top = seaY - Math.max(0, mound + crag)
      for (let y = top; y <= seaY + 2; y++) {
        const c = y === top ? rockHi : rockCol
        this.setPx(d, x, y, c[0], c[1], c[2])
      }
    }

    const bodyLight: RGB = dark ? [208, 216, 226] : [235, 240, 246]
    const bodyStripe: RGB = dark ? [145, 58, 58] : [180, 68, 62]
    const capCol: RGB = dark ? [30, 38, 52] : [45, 56, 72]
    for (let dy = 0; dy < towerH; dy++) {
      const y = lampY + 2 + dy
      const halfW = Math.round(lerp(1.4, 3.0, dy / towerH))
      const c = Math.floor(dy / 4) % 2 === 1 ? bodyStripe : bodyLight
      for (let dx = -halfW; dx <= halfW; dx++) {
        const shade = dx > 0 ? 0.78 : 1.0
        this.setPx(d, lhX + dx, y, Math.round(c[0] * shade), Math.round(c[1] * shade), Math.round(c[2] * shade))
      }
    }
    for (let dx = -2; dx <= 2; dx++) this.setPx(d, lhX + dx, lampY + 2, capCol[0], capCol[1], capCol[2])
    for (let dx = -1; dx <= 1; dx++) this.setPx(d, lhX + dx, lampY + 1, 255, 238, 175)
    for (let dx = -1; dx <= 1; dx++) this.setPx(d, lhX + dx, lampY, capCol[0], capCol[1], capCol[2])
    this.setPx(d, lhX, lampY - 1, capCol[0], capCol[1], capCol[2])

    if (!dark) {
      for (let i = 0; i < 2; i++) {
        const gx = Math.round(((time * (5 + i * 2) + i * 75) % (pw + 20)) - 10)
        const gy = Math.round(ph * (0.64 + i * 0.05) + Math.sin(time * 2 + i) * 2)
        const flap = Math.sin(time * 5 + i * 3) > 0 ? -1 : 0
        this.setPx(d, gx, gy, 80, 95, 112)
        this.setPx(d, gx - 1, gy + flap, 80, 95, 112)
        this.setPx(d, gx + 1, gy + flap, 80, 95, 112)
      }
    }
  }

  private renderSkyline(d: Uint8ClampedArray, time: number) {
    const { pw, ph, dark, geo } = this
    if (!geo) return
    this.clearBg(d)
    const waterY = Math.floor(ph * 0.86)
    if (dark) this.drawStars(d, geo.stars, time, waterY - 8)

    const glowCol: RGB = dark ? [32, 48, 72] : [205, 218, 232]
    for (let y = Math.floor(ph * 0.72); y < waterY; y++) {
      const k = (y - ph * 0.72) / Math.max(1, waterY - ph * 0.72)
      for (let x = 0; x < pw; x++) this.blendPx(d, x, y, glowCol, k * k * (dark ? 0.3 : 0.25))
    }

    const bPal = dark ? ['#0b1019', '#111826', '#182133'].map(hexRgb) : ['#758496', '#5e6d80', '#475569'].map(hexRgb)
    const litCols: { x: number; col: RGB; dist: number }[] = []

    for (const b of geo.buildings) {
      const top = waterY - b.h
      const baseC = bPal[Math.floor(b.shade * bPal.length) % bPal.length]
      for (let y = top; y < waterY; y++) {
        for (let x = b.x; x < Math.min(pw, b.x + b.w); x++) {
          const edge = x === b.x ? 1.12 : 1.0
          this.setPx(d, x, y, Math.min(255, Math.round(baseC[0] * edge)), Math.min(255, Math.round(baseC[1] * edge)), Math.min(255, Math.round(baseC[2] * edge)))
        }
      }
      if (b.spire) {
        const sx = b.x + Math.floor(b.w / 2)
        for (let k = 1; k <= b.spire; k++) this.setPx(d, sx, top - k, baseC[0], baseC[1], baseC[2])
        if (b.beacon && Math.sin(time * 2.4 + b.x) > 0.25) this.setPx(d, sx, top - b.spire - 1, 235, 82, 82)
      }
      for (const w of b.wins) {
        if (Math.sin(time * 0.15 + w.phase) <= -0.65) continue
        const wx = b.x + w.dx
        const wy = top + w.dy
        const wc: RGB = dark
          ? w.warm ? [246, 204, 112] : [132, 206, 245]
          : w.warm ? [232, 200, 128] : [206, 224, 240]
        this.setPx(d, wx, wy, wc[0], wc[1], wc[2])
        if (wx >= 0 && wx < pw) litCols.push({ x: wx, col: wc, dist: waterY - wy })
      }
    }

    const waterPal = dark ? ['#070d17', '#0a1322', '#0f1b30'].map(hexRgb) : ['#cbd7e4', '#b9c9da', '#a6bad0'].map(hexRgb)
    for (let y = waterY; y < ph; y++) {
      const ny = (y - waterY) / Math.max(1, ph - waterY)
      for (let x = 0; x < pw; x++) {
        const col = pickDither(waterPal, clamp(0.2 + ny * 0.6, 0, 1), x, y, 0.45)
        this.setPx(d, x, y, col[0], col[1], col[2])
      }
    }
    for (const lc of litCols) {
      const ry = waterY + Math.min(ph - waterY - 1, Math.round(lc.dist * 0.55))
      const wob = Math.round(Math.sin(time * 2.0 + ry * 0.7 + lc.x * 0.2) * 1.1)
      const fade = 1 - (ry - waterY) / Math.max(1, ph - waterY)
      this.blendPx(d, lc.x + wob, ry, lc.col, fade * (dark ? 0.48 : 0.3))
    }
  }

  private renderDunes(d: Uint8ClampedArray, time: number) {
    const { pw, ph, dark, geo } = this
    if (!geo) return
    this.clearBg(d)
    if (dark) this.drawStars(d, geo.stars, time, ph * 0.76)

    const mx = Math.round(pw * 0.16)
    const my = Math.round(ph * 0.2)
    const mr = Math.max(5, Math.round(Math.min(pw, ph) * 0.045))
    const moonCol: RGB = dark ? [236, 232, 214] : [148, 138, 122]
    for (let dy = -mr; dy <= mr; dy++) {
      for (let dx = -mr; dx <= mr; dx++) {
        if (Math.hypot(dx, dy) <= mr && Math.hypot(dx - mr * 0.48, dy + mr * 0.12) > mr * 0.86) {
          this.blendPx(d, mx + dx, my + dy, moonCol, dark ? 0.88 : 0.45)
        }
      }
    }

    const layers = dark
      ? [
          { base: ph * 0.8, amp: ph * 0.045, freq: 2.1, phase: 0.4, lit: ['#232a3d', '#2e3852'].map(hexRgb), sh: ['#111624', '#181f30'].map(hexRgb) },
          { base: ph * 0.87, amp: ph * 0.052, freq: 1.7, phase: 2.3, lit: ['#1a2133', '#242e45'].map(hexRgb), sh: ['#0c101b', '#121826'].map(hexRgb) },
          { base: ph * 0.94, amp: ph * 0.042, freq: 2.4, phase: 4.1, lit: ['#131826', '#1b2235'].map(hexRgb), sh: ['#070a12', '#0c101b'].map(hexRgb) },
        ]
      : [
          { base: ph * 0.8, amp: ph * 0.045, freq: 2.1, phase: 0.4, lit: ['#e4d8c3', '#ede3d2'].map(hexRgb), sh: ['#cbbca2', '#d7c9b1'].map(hexRgb) },
          { base: ph * 0.87, amp: ph * 0.052, freq: 1.7, phase: 2.3, lit: ['#d5c4a7', '#e0d1b8'].map(hexRgb), sh: ['#b6a384', '#c5b395'].map(hexRgb) },
          { base: ph * 0.94, amp: ph * 0.042, freq: 2.4, phase: 4.1, lit: ['#bfa988', '#ccb798'].map(hexRgb), sh: ['#9c8768', '#ae9979'].map(hexRgb) },
        ]

    for (let li = 0; li < layers.length; li++) {
      const L = layers[li]
      for (let x = 0; x < pw; x++) {
        const nx = x / pw
        const wave = Math.sin(nx * Math.PI * L.freq + L.phase)
        const slope = Math.cos(nx * Math.PI * L.freq + L.phase)
        const yTop = Math.floor(L.base - wave * L.amp)
        const isLit = slope > 0
        for (let y = Math.max(0, yTop); y < ph; y++) {
          const depth = (y - yTop) / Math.max(1, ph * 0.14)
          const ripple = Math.sin(y * 1.1 + x * 0.18) * 0.12
          const col = pickDither(isLit ? L.lit : L.sh, clamp(1 - depth + ripple, 0, 1), x, y, 0.5)
          this.setPx(d, x, y, col[0], col[1], col[2])
        }
        if (wave > 0.72) {
          const wisp = fbm(nx * 10 - time * (0.45 + li * 0.15), li * 3.1, 751, 2)
          if (wisp > 0.56) this.blendPx(d, x, yTop - 1, L.lit[1], (wisp - 0.55) * 1.2)
        }
      }
    }
  }

  private renderTorii(d: Uint8ClampedArray, time: number) {
    const { pw, ph, dark, geo } = this
    if (!geo) return
    this.clearBg(d)
    const waterY = Math.floor(ph * 0.84)
    if (dark) this.drawStars(d, geo.stars, time, waterY - 8)

    const waterPal = dark ? ['#08101c', '#0c1829', '#122238'].map(hexRgb) : ['#dbe4ee', '#cad7e5', '#b9cadb'].map(hexRgb)
    for (let y = waterY; y < ph; y++) {
      const ny = (y - waterY) / Math.max(1, ph - waterY)
      for (let x = 0; x < pw; x++) {
        const rip = Math.sin(x * 0.25 + time * 1.1 + y * 0.8) * 0.15
        const col = pickDither(waterPal, clamp(0.25 + ny * 0.5 + rip, 0, 1), x, y, 0.45)
        this.setPx(d, x, y, col[0], col[1], col[2])
      }
    }

    const tx = Math.round(pw * (geo.isPortrait ? 0.72 : 0.74))
    const th = Math.round(ph * 0.14)
    const span = Math.round(th * 0.72)
    const pillarCol: RGB = dark ? [138, 48, 48] : [168, 56, 52]
    const capCol: RGB = dark ? [28, 22, 26] : [48, 38, 42]
    const baseCol: RGB = dark ? [20, 24, 32] : [58, 66, 76]

    const drawToriiAt = (yOrigin: number, flip: boolean, alpha: number) => {
      const putT = (x: number, y: number, col: RGB) => {
        const wob = flip ? Math.round(Math.sin(time * 2.2 + y * 0.7) * 0.9) : 0
        if (flip) this.blendPx(d, x + wob, y, col, alpha)
        else this.setPx(d, x, y, col[0], col[1], col[2])
      }
      const mapY = (dy: number) => (flip ? yOrigin + Math.round(dy * 0.65) : yOrigin - dy)
      const pOff = Math.round(span * 0.44)
      for (let dy = 0; dy < th; dy++) {
        const y = mapY(dy)
        const col = dy < 3 ? baseCol : pillarCol
        putT(tx - pOff, y, col)
        putT(tx - pOff + 1, y, col)
        putT(tx + pOff, y, col)
        putT(tx + pOff - 1, y, col)
      }
      const nukiDy = Math.round(th * 0.74)
      for (let dx = -Math.round(span * 0.68); dx <= Math.round(span * 0.68); dx++) {
        putT(tx + dx, mapY(nukiDy), pillarCol)
      }
      for (let dy = nukiDy; dy < th - 1; dy++) {
        putT(tx, mapY(dy), capCol)
        putT(tx + 1, mapY(dy), capCol)
      }
      const topSpan = Math.round(span * 0.86)
      for (let dx = -topSpan; dx <= topSpan; dx++) {
        const curve = Math.round(Math.pow(dx / topSpan, 2) * 2.2)
        putT(tx + dx, mapY(th - 1 + curve), pillarCol)
        putT(tx + dx, mapY(th + curve), capCol)
      }
    }

    drawToriiAt(waterY, true, dark ? 0.36 : 0.28)
    drawToriiAt(waterY, false, 1)

    const mistPal = dark ? ['#a2aab2', '#cfd5db', '#eceff2'].map(hexRgb) : ['#e4e9ee', '#eff3f6', '#fafcfd'].map(hexRgb)
    this.drawMistBand(d, mistPal, waterY - 8, waterY + 5, dark ? 0.18 : 0.46, time * 0.06, 641)

    for (const m of geo.toriiMotes) {
      const mx = Math.round((m.x + time * (dark ? 1.5 : 4.0) + Math.sin(time * m.speed + m.phase) * 3) % pw)
      const my = Math.round(m.y + Math.cos(time * m.speed + m.phase) * 2)
      if (dark) {
        const glow = Math.pow(Math.max(0, Math.sin(time * 1.4 + m.phase)), 3)
        if (glow > 0.1) this.blendPx(d, mx, my, [252, 224, 108], glow * 0.8)
      } else {
        this.blendPx(d, mx, my, [225, 165, 178], 0.55)
      }
    }
  }

  private renderRooftop(d: Uint8ClampedArray, time: number) {
    const { pw, ph, dark, geo } = this
    if (!geo) return
    this.clearBg(d)
    const rainCol: RGB = dark ? [138, 162, 190] : [96, 114, 136]
    const roofCol: RGB = dark ? [10, 14, 22] : [52, 62, 76]
    const edgeCol: RGB = dark ? [24, 32, 46] : [82, 94, 112]
    const winCol: RGB = dark ? [245, 198, 102] : [220, 176, 84]

    for (const r of geo.raindrops) {
      const y = (r.y + time * r.speed) % ph
      const x = (r.x + time * r.speed * 0.16) % pw
      for (let k = 0; k < r.len; k++) {
        this.blendPx(d, Math.round(x - k * 0.16), Math.round(y - k), rainCol, (1 - k / r.len) * (dark ? 0.28 : 0.22))
      }
    }

    for (const rf of geo.roofs) {
      const top = ph - rf.h
      for (let y = top; y < ph; y++) {
        for (let x = rf.x; x < Math.min(pw, rf.x + rf.w); x++) {
          const c = y === top ? edgeCol : roofCol
          this.setPx(d, x, y, c[0], c[1], c[2])
        }
      }
      for (let wy = top + 4; wy < ph - 3; wy += 5) {
        for (let wx = rf.x + 4; wx < Math.min(pw - 2, rf.x + rf.w - 4); wx += 6) {
          if (hash2(wx, wy, rf.seed) > 0.72) {
            this.blendPx(d, wx, wy, winCol, dark ? 0.78 : 0.45)
            this.blendPx(d, wx + 1, wy, winCol, dark ? 0.78 : 0.45)
          }
        }
      }
      if (rf.chimney) {
        const cx = rf.x + 4
        for (let y = top - 4; y < top; y++) {
          this.setPx(d, cx, y, roofCol[0], roofCol[1], roofCol[2])
          this.setPx(d, cx + 1, y, roofCol[0], roofCol[1], roofCol[2])
        }
      }
      if (rf.antenna) {
        const ax = rf.x + Math.floor(rf.w * 0.65)
        for (let k = 1; k <= 10; k++) this.setPx(d, ax, top - k, edgeCol[0], edgeCol[1], edgeCol[2])
        for (let dx = -3; dx <= 3; dx++) this.setPx(d, ax + dx, top - 8, edgeCol[0], edgeCol[1], edgeCol[2])
        for (let dx = -2; dx <= 2; dx++) this.setPx(d, ax + dx, top - 5, edgeCol[0], edgeCol[1], edgeCol[2])
      }
      if (rf.waterTower && rf.w > 20) {
        const wx = rf.x + Math.floor(rf.w * 0.5)
        for (let y = top - 9; y < top - 4; y++) {
          for (let dx = -3; dx <= 3; dx++) this.setPx(d, wx + dx, y, roofCol[0], roofCol[1], roofCol[2])
        }
        for (let y = top - 4; y < top; y++) {
          this.setPx(d, wx - 2, y, edgeCol[0], edgeCol[1], edgeCol[2])
          this.setPx(d, wx + 2, y, edgeCol[0], edgeCol[1], edgeCol[2])
        }
      }
      const spX = rf.x + Math.floor(hash2(Math.floor(time * 6), rf.seed, 353) * rf.w)
      this.blendPx(d, spX, top - 1, rainCol, 0.45)
    }
  }

  private renderAurora(d: Uint8ClampedArray, time: number) {
    const { pw, ph, dark, geo } = this
    if (!geo) return
    this.clearBg(d)
    if (dark) {
      this.drawStars(d, geo.stars, time, ph * 0.8)
      for (let x = 0; x < pw; x++) {
        const nx = x / pw
        const wave = Math.sin(nx * 5.2 + time * 0.25) * 0.05 + Math.cos(nx * 9.0 - time * 0.18) * 0.025
        const baseH = ph * (0.64 + wave)
        const curtainH = ph * (0.2 + 0.08 * Math.sin(nx * 3.5 - time * 0.2))
        const colIntensity = clamp(fbm(nx * 4.5 + time * 0.06, 1.4, 461, 3) * 1.4 - 0.35, 0, 1)
        if (colIntensity <= 0.05) continue
        for (let y = Math.max(0, Math.ceil(baseH - curtainH)); y < Math.floor(baseH); y++) {
          const k = clamp((baseH - y) / curtainH, 0, 1)
          const env = Math.pow(Math.max(0, Math.sin(k * Math.PI)), 1.2) * (1 - k * 0.35)
          const col: RGB = [Math.round(lerp(62, 135, k)), Math.round(lerp(228, 120, k)), Math.round(lerp(182, 232, k))]
          this.blendPx(d, x, y, col, env * colIntensity * 0.36)
        }
      }
    } else {
      for (const f of geo.snowFlakes) {
        const fx = Math.round((f.x + Math.sin(time * 0.9 + f.phase) * 5 + pw) % pw)
        const fy = Math.round((f.y + time * f.speed) % (ph * 0.88))
        this.blendPx(d, fx, fy, [155, 174, 195], 0.42)
      }
    }

    const treePal = dark ? ['#0d1822', '#152533', '#1e3345'].map(hexRgb) : ['#6a7d8a', '#7f93a1', '#97aab8'].map(hexRgb)
    for (const tr of geo.tundraTrees) this.drawPineTree(d, tr, treePal, Math.sin(time * 0.5 + tr.x * 0.05) * 0.25)

    const snowPal = dark
      ? ['#131d2b', '#1c2a3d', '#283c54', '#385270'].map(hexRgb)
      : ['#cfd9e4', '#dde5ee', '#eaf0f6', '#f7fafc'].map(hexRgb)
    for (let x = 0; x < pw; x++) {
      const nx = x / pw
      const drift = Math.sin(nx * 4.5 + 0.6) * ph * 0.025 + (fbm(nx * 4.0, 2.2, 467, 2) - 0.5) * ph * 0.03
      const top = Math.floor(ph * 0.87 + drift)
      for (let y = top; y < ph; y++) {
        const ny = (y - top) / Math.max(1, ph - top)
        const col = pickDither(snowPal, clamp(0.95 - ny * 0.7, 0, 1), x, y, 0.5)
        this.setPx(d, x, y, col[0], col[1], col[2])
      }
    }
  }

  private renderPier(d: Uint8ClampedArray, time: number) {
    const { pw, ph, dark, geo } = this
    if (!geo) return
    this.clearBg(d)
    const seaY = Math.floor(ph * 0.8)
    if (dark) this.drawStars(d, geo.stars, time, seaY - 4)

    const pierEnd = Math.round(pw * (geo.isPortrait ? 0.44 : 0.34))
    const deckY = seaY - 4
    const postX = pierEnd - 3
    const lampX = postX + 2
    const lampY = deckY - 9
    const lampCol: RGB = [252, 212, 118]

    const haloR = 16
    for (let dy = -haloR; dy <= haloR; dy++) {
      for (let dx = -haloR; dx <= haloR; dx++) {
        const dist = Math.hypot(dx, dy)
        if (dist > haloR) continue
        const k = 1 - dist / haloR
        this.blendPx(d, lampX + dx, lampY + dy, lampCol, k * k * (dark ? 0.3 : 0.16))
      }
    }

    const seaPal = dark ? ['#070f1b', '#0b182a', '#11233b'].map(hexRgb) : ['#d4e0ec', '#c0d1e2', '#abc1d7'].map(hexRgb)
    for (let y = seaY; y < ph; y++) {
      const ny = (y - seaY) / Math.max(1, ph - seaY)
      for (let x = 0; x < pw; x++) {
        const rip = Math.sin(x * 0.22 + time * 1.0 + y * 0.7) * 0.15
        const col = pickDither(seaPal, clamp(0.2 + (1 - ny) * 0.45 + rip, 0, 1), x, y, 0.45)
        this.setPx(d, x, y, col[0], col[1], col[2])
      }
    }

    for (let y = seaY; y < ph; y++) {
      const ny = (y - seaY) / Math.max(1, ph - seaY)
      const wob = Math.round(Math.sin(time * 2.4 + y * 0.8) * (1 + ny * 2))
      const halfW = Math.round(1 + ny * 3)
      for (let dx = -halfW; dx <= halfW; dx++) {
        if (hash2(lampX + dx, Math.floor(y + time * 3), 563) > 0.35) {
          const a = (1 - Math.abs(dx) / (halfW + 1)) * (1 - ny * 0.85) * (dark ? 0.55 : 0.32)
          this.blendPx(d, lampX + wob + dx, y, lampCol, a)
        }
      }
    }

    const woodDark: RGB = dark ? [16, 18, 24] : [54, 58, 66]
    const woodTop: RGB = dark ? [34, 38, 48] : [86, 92, 102]
    for (let x = 4; x <= pierEnd - 2; x += 10) {
      for (let y = deckY - 1; y < Math.min(ph, seaY + 8); y++) {
        this.setPx(d, x, y, woodDark[0], woodDark[1], woodDark[2])
        this.setPx(d, x + 1, y, woodDark[0], woodDark[1], woodDark[2])
      }
    }
    for (let x = 0; x <= pierEnd; x++) {
      this.setPx(d, x, deckY, woodTop[0], woodTop[1], woodTop[2])
      this.setPx(d, x, deckY + 1, woodDark[0], woodDark[1], woodDark[2])
    }

    for (let y = lampY - 2; y <= deckY; y++) this.setPx(d, postX, y, woodTop[0], woodTop[1], woodTop[2])
    this.setPx(d, postX + 1, lampY - 2, woodTop[0], woodTop[1], woodTop[2])
    this.setPx(d, postX + 2, lampY - 2, woodTop[0], woodTop[1], woodTop[2])
    this.setPx(d, lampX, lampY - 1, woodTop[0], woodTop[1], woodTop[2])
    this.setPx(d, lampX, lampY, 255, 232, 152)
    this.setPx(d, lampX, lampY + 1, 242, 182, 78)
  }

  private renderIslands(d: Uint8ClampedArray, time: number) {
    const { ph, dark, geo } = this
    if (!geo) return
    this.clearBg(d)
    if (dark) this.drawStars(d, geo.stars, time, ph * 0.85)

    const grassPal = dark ? ['#1b382c', '#2a5240', '#3d6e56'].map(hexRgb) : ['#5e8a70', '#75a387', '#90bd9f'].map(hexRgb)
    const rockPal = dark ? ['#131824', '#1d2436', '#2b344c'].map(hexRgb) : ['#647082', '#7d8a9c', '#98a4b5'].map(hexRgb)
    const waterCol: RGB = dark ? [108, 178, 228] : [115, 168, 218]
    const mistPal = dark ? ['#a2aab2', '#cfd5db', '#eceff2'].map(hexRgb) : ['#e4e9ee', '#eff3f6', '#fafcfd'].map(hexRgb)

    this.drawMistBand(d, mistPal, ph * 0.86, ph, dark ? 0.14 : 0.45, time * 0.05, 881)

    for (const isl of geo.islands) {
      const bob = Math.round(Math.sin(time * 0.75 + isl.phase) * 1.6)
      const cx = Math.round(isl.cx)
      const cy = Math.round(isl.cy + bob)

      for (let dx = -isl.rx; dx <= isl.rx; dx++) {
        const nx = dx / isl.rx
        const profile = Math.pow(Math.max(0, 1 - nx * nx), 0.7)
        const crag = (fbm((cx + dx) * 0.22, isl.phase, 887, 2) - 0.5) * 4
        const bottom = Math.round(cy + Math.max(1, profile * isl.depth + crag))
        const top = Math.round(cy - Math.max(0, (1 - nx * nx) * 2.2))
        for (let y = top; y <= bottom; y++) {
          const isGrass = y - top <= 2
          const shade = clamp(0.75 - ((y - top) / Math.max(1, bottom - top)) * 0.65 - (dx > 0 ? 0.2 : 0), 0, 1)
          const col = pickDither(isGrass ? grassPal : rockPal, shade, cx + dx, y, 0.45)
          this.setPx(d, cx + dx, y, col[0], col[1], col[2])
        }
      }

      this.drawPineTree(
        d,
        { x: cx - Math.round(isl.rx * 0.25), base: cy - 1, h: Math.max(6, Math.round(isl.depth * 0.7)), w: 7, seed: Math.round(isl.phase * 100) },
        grassPal,
        Math.sin(time * 0.8 + isl.phase) * 0.4,
      )

      if (isl.fall) {
        const fx = cx + Math.round(isl.rx * 0.28)
        for (let y = cy + 1; y < ph; y++) {
          const k = (y - cy) / Math.max(1, ph - cy)
          const fade = clamp(1 - k * 1.15, 0, 1)
          const shimmer = Math.sin(y * 0.9 - time * 8 + isl.phase) > 0 ? 1 : 0.65
          this.blendPx(d, fx, y, waterCol, fade * shimmer * (dark ? 0.75 : 0.65))
          this.blendPx(d, fx + 1, y, [230, 244, 255], fade * (1 - shimmer) * 0.45)
        }
      }
    }
  }

  private renderViaduct(d: Uint8ClampedArray, time: number) {
    const { pw, ph, dark, geo } = this
    if (!geo) return
    this.clearBg(d)
    const bridgeY = Math.floor(ph * 0.82)
    const waterY = Math.floor(ph * 0.92)
    if (dark) this.drawStars(d, geo.stars, time, bridgeY - 6)

    const waterPal = dark ? ['#070d17', '#0b1424'].map(hexRgb) : ['#cedae6', '#bccbd9'].map(hexRgb)
    for (let y = waterY; y < ph; y++) {
      for (let x = 0; x < pw; x++) {
        const col = pickDither(waterPal, (y - waterY) / Math.max(1, ph - waterY), x, y, 0.4)
        this.setPx(d, x, y, col[0], col[1], col[2])
      }
    }

    const stoneDark: RGB = dark ? [16, 21, 32] : [74, 84, 98]
    const stoneTop: RGB = dark ? [32, 40, 56] : [102, 114, 130]
    const span = 22
    for (let x = 0; x < pw; x++) {
      const local = ((x % span) + span) % span
      const archDx = (local - span / 2) / (span * 0.38)
      const inArch = Math.abs(archDx) < 1
      const archTop = inArch ? bridgeY + 3 + Math.round((1 - Math.sqrt(1 - archDx * archDx)) * 5) : waterY
      for (let y = bridgeY; y < waterY; y++) {
        if (y < archTop || !inArch) {
          const c = y === bridgeY ? stoneTop : stoneDark
          this.setPx(d, x, y, c[0], c[1], c[2])
        }
      }
    }

    const cycle = time % 11
    if (cycle < 7.5) {
      const headX = Math.round(lerp(-10, pw + 75, cycle / 7.5))
      const carLen = 12
      const cars = 4
      const bodyCol: RGB = dark ? [40, 52, 70] : [54, 66, 84]
      const winCol: RGB = [252, 214, 112]
      for (let c = 0; c < cars; c++) {
        const cx0 = headX - c * (carLen + 2) - carLen
        for (let dx = 0; dx < carLen; dx++) {
          const x = cx0 + dx
          if (x < 0 || x >= pw) continue
          this.setPx(d, x, bridgeY - 1, bodyCol[0], bodyCol[1], bodyCol[2])
          this.setPx(d, x, bridgeY - 2, bodyCol[0], bodyCol[1], bodyCol[2])
          this.setPx(d, x, bridgeY - 3, bodyCol[0], bodyCol[1], bodyCol[2])
          if (dx >= 2 && dx <= carLen - 3 && dx % 2 === 0) {
            this.setPx(d, x, bridgeY - 2, winCol[0], winCol[1], winCol[2])
            for (let ry = waterY + 1; ry < ph; ry += 2) {
              const wob = Math.round(Math.sin(time * 3 + ry) * 0.8)
              this.blendPx(d, x + wob, ry, winCol, (1 - (ry - waterY) / Math.max(1, ph - waterY)) * (dark ? 0.35 : 0.22))
            }
          }
        }
      }
      for (let k = 1; k <= 10; k++) {
        this.blendPx(d, headX + k, bridgeY - 1, [255, 236, 160], (1 - k / 10) * (dark ? 0.55 : 0.3))
      }
    }
  }
}
