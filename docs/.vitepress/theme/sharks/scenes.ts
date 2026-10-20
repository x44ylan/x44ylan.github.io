import { clamp, hash3, rand, TAU } from "./math";
import { paintGrid } from "./renderer";
import type { AvoidRect } from "./world";

export const SCENE_THEMES = ["train", "fireflies", "rain", "debris"] as const;
export type SceneTheme = (typeof SCENE_THEMES)[number];

type Part = { x: number; y: number; vx: number; vy: number; a: number; b: number; c: number };
type Ping = { x: number; y: number; t: number };

const STEP = 1 / 60;

export class SceneEngine {
  private ctx: CanvasRenderingContext2D;
  private bg: HTMLCanvasElement;
  private dpr = 1;
  private W = 0;
  private H = 0;
  private cw = 12;
  private ch = 18;
  private cols = 0;
  private rows = 0;
  private font: string;
  private raf = 0;
  private last = 0;
  private t = 0;
  private visible = true;
  private disposed = false;
  private avoid: AvoidRect | null = null;
  private pointer = { x: 0, y: 0, active: false };
  private parts: Part[] = [];
  private pings: Ping[] = [];
  private reduced: MediaQueryList;
  private ro: ResizeObserver;
  private io: IntersectionObserver;

  constructor(private canvas: HTMLCanvasElement, private theme: SceneTheme, private dark = true) {
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("2D canvas unavailable");
    this.ctx = ctx;
    this.bg = document.createElement("canvas");
    this.font = getComputedStyle(canvas).fontFamily || "monospace";
    this.reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
    this.io = new IntersectionObserver(([e]) => { this.visible = e.isIntersecting; this.schedule(); });
    this.io.observe(canvas);
    this.reduced.addEventListener("change", this.onMotion);
    window.addEventListener("pointermove", this.onMove, { passive: true });
    window.addEventListener("pointerdown", this.onDown, { passive: true });
    window.addEventListener("blur", this.onLeave);
    document.documentElement.addEventListener("pointerleave", this.onLeave);
    this.resize();
    document.fonts?.load(`600 16px ${this.font}`).then(() => { if (!this.disposed) this.draw(); });
    this.schedule();
  }

  setTheme(dark: boolean) {
    this.dark = dark;
    this.paintBg();
    this.draw();
  }

  setAvoidRect(rect: AvoidRect | null) {
    this.avoid = rect;
    this.draw();
  }

