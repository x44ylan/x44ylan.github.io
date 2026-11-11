import { clamp, hash3, rand, TAU } from "./math";
import { paintGrid } from "./renderer";
type AvoidRect = { x: number; y: number; width: number; height: number };

type Part = { a: number; b: number; c: number };
type Ping = { x: number; y: number; t: number };

export class OrbitEngine {
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

  constructor(private canvas: HTMLCanvasElement, private dark = true) {
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
    this.draw();
    this.raf = requestAnimationFrame(this.frame);
  };

  private drawStill() {
    this.t = Math.max(this.t, 6);
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
    return this.dark ? "#05070d" : "#f6f8fb";
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
    this.parts = [];
    for (let i = 0; i < 110; i++) {
      this.parts.push({ a: rand(0, TAU), b: i === 0 ? 0.35 : rand(0.1, 1), c: i === 0 ? 1 : i % 18 === 0 ? 2 : 0 });
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
    this.drawDebris();
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
}
