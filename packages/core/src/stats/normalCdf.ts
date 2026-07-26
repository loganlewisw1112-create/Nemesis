const A1 = 0.254829592;
const A2 = -0.284496736;
const A3 = 1.421413741;
const A4 = -1.453152027;
const A5 = 1.061405429;
const P = 0.3275911;
const SQRT_2 = Math.SQRT2;

function erf(x: number): number {
  if (!Number.isFinite(x)) return Number.isNaN(x) ? Number.NaN : Math.sign(x);
  const sign = x < 0 ? -1 : 1;
  const abs = Math.abs(x);
  const t = 1 / (1 + P * abs);
  const poly = (((((A5 * t + A4) * t) + A3) * t + A2) * t + A1) * t;
  return sign * (1 - poly * Math.exp(-abs * abs));
}

export function normalCdf(x: number): number {
  if (Number.isNaN(x)) return Number.NaN;
  if (x === Infinity) return 1;
  if (x === -Infinity) return 0;
  return 0.5 * (1 + erf(x / SQRT_2));
}