  destroy() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.io.disconnect();
    this.reduced.removeEventListener("change", this.onMotion);
    window.removeEventListener("pointermove", this.onMove);
    window.removeEventListener("pointerdown", this.onDown);
    window.removeEventListener("blur", this.onLeave);
    document.documentElement.removeEventListener("pointerleave", this.onLeave);
  }

  // ── lifecycle ──────────────────────────────────────────────

  private resize() {
    const r = this.canvas.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    this.W = r.width;
    this.H = r.height;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.cw = clamp(Math.round(this.W / 124), 8, 13);
    this.ch = Math.round(this.cw * 1.45);
    this.cols = Math.ceil(this.W / this.cw);
    this.rows = Math.ceil(this.H / this.ch);
    this.canvas.width = Math.round(this.W * this.dpr);
    this.canvas.height = Math.round(this.H * this.dpr);
    this.bg.width = this.canvas.width;
    this.bg.height = this.canvas.height;
    this.paintBg();
    this.seed();
    if (this.reduced.matches) this.drawStill();
    else this.draw();
  }

  private schedule() {
    cancelAnimationFrame(this.raf);
    if (this.disposed || !this.visible || this.reduced.matches) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (now: number) => {
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.t += dt;
    this.update(dt);
    this.draw();
    this.raf = requestAnimationFrame(this.frame);
  };

  private drawStill() {
    if (this.t < 6) for (let i = 0; i < 360; i++) { this.t += STEP; this.update(STEP); }
    this.draw();
  }

  private onMotion = () => (this.reduced.matches ? (cancelAnimationFrame(this.raf), this.drawStill()) : this.schedule());

  private local(e: PointerEvent) {
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    return { x, y, inside: x >= 0 && y >= 0 && x <= r.width && y <= r.height };
  }

  private onMove = (e: PointerEvent) => {
    const { x, y, inside } = this.local(e);
    this.pointer = { x, y, active: inside && e.pointerType !== "touch" };
  };

  private onDown = (e: PointerEvent) => {
    const { x, y, inside } = this.local(e);
    if (!inside || this.reduced.matches) return;
    this.pings.push({ x, y, t: this.t });
    if (this.pings.length > 12) this.pings.shift();
  };

  private onLeave = () => { this.pointer.active = false; };

  // ── palette & drawing helpers ──────────────────────────────

  private bgColor() {
    if (this.theme === "rain") return this.dark ? "#080a12" : "#eef1f6";
    if (this.theme === "debris") return this.dark ? "#05070d" : "#f6f8fb";
    return this.dark ? "#0d1117" : "#ffffff";
  }

  private fg(a: number) {
    return this.dark ? `rgba(230,237,243,${a})` : `rgba(31,35,40,${a})`;
  }

  private paintBg() {
    const g = this.bg.getContext("2d");
    if (!g || !this.W) return;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.fillStyle = this.bgColor();
    g.fillRect(0, 0, this.W, this.H);
    paintGrid(g, this.W, this.H, this.cw, this.ch, this.dpr, this.dark);
  }

  private put(c: number, r: number, glyph: string, color: string, bg?: string) {
    if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) return;
    const x = c * this.cw;
    const y = r * this.ch;
    if (bg) {
      this.ctx.fillStyle = bg;
      this.ctx.fillRect(x + 1, y + 1, this.cw - 1, this.ch - 1);
    }
    this.ctx.fillStyle = color;
    this.ctx.fillText(glyph, x + this.cw / 2, y + this.ch / 2 + 1);
  }

  private putPx(x: number, y: number, glyph: string, color: string, bg?: string) {
    this.put(Math.floor(x / this.cw), Math.floor(y / this.ch), glyph, color, bg);
  }

  // ── seeding ────────────────────────────────────────────────

  private seed() {
    const { W, H } = this;
    this.parts = [];
    const theme = this.theme;

    if (theme === "debris") {
      for (let i = 0; i < 110; i++) {
        this.parts.push({ x: 0, y: 0, vx: 0, vy: 0, a: rand(0, TAU), b: i === 0 ? 0.35 : rand(0.1, 1), c: i === 0 ? 1 : i % 18 === 0 ? 2 : 0 });
      }
    } else if (theme === "rain") {
      const n = clamp(Math.round((W * H) / 5500), 90, 320);
      for (let i = 0; i < n; i++) this.parts.push({ x: rand(0, W), y: rand(0, H), vx: 0, vy: rand(420, 700), a: 0, b: 0, c: 0 });
    } else if (theme === "fireflies") {
      for (let i = 0; i < 80; i++) {
        this.parts.push({ x: rand(0, W), y: rand(H * 0.25, H * 0.95), vx: rand(-15, 15), vy: rand(-10, 10), a: rand(0, TAU), b: rand(1.2, 2.4), c: i % 4 });
      }
    }
  }

  // ── simulation ─────────────────────────────────────────────

  private update(dt: number) {
    const { W, H, t, pointer } = this;
    const theme = this.theme;
    if (theme === "rain") {
      const ground = H * 0.8;
      for (const p of this.parts) {
        p.y += p.vy * dt;
        p.x += p.vy * dt * 0.12;
        if (p.y > ground + rand(0, H * 0.18)) {
          if (Math.random() < 0.18) this.pings.push({ x: p.x, y: p.y, t });
          p.y = rand(-H * 0.2, 0);
          p.x = rand(-W * 0.1, W);
        }
      }
      if (this.pings.length > 40) this.pings.splice(0, this.pings.length - 40);
    } else if (theme === "fireflies") {
      for (const p of this.parts) {
        p.vx += (Math.sin(t * 0.7 + p.a * 3) * 30 - p.vx * 0.6) * dt;
        p.vy += (Math.cos(t * 0.5 + p.a * 5) * 20 - p.vy * 0.6) * dt;
        if (pointer.active) {
          const dx = p.x - pointer.x;
          const dy = p.y - pointer.y;
          const d = Math.hypot(dx, dy);
          if (d < 130 && d > 1) { p.vx += (dx / d) * 260 * dt; p.vy += (dy / d) * 260 * dt; }
        }
        for (const ping of this.pings) {
          const age = t - ping.t;
          if (age > 0.3) continue;
          const dx = p.x - ping.x;
          const dy = p.y - ping.y;
          const d = Math.hypot(dx, dy);
          if (d < 220 && d > 1) { p.vx += (dx / d) * 600 * dt; p.vy += (dy / d) * 600 * dt; }
        }
        const a = this.avoid;
        if (a) {
          const pad = 30;
          const nx = clamp(p.x, a.x, a.x + a.width);
          const ny = clamp(p.y, a.y, a.y + a.height);
          let dx = p.x - nx;
          let dy = p.y - ny;
          let d = Math.hypot(dx, dy);
          if (d < 1e-3) {
            dx = p.x - (a.x + a.width / 2);
            dy = p.y - (a.y + a.height / 2);
            d = Math.hypot(dx, dy) || 1;
          }
          if (d < pad) { p.vx += (dx / d) * 420 * dt; p.vy += (dy / d) * 420 * dt; }
        }
        p.x = clamp(p.x + p.vx * dt, 0, W);
        p.y = clamp(p.y + p.vy * dt, H * 0.1, H);
      }
    }
  }

  // ── rendering ──────────────────────────────────────────────

  private draw() {
    const { ctx, dpr, ch } = this;
    if (!this.cols) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.bg, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = `600 ${Math.round(ch * 0.74)}px ${this.font}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    switch (this.theme) {
      case "train": return this.drawTrain();
      case "debris": return this.drawDebris();
      case "rain": return this.drawRain();
      case "fireflies": return this.drawFireflies();
    }
  }

  private drawTrain() {
    const { ctx, cols, rows, cw, ch, t, dark } = this;
    const horizon = Math.floor(rows * 0.7);
    const farTrack = horizon + 2;
    const wireRow = Math.floor(rows * 0.62);
    const pal = dark
      ? {
          star: (a: number) => `rgba(226,232,240,${a})`,
          moon: "rgba(241,245,249,0.9)", moonBg: "rgba(226,232,240,0.12)", water: (a: number) => `rgba(251,191,36,${a})`, waterCool: (a: number) => `rgba(103,232,249,${a})`, ripple: "rgba(100,116,139,0.35)",
          glow: "rgba(251,146,60,0.10)",
          farBg: "rgba(30,41,59,0.55)", farDot: "rgba(251,191,36,0.45)",
          midBg: "rgba(17,24,39,0.96)", edge: "rgba(100,116,139,0.75)", roof: "rgba(148,163,184,0.8)",
          warm: "#fbbf24", warmBg: "rgba(251,191,36,0.18)", cool: "#67e8f9", coolBg: "rgba(103,232,249,0.14)",
          unlit: "rgba(71,85,105,0.55)",
          rail: "rgba(203,213,225,0.85)", sleeper: "rgba(100,116,139,0.7)", ballast: "rgba(100,116,139,0.4)",
          wire: "rgba(148,163,184,0.4)", pole: "rgba(148,163,184,0.75)", streak: "rgba(148,163,184,0.25)",
          carBg: "rgba(51,65,85,0.95)", carWin: "#e0f2fe", carWinBg: "rgba(186,230,253,0.28)", stripe: "#22d3ee",
        }
      : {
          star: (a: number) => `rgba(148,163,184,${a * 0.5})`,
          moon: "rgba(100,116,139,0.85)", moonBg: "rgba(148,163,184,0.12)", water: (a: number) => `rgba(180,83,9,${a})`, waterCool: (a: number) => `rgba(14,116,144,${a})`, ripple: "rgba(148,163,184,0.45)",
          glow: "rgba(251,146,60,0.10)",
          farBg: "rgba(203,213,225,0.45)", farDot: "rgba(217,119,6,0.35)",
          midBg: "rgba(226,232,240,0.97)", edge: "rgba(100,116,139,0.6)", roof: "rgba(71,85,105,0.75)",
          warm: "#b45309", warmBg: "rgba(251,191,36,0.28)", cool: "#0e7490", coolBg: "rgba(103,232,249,0.25)",
          unlit: "rgba(148,163,184,0.6)",
          rail: "rgba(71,85,105,0.85)", sleeper: "rgba(100,116,139,0.6)", ballast: "rgba(148,163,184,0.5)",
          wire: "rgba(100,116,139,0.4)", pole: "rgba(71,85,105,0.7)", streak: "rgba(100,116,139,0.25)",
          carBg: "rgba(148,163,184,0.95)", carWin: "#0c4a6e", carWinBg: "rgba(224,242,254,0.9)", stripe: "#0891b2",
        };
    const scroll = (speed: number) => Math.floor(t * speed);

    // City glow along the horizon.
    const glow = ctx.createLinearGradient(0, (horizon - 10) * ch, 0, horizon * ch);
    glow.addColorStop(0, "rgba(0,0,0,0)");
    glow.addColorStop(1, pal.glow);
    ctx.fillStyle = glow;
    ctx.fillRect(0, (horizon - 10) * ch, this.W, 10 * ch);

    // Stars and a crescent moon, fixed in the sky.
    for (let i = 0; i < 80; i++) {
      const c = Math.floor(hash3(i, 1, 4) * cols);
      const r = Math.floor(hash3(i, 2, 4) * horizon * 0.55);
      const tw = 0.25 + 0.55 * Math.abs(Math.sin(t * (0.4 + hash3(i, 3, 4)) + i));
      this.put(c, r, i % 6 ? "." : "+", pal.star(tw));
    }
    const mc = Math.floor(cols * 0.84);
    const mr = Math.floor(rows * 0.14);
    const mx = mc * cw + cw / 2;
    const my = mr * ch + ch / 2;
    const R = ch * 2.2;
    for (let r = mr - 3; r <= mr + 3; r++) {
      for (let c = mc - 6; c <= mc + 6; c++) {
        const dx = c * cw + cw / 2 - mx;
        const dy = r * ch + ch / 2 - my;
        const d = Math.hypot(dx, dy);
        if (d > R) continue;
        const crater = hash3(c, r, 21) > 0.78 && d < R * 0.75;
        this.put(c, r, d > R * 0.82 ? "." : crater ? "o" : "@", pal.moon, d > R * 0.82 ? undefined : pal.moonBg);
      }
    }

    // Far skyline: slow, dim, with aviation lights on the tall towers.
    const farX = scroll(1.5);
    for (let c = 0; c < cols; c++) {
      const X = c + farX;
      const slot = Math.floor(X / 5);
      const tall = hash3(slot, 9, 2) > 0.86;
      const h = Math.floor((2 + hash3(slot, 3, 1) * rows * 0.14) * (tall ? 1.9 : 1));
      for (let r = horizon - h; r < horizon; r++) {
        const lit = hash3(X, r, 5) > 0.92;
        this.put(c, r, lit ? "." : " ", pal.farDot, pal.farBg);
      }
      if (tall && X % 5 === 2 && Math.floor(t * 1.2 + slot) % 2 === 0) this.put(c, horizon - h - 1, "*", "#ef4444");
    }

    // Mid buildings: walls, roofs, rooftop details and windows that switch on and off.
    const midX = scroll(4);
    for (let c = 0; c < cols; c++) {
      const X = c + midX;
      const slot = Math.floor(X / 11);
      const w = 6 + Math.floor(hash3(slot, 1, 2) * 4);
      const lx = X - slot * 11 - Math.floor(hash3(slot, 2, 2) * (11 - w));
      if (lx < 0 || lx >= w) continue;
      const roofType = Math.floor(hash3(slot, 4, 4) * 4);
      let top = horizon - Math.floor(rows * 0.1 + hash3(slot, 3, 3) * rows * 0.3);
      if (roofType === 3 && lx > 1 && lx < w - 2) top -= 2;
      const mid = Math.floor(w / 2);
      if (roofType === 1 && lx === mid) {
        this.put(c, top - 3, "*", Math.floor(t * 1.5 + slot) % 2 ? "#ef4444" : pal.edge);
        this.put(c, top - 2, "|", pal.edge);
        this.put(c, top - 1, "|", pal.edge);
      }
      if (roofType === 2 && lx >= 1 && lx <= 3) {
        this.put(c, top - 2, lx === 2 ? "_" : " ", pal.roof);
        this.put(c, top - 1, lx === 1 ? "[" : lx === 3 ? "]" : "=", pal.roof);
      }
      for (let r = top; r < horizon; r++) {
        if (r === top) {
          this.put(c, r, "_", pal.roof, pal.midBg);
        } else if (lx === 0 || lx === w - 1) {
          this.put(c, r, "|", pal.edge, pal.midBg);
        } else if (r === horizon - 1 && lx === mid) {
          this.put(c, r, "#", pal.warm, pal.warmBg);
        } else if ((lx - 1) % 2 === 0 && (r - top - 1) % 2 === 0 && lx < w - 1 && r < horizon - 1) {
          const epoch = Math.floor(t / 6 + hash3(slot, lx, r) * 6);
          const on = hash3(slot * 31 + lx, r, epoch) > 0.45;
          const tv = hash3(slot, lx, r + 9) > 0.88;
          if (on && tv) this.put(c, r, "#", pal.cool, Math.sin(t * 9 + lx) > 0 ? pal.coolBg : undefined);
          else if (on) this.put(c, r, "#", pal.warm, pal.warmBg);
          else this.put(c, r, ".", pal.unlit, pal.midBg);
        } else {
          this.put(c, r, " ", pal.edge, pal.midBg);
        }
      }
    }

    // Embankment between the city and the far track.
    const bankX = scroll(9);
    for (let c = 0; c < cols; c++) {
      const X = c + bankX;
      for (let r = horizon; r < farTrack; r++) if (hash3(X, r, 6) > 0.62) this.put(c, r, hash3(X, r, 7) > 0.5 ? "," : ".", pal.ballast);
      this.put(c, farTrack, "=", pal.sleeper);
    }

    // An oncoming train on the far track every so often.
    const period = 12;
    const phase = (t + 10) % period;
    const head = cols + 4 - phase * 30;
    const cars = 4;
    const carLen = 13;
    for (let c = Math.max(0, Math.floor(head) - 8); c < Math.min(cols, head + cars * carLen); c++) {
      const rel = Math.floor(c - head);
      if (rel < 0) {
        if (rel > -8) this.put(c, farTrack - 1, "-", `rgba(253,224,71,${(0.6 + rel * 0.07).toFixed(2)})`);
        continue;
      }
      const lc = rel % carLen;
      if (lc === carLen - 1) {
        this.put(c, farTrack - 1, "-", pal.edge);
        continue;
      }
      const nose = rel === 0;
      this.put(c, farTrack - 3, nose ? "/" : "_", pal.roof, nose ? undefined : pal.carBg);
      const win = lc > 0 && lc < carLen - 2 && lc % 3 !== 0;
      this.put(c, farTrack - 2, win ? "#" : " ", pal.carWin, win ? pal.carWinBg : pal.carBg);
      this.put(c, farTrack - 1, nose ? "*" : "=", nose ? "#fde047" : pal.stripe, pal.carBg);
    }

    // River: rippling reflections of the lit windows.
    const riverTop = farTrack + 2;
    const riverBot = rows - 7;
    for (let r = riverTop; r <= riverBot; r++) {
      const depth = (r - riverTop) / Math.max(1, riverBot - riverTop);
      for (let c = 0; c < cols; c++) {
        const wob = Math.round(Math.sin(t * 1.6 + r * 0.9 + c * 0.05) * 1.2);
        const X = c + midX + wob;
        const slot = Math.floor(X / 11);
        const src = horizon - 2 - (r - riverTop) * 2;
        const epoch = Math.floor(t / 6 + hash3(slot, X % 11, src) * 6);
        const lit = hash3(slot * 31 + (X - slot * 11), src, epoch) > 0.72 && (X % 2 === 0);
        if (lit && hash3(c, r, Math.floor(t * 3)) > 0.25) {
          const a = (0.55 - depth * 0.4).toFixed(2);
          this.put(c, r, "~", hash3(slot, 7, r) > 0.85 ? pal.waterCool(+a) : pal.water(+a));
        } else if (hash3(c + Math.floor(t * 2), r, 11) > 0.93) {
          this.put(c, r, "-", pal.ripple);
        }
      }
    }

    // Catenary poles and sagging wire rushing past in the foreground.
    const poleX = scroll(14);
    const span = 34;
    for (let c = 0; c < cols; c++) {
      const X = c + poleX;
      const k = (((X % span) + span) % span) / span;
      this.put(c, wireRow + Math.round(Math.sin(k * Math.PI) * 1.4), "-", pal.wire);
      if (((X % span) + span) % span === 0) {
        this.put(c, wireRow - 1, "T", pal.pole);
        for (let r = wireRow; r < rows - 4; r++) if (r < horizon || r > riverBot) this.put(c, r, "|", pal.pole);
      }
    }

    // Our own track: rails, blurred sleepers, ballast and speed streaks.
    const trackX = scroll(32);
    for (let c = 0; c < cols; c++) {
      const X = c + trackX;
      if (hash3(Math.floor(X / 6), rows - 6, 7) > 0.84) this.put(c, rows - 6, "-", pal.streak);
      if (hash3(Math.floor(X / 4), rows - 5, 8) > 0.8) this.put(c, rows - 5, "-", pal.streak);
      this.put(c, rows - 4, "=", pal.rail);
      this.put(c, rows - 3, X % 4 < 2 ? "#" : " ", pal.sleeper);
      this.put(c, rows - 2, "=", pal.rail);
      this.put(c, rows - 1, hash3(X, rows, 3) > 0.5 ? "." : ",", pal.ballast);
    }

    // Clicks drop a lineside signal that flashes and slides away.
    for (const p of this.pings) {
      const age = t - p.t;
      if (age > 4) continue;
      const c = Math.floor(p.x / cw - age * 14);
      const on = Math.floor(age * 4) % 2 === 0;
      for (let r = wireRow + 1; r < rows - 4; r++) this.put(c, r, "|", pal.pole);
      this.put(c, wireRow, "o", on ? "#ef4444" : "#22c55e", "rgba(0,0,0,0.3)");
    }
  }

  // ── shared detail helpers ──────────────────────────────────

  /** Smooth value noise in [0, 1). */
  private vnoise(x: number, y: number, seed: number) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);
    const a = hash3(xi, yi, seed);
    const b = hash3(xi + 1, yi, seed);
    const c = hash3(xi, yi + 1, seed);
    const d = hash3(xi + 1, yi + 1, seed);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }

  private starfield(count: number, maxRow: number, seed: number) {
    for (let i = 0; i < count; i++) {
      const c = Math.floor(hash3(i, 1, seed) * this.cols);
      const r = Math.floor(hash3(i, 2, seed) * maxRow);
      const tw = 0.2 + 0.6 * Math.abs(Math.sin(this.t * (0.3 + hash3(i, 3, seed)) + i));
      this.put(c, r, i % 7 ? "." : "+", this.fg(tw * (this.dark ? 0.85 : 0.35)));
    }
  }

  /** Writes a string starting at a cell, skipping spaces so the scene shows through. */
  private text(c: number, r: number, s: string, color: string, bg?: string) {
    for (let i = 0; i < s.length; i++) if (s[i] !== " ") this.put(c + i, r, s[i], color, bg);
  }

  private disc(cx: number, cy: number, R: number, fn: (c: number, r: number, d: number, dx: number, dy: number) => void) {
    const c0 = Math.floor((cx - R) / this.cw);
    const c1 = Math.ceil((cx + R) / this.cw);
    const r0 = Math.floor((cy - R) / this.ch);
    const r1 = Math.ceil((cy + R) / this.ch);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const dx = c * this.cw + this.cw / 2 - cx;
        const dy = r * this.ch + this.ch / 2 - cy;
        const d = Math.hypot(dx, dy);
        if (d <= R) fn(c, r, d, dx, dy);
      }
    }
  }

  // ── orbital debris ─────────────────────────────────────────

  private drawDebris() {
    const { W, H, t, pointer, dark, cols, rows, cw, ch } = this;
    this.starfield(150, rows, 31);

    // A shooting star every few seconds.
    const sp = t % 7;
    if (sp < 0.9) {
      const sx = W * (0.08 + sp * 0.5);
      const sy = H * (0.06 + sp * 0.12);
      for (let k = 0; k < 9; k++) this.putPx(sx - k * cw, sy - k * ch * 0.25, k ? "-" : "*", this.fg(0.9 - k * 0.09));
    }

    // The planet: lit from the top left, with oceans, continents, clouds and city lights.
    const cx = W / 2;
    const cy = H * 1.55;
    const R = H * 0.78;
    const L = [-0.5, -0.7, 0.5];
    const ln = Math.hypot(L[0], L[1], L[2]);
    const r0 = Math.max(0, Math.floor((cy - R - ch * 3) / ch));
    for (let r = r0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const px = c * cw + cw / 2;
        const py = r * ch + ch / 2;
        const d = Math.hypot(px - cx, py - cy);
        if (d < R) {
          const nx = (px - cx) / R;
          const ny = (py - cy) / R;
          const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
          const light = (nx * L[0] + ny * L[1] + nz * L[2]) / ln;
          const lon = Math.atan2(nx, nz) + t * 0.015;
          const lat = Math.asin(clamp(ny, -1, 1));
          const land = this.vnoise(lon * 3 + 10, lat * 4 + 10, 7) * 0.65 + this.vnoise(lon * 8, lat * 9, 8) * 0.35 > 0.55;
          const cloud = this.vnoise(lon * 5 - t * 0.04, lat * 7, 9) > 0.66;
          const rim = d > R - ch * 0.7;
          if (rim) {
            this.put(c, r, ":", dark ? "rgba(125,211,252,0.85)" : "rgba(2,132,199,0.8)");
          } else if (light > 0.04) {
            const s = clamp(light, 0, 1);
            if (cloud) this.put(c, r, s > 0.5 ? "~" : "-", `rgba(241,245,249,${(0.35 + s * 0.55).toFixed(2)})`);
            else if (land) this.put(c, r, s > 0.55 ? "%" : "#", `rgba(${dark ? "134,190,110" : "77,124,15"},${(0.3 + s * 0.6).toFixed(2)})`, `rgba(77,124,15,${(s * 0.18).toFixed(2)})`);
            else this.put(c, r, s > 0.5 ? ":" : ".", `rgba(${dark ? "96,165,250" : "29,78,216"},${(0.3 + s * 0.6).toFixed(2)})`, `rgba(30,64,175,${(s * 0.16).toFixed(2)})`);
          } else if (land && hash3(c, r, 5) > 0.72) {
            const flick = 0.5 + 0.5 * Math.sin(t * 2 + c * 3 + r);
            this.put(c, r, ".", `rgba(251,191,36,${(0.45 + flick * 0.45).toFixed(2)})`);
          } else if (!land && hash3(c, r, 6) > 0.9) {
            this.put(c, r, ".", dark ? "rgba(30,58,138,0.5)" : "rgba(30,58,138,0.25)");
          }
        } else if (d < R + ch * 1.8) {
          const a = 0.55 * (1 - (d - R) / (ch * 1.8));
          this.put(c, r, ".", dark ? `rgba(56,189,248,${a.toFixed(2)})` : `rgba(2,132,199,${a.toFixed(2)})`);
        }
      }
    }

    const orbit = (p: Part, dt = 0) => {
      const rad = R + ch * 3 + p.b * H * 0.95;
      const ang = p.a - Math.PI / 2 + (t - dt) * 0.09 * Math.pow(R / rad, 1.5) * (p.c ? 0.7 : 1);
      let x = cx + Math.cos(ang) * rad * 1.15;
      let y = cy + Math.sin(ang) * rad * 0.72;
      if (pointer.active) {
        const dx = x - pointer.x;
        const dy = y - pointer.y;
        const dd = Math.hypot(dx, dy);
        if (dd < 120 && dd > 1) { x += (dx / dd) * (1 - dd / 120) * 45; y += (dy / dd) * (1 - dd / 120) * 45; }
      }
      return { x, y };
    };

    for (const p of this.parts) {
      const { x, y } = orbit(p);
      if (y > H || y < 0) continue;
      // Orbiting objects pass behind the heading rather than across it.
      const av = this.avoid;
      const pad = p.c === 1 ? cw * 9 : cw * 3;
      if (av && x > av.x - pad && x < av.x + av.width + pad && y > av.y - ch * 2 && y < av.y + av.height + ch) continue;
      const c = Math.floor(x / cw);
      const r = Math.floor(y / ch);
      if (p.c === 1) {
        // Space station: solar arrays, truss and a blinking beacon.
        const panel = dark ? "#1e3a8a" : "#bfdbfe";
        const panelFg = dark ? "#93c5fd" : "#1e3a8a";
        this.text(c - 8, r, "[###]", panelFg, panel);
        this.text(c - 3, r, "-=", this.fg(0.75));
        this.put(c - 1, r, "[", this.fg(0.9));
        this.put(c, r, "O", this.fg(0.95), dark ? "#334155" : "#cbd5e1");
        this.put(c + 1, r, "]", this.fg(0.9));
        this.text(c + 2, r, "=-", this.fg(0.75));
        this.text(c + 4, r, "[###]", panelFg, panel);
        this.text(c - 8, r - 1, "[###]", panelFg, panel);
        this.text(c + 4, r - 1, "[###]", panelFg, panel);
        this.put(c, r - 1, "|", this.fg(0.6));
        this.put(c, r - 2, "*", Math.floor(t * 2) % 2 ? "#ef4444" : "#22c55e");
      } else if (p.c === 2) {
        // Satellite with a faint orbital trail.
        for (let k = 1; k <= 6; k++) {
          const q = orbit(p, k * 0.35);
          this.putPx(q.x, q.y, ".", `rgba(250,204,21,${(0.5 - k * 0.07).toFixed(2)})`);
        }
        this.put(c - 2, r, "=", "#38bdf8");
        this.put(c - 1, r, "[", this.fg(0.85));
        this.put(c, r, "#", "#0b0b10", "#eab308");
        this.put(c + 1, r, "]", this.fg(0.85));
        this.put(c + 2, r, "=", "#38bdf8");
      } else {
        this.put(c, r, ".*+x"[Math.floor(p.b * 4) % 4], this.fg(0.3 + p.b * 0.5));
      }
    }

    for (const p of this.pings) {
      const age = t - p.t;
      if (age > 1.6) continue;
      const rad = age * 320;
      for (let k = 0; k < 72; k++) {
        const a = (k / 72) * TAU;
        this.putPx(p.x + Math.cos(a) * rad, p.y + Math.sin(a) * rad * 0.7, "·", `rgba(56,189,248,${(1 - age / 1.6).toFixed(2)})`);
      }
    }
  }

  // ── rainy alley ────────────────────────────────────────────

  private drawRain() {
    const { cols, rows, t, dark } = this;
    const ground = Math.floor(rows * 0.8);
    const wallL = Math.floor(cols * 0.15);
    const wallR = Math.ceil(cols * 0.85);
    const brick = dark ? "rgba(100,116,139,0.45)" : "rgba(100,116,139,0.55)";
    const brickBg = dark ? "rgba(30,27,40,0.95)" : "rgba(226,232,240,0.95)";
    const amber = dark ? "#fbbf24" : "#b45309";
    const farBg = dark ? "rgba(30,41,59,0.45)" : "rgba(203,213,225,0.5)";

    // Distant towers at the end of the alley.
    for (let c = wallL; c < wallR; c++) {
      const slot = Math.floor(c / 6);
      const h = Math.floor(4 + hash3(slot, 1, 61) * rows * 0.32);
      for (let r = ground - h; r < ground; r++) {
        const lit = hash3(c, r, 62) > 0.9 && (c + r) % 2 === 0;
        this.put(c, r, lit ? "." : " ", `rgba(251,191,36,0.5)`, farBg);
      }
    }

    // Brick walls with windows, someone home in a few of them.
    for (let r = 0; r < ground; r++) {
      for (let c = 0; c < cols; c++) {
        if (c >= wallL && c < wallR) continue;
        const local = c < wallL ? c : c - wallR;
        const edge = c === wallL - 1 || c === wallR;
        const win = r % 7 >= 2 && r % 7 <= 3 && local % 6 >= 2 && local % 6 <= 3 && !edge;
        if (win) {
          const id = Math.floor(r / 7) * 100 + Math.floor(local / 6) + (c < wallL ? 0 : 50);
          const on = hash3(id, Math.floor(t / 8 + hash3(id, 2, 63) * 8), 64) > 0.45;
          const shadow = on && hash3(id, 3, 65) > 0.75 && Math.sin(t * 0.7 + id) > 0.3;
          this.put(c, r, shadow ? "&" : on ? "#" : ".", on ? (shadow ? "rgba(30,20,10,0.9)" : amber) : brick, on ? "rgba(251,191,36,0.22)" : brickBg);
        } else {
          const joint = (c + (r % 2) * 2) % 4 === 0;
          this.put(c, r, edge ? "|" : joint ? "|" : "=", edge ? this.fg(0.5) : brick, brickBg);
        }
      }
    }

    // Fire escape on the right wall.
    for (let p = 6; p < ground - 4; p += 8) {
      for (let c = wallR - 5; c < wallR; c++) {
        this.put(c, p, "=", this.fg(0.6));
        this.put(c, p - 1, c === wallR - 5 ? "|" : "_", this.fg(0.45));
      }
      for (let k = 0; k < 7 && p + 1 + k < ground; k++) this.put(wallR - 1 - Math.floor((k * 4) / 7), p + 1 + k, "/", this.fg(0.45));
    }

    // Neon signs with a soft glow and the odd flicker.
    const signs = [
      { c: wallL, r: Math.floor(rows * 0.18), text: "BAR", color: "#a78bfa", vertical: true },
      { c: wallL + 1, r: ground - 6, text: "OPEN", color: "#f472b6", vertical: false },
      { c: wallR - 1, r: Math.floor(rows * 0.12), text: "24H", color: "#22d3ee", vertical: true },
      { c: wallR - 8, r: ground - 9, text: "NOODLE", color: "#fbbf24", vertical: false },
    ];
    signs.forEach((s, i) => {
      const off = hash3(Math.floor(t * 7), i, 3) > 0.94;
      const w = s.vertical ? 1 : s.text.length;
      const h = s.vertical ? s.text.length : 1;
      if (!off) {
        for (let r = s.r - 1; r <= s.r + h; r++) for (let c = s.c - 1; c <= s.c + w; c++) this.put(c, r, " ", s.color, s.color + "1f");
      }
      for (let k = 0; k < s.text.length; k++) {
        const c = s.c + (s.vertical ? 0 : k);
        const r = s.r + (s.vertical ? k : 0);
        this.put(c, r, s.text[k], off ? this.fg(0.2) : "#0b0b10", off ? undefined : s.color);
        const rr = ground * 2 - r + 1;
        const wob = Math.round(Math.sin(t * 3 + k + r) * 0.6);
        if (!off && rr < rows) this.put(c + wob, rr, s.text[k], s.color + "66");
      }
    });

    // Wet street: puddles, lane marks and a manhole venting steam.
    for (let c = 0; c < cols; c++) {
      for (let r = ground; r < rows; r++) {
        const pud = this.vnoise(c / 7, r / 2, 66) > 0.6;
        if (pud && hash3(c, r, Math.floor(t * 3 + c * 0.1)) > 0.5) this.put(c, r, "~", dark ? "rgba(96,165,250,0.35)" : "rgba(37,99,235,0.3)");
        else if (hash3(c, r, Math.floor(t * 2 + c * 0.1)) > 0.9) this.put(c, r, "~", this.fg(0.15));
      }
      if (c % 8 < 4) this.put(c, ground + 3, "-", dark ? "rgba(250,204,21,0.35)" : "rgba(202,138,4,0.45)");
    }
    const mc = Math.floor(cols * 0.62);
    this.text(mc - 1, ground + 1, "(=)", this.fg(0.5));
    for (let k = 0; k < 6; k++) {
      const age = (t * 0.5 + k / 6) % 1;
      this.put(mc + Math.round(Math.sin(age * 5 + k) * (1 + age * 2)), ground - Math.floor(age * 7), age < 0.5 ? "o" : ".", this.fg(0.4 * (1 - age)));
    }

    // Street lamp with a warm cone that lights the rain.
    const lc = Math.floor(cols * 0.32);
    const lh = ground - 13;
    for (let r = lh + 1; r <= ground; r++) this.put(lc, r, "|", this.fg(0.6));
    this.text(lc - 1, lh, "=@=", "#fde68a");
    const inCone = (c: number, r: number) => r > lh && r <= ground && Math.abs(c - lc) <= (r - lh) * 0.55;
    for (let r = lh + 1; r <= ground + 1; r++) {
      const hw = Math.floor((r - lh) * 0.55);
      for (let c = lc - hw; c <= lc + hw; c++) if (c !== lc) this.put(c, r, " ", "", "rgba(253,230,138,0.06)");
    }

    // A car rolling through every so often.
    const cycle = t % 11;
    if (cycle < 3.5) {
      const head = Math.floor((cycle / 3.5) * (cols + 40)) - 20;
      for (let c = head + 1; c < head + 14; c++) for (let r = ground; r <= ground + 1; r++) this.put(c, r, "=", `rgba(253,224,71,${(0.6 - (c - head) / 26).toFixed(2)})`);
      this.text(head - 7, ground - 1, " ____ ", this.fg(0.7));
      this.text(head - 8, ground, "[__||__]", this.fg(0.85), dark ? "rgba(51,65,85,0.95)" : "rgba(148,163,184,0.95)");
      this.text(head - 7, ground + 1, "O    O", this.fg(0.85));
      this.put(head, ground, ">", "#fde047");
      this.put(head - 8, ground, "[", "#ef4444");
    }

    const dropColor = dark ? "rgba(148,163,184,0.55)" : "rgba(71,85,105,0.5)";
    for (const p of this.parts) {
      const c = Math.floor(p.x / this.cw);
      const r = Math.floor(p.y / this.ch);
      this.put(c, r, "/", inCone(c, r) ? "#fde68a" : dropColor);
    }
    for (const p of this.pings) {
      const age = t - p.t;
      if (age > 0.7) continue;
      const spread = 1 + Math.floor(age * 5);
      const c = Math.floor(p.x / this.cw);
      const r = Math.floor(p.y / this.ch);
      const col = this.fg(0.5 * (1 - age / 0.7));
      this.put(c - spread, r, "(", col);
      this.put(c + spread, r, ")", col);
    }
  }

  // ── firefly meadow ─────────────────────────────────────────

  private drawFireflies() {
    const { cols, rows, t, dark, cw, ch, W, H } = this;
    const green = (a: number) => (dark ? `rgba(74,222,128,${a})` : `rgba(21,128,61,${a})`);
    const horizon = Math.floor(rows * 0.68);

    this.starfield(90, horizon, 91);
    // Crescent moon.
    this.disc(W * 0.12, H * 0.13, ch * 1.8, (c, r, d, dx, dy) => {
      if (Math.hypot(dx - ch * 0.9, dy + ch * 0.3) > ch * 1.5) this.put(c, r, d > ch * 1.4 ? "." : "@", dark ? "rgba(254,249,195,0.9)" : "rgba(202,138,4,0.8)");
    });

    // Far treeline.
    for (let c = 0; c < cols; c++) {
      const h = Math.floor(2 + this.vnoise(c / 5, 0, 92) * 5);
      for (let r = horizon - h; r < horizon + 2; r++) this.put(c, r, r === horizon - h ? "^" : " ", green(0.25), dark ? "rgba(20,83,45,0.25)" : "rgba(187,247,208,0.4)");
    }

    // Two big trees framing the meadow.
    for (const [fx, seed] of [[0.04, 93], [0.95, 94]] as const) {
      const tx = W * fx;
      const trunkTop = H * 0.45;
      for (let r = Math.floor(trunkTop / ch); r < rows; r++) {
        this.putPx(tx - cw / 2, r * ch, "|", dark ? "rgba(161,98,7,0.7)" : "rgba(120,53,15,0.8)");
        this.putPx(tx + cw / 2, r * ch, "|", dark ? "rgba(161,98,7,0.7)" : "rgba(120,53,15,0.8)");
      }
      this.disc(tx, H * 0.32, Math.min(W, H) * 0.2, (c, r, d) => {
        const n = this.vnoise(c / 3, r / 2, seed);
        if (d / (Math.min(W, H) * 0.2) > 0.6 + n * 0.4) return;
        const sway = Math.sin(t * 0.8 + r * 0.3) > 0.7;
        this.put(c, r, n > 0.6 ? "&" : sway ? "%" : "@", green(0.3 + n * 0.35), dark ? "rgba(20,83,45,0.35)" : "rgba(187,247,208,0.45)");
      });
    }

    // Pond with cattails.
    const pcx = W * 0.66;
    const pcy = H * 0.9;
    const prx = W * 0.15;
    const pry = H * 0.06;
    const inPond = (c: number, r: number) => ((c * cw + cw / 2 - pcx) / prx) ** 2 + ((r * ch + ch / 2 - pcy) / pry) ** 2 < 1;

    // Swaying grass with wildflowers.
    for (let c = 0; c < cols; c++) {
      const h = Math.floor(2 + hash3(c, 5, 5) * rows * 0.2);
      for (let r = rows - h; r < rows; r++) {
        if (inPond(c, r)) continue;
        const sway = Math.sin(t * 1.4 + c * 0.18 + (rows - r) * 0.15);
        const flower = r === rows - h && hash3(c, r, 95) > 0.85;
        if (flower) {
          this.put(c, r, "*", ["#f472b6", "#f8fafc", "#facc15", "#a78bfa"][Math.floor(hash3(c, 1, 96) * 4)]);
          continue;
        }
        const g = sway > 0.45 ? "/" : sway < -0.45 ? "\\" : "|";
        this.put(c, r, g, green(0.15 + ((rows - r) / h) * 0.35));
      }
    }
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (!inPond(c, r)) continue;
        const shimmer = Math.sin(t * 1.2 + c * 0.5 + r * 2) > 0.5;
        this.put(c, r, shimmer ? "~" : "-", dark ? "rgba(96,165,250,0.35)" : "rgba(37,99,235,0.35)", dark ? "rgba(15,23,42,0.6)" : "rgba(219,234,254,0.7)");
      }
    }
    for (const k of [-1, 1]) {
      const cc = Math.floor((pcx + k * prx * 1.02) / cw);
      const cr = Math.floor((pcy - pry * 0.6) / ch);
      for (let i = 0; i < 4; i++) {
        this.put(cc + i * k, cr - 1 + (i % 2), "!", dark ? "rgba(161,98,7,0.85)" : "rgba(120,53,15,0.85)");
      }
    }

    // Fireflies: individual blinking, a sync wave that sweeps the meadow, glow halos and reflections.
    const rgb = dark ? "253,224,71" : "202,138,4";
    const waveX = ((t % 12) / 12) * 1.6 - 0.3;
    for (const p of this.parts) {
      let glow = Math.pow(Math.max(0, Math.sin(t * p.b + p.c * 1.6 + p.a * 0.3)), 3);
      glow = Math.max(glow, Math.exp(-((p.x / W - waveX) ** 2) / 0.004));
      if (glow < 0.04) continue;
      const c = Math.floor(p.x / cw);
      const r = Math.floor(p.y / ch);
      if (glow > 0.45) {
        for (const [dc, dr] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) this.put(c + dc, r + dr, ".", `rgba(${rgb},${(glow * 0.3).toFixed(2)})`, `rgba(${rgb},${(glow * 0.06).toFixed(2)})`);
      }
      this.put(c, r, glow > 0.6 ? "*" : ".", `rgba(${rgb},${glow.toFixed(2)})`, glow > 0.6 ? `rgba(${rgb},0.15)` : undefined);
      const mr = Math.floor((2 * (pcy - pry) - p.y) / ch);
      if (inPond(c, mr)) this.put(c, mr, ".", `rgba(${rgb},${(glow * 0.5).toFixed(2)})`);
    }
  }
}
