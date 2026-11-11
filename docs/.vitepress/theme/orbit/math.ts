export const TAU = Math.PI * 2;

export const clamp = (v: number, lo: number, hi: number) =>
  v < lo ? lo : v > hi ? hi : v;

export const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);

/** Cheap integer hash → [0, 1). Deterministic, so textures stay stable. */
export function hash3(x: number, y: number, z: number) {
  let h =
    Math.imul(x | 0, 374761393) ^
    Math.imul(y | 0, 668265263) ^
    Math.imul(z | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
