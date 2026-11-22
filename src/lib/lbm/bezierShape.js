// Bezier camber + thickness airfoil parameterization for interactive 2D wind tunnel editing

const C = [[1], [1, 1], [1, 2, 1], [1, 3, 3, 1], [1, 4, 6, 4, 1]];

const basis = (n, u) => C[n].map((c, i) => c * u ** i * (1 - u) ** (n - i));

export const point = (P, u) => {
  const b = basis(P.length - 1, u);
  let x = 0;
  let y = 0;
  for (let i = 0; i < P.length; i++) {
    x += b[i] * P[i][0];
    y += b[i] * P[i][1];
  }
  return [x, y];
};

const uAt = (Px, x) => {
  const n = Px.length - 1;
  let lo = 0;
  let hi = 1;
  for (let k = 0; k < 36; k++) {
    const m = 0.5 * (lo + hi);
    const b = basis(n, m);
    let xm = 0;
    for (let i = 0; i <= n; i++) xm += b[i] * Px[i];
    if (xm < x) lo = m;
    else hi = m;
  }
  return 0.5 * (lo + hi);
};

export const yAt = (P, x) => point(P, uAt(P.map((p) => p[0]), x))[1];

export const cosGrid = (n) =>
  Array.from({ length: n }, (_, i) => 0.5 * (1 - Math.cos((Math.PI * i) / (n - 1))));

const interp = (x, xs, ys) => {
  if (x <= xs[0]) return ys[0];
  if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
  let lo = 0;
  let hi = xs.length - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (xs[m] <= x) lo = m;
    else hi = m;
  }
  const t = (x - xs[lo]) / (xs[hi] - xs[lo] || 1);
  return ys[lo] + t * (ys[hi] - ys[lo]);
};

function lsq(A, b) {
  const n = A[0].length;
  const M = Array.from({ length: n }, () => new Array(n + 1).fill(0));
  for (let r = 0; r < A.length; r++) {
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) M[i][j] += A[r][i] * A[r][j];
      M[i][n] += A[r][i] * b[r];
    }
  }
  for (let k = 0; k < n; k++) {
    let p = k;
    for (let i = k + 1; i < n; i++) {
      if (Math.abs(M[i][k]) > Math.abs(M[p][k])) p = i;
    }
    [M[k], M[p]] = [M[p], M[k]];
    if (Math.abs(M[k][k]) < 1e-14) return null;
    for (let i = k + 1; i < n; i++) {
      const f = M[i][k] / M[k][k];
      for (let j = k; j <= n; j++) M[i][j] -= f * M[k][j];
    }
  }
  const x = new Array(n).fill(0);
  for (let k = n - 1; k >= 0; k--) {
    let s = M[k][n];
    for (let j = k + 1; j < n; j++) s -= M[k][j] * x[j];
    x[k] = s / M[k][k];
  }
  return x;
}

function split(coords, xg) {
  let c = coords.map((p) => [p[0], p[1]]);
  const te = [0.5 * (c[0][0] + c[c.length - 1][0]), 0.5 * (c[0][1] + c[c.length - 1][1])];
  let ile = 0;
  let best = -1;
  c.forEach((p, i) => {
    const d = Math.hypot(p[0] - te[0], p[1] - te[1]);
    if (d > best) {
      best = d;
      ile = i;
    }
  });
  const le = c[ile];
  const ang = Math.atan2(te[1] - le[1], te[0] - le[0]);
  const ch = Math.hypot(te[0] - le[0], te[1] - le[1]) || 1;
  const ca = Math.cos(-ang);
  const sa = Math.sin(-ang);
  c = c.map(([x, y]) => {
    const dx = x - le[0];
    const dy = y - le[1];
    return [(dx * ca - dy * sa) / ch, (dx * sa + dy * ca) / ch];
  });
  let a = c.slice(0, ile + 1).reverse();
  let b = c.slice(ile);
  const mean = (s) => s.reduce((t, p) => t + p[1], 0) / Math.max(1, s.length);
  if (mean(a) < mean(b)) [a, b] = [b, a];
  const sortX = (s) => s.slice().sort((p, q) => p[0] - q[0]);
  a = sortX(a);
  b = sortX(b);
  const yu = xg.map((x) => interp(x, a.map((p) => p[0]), a.map((p) => p[1])));
  const yl = xg.map((x) => interp(x, b.map((p) => p[0]), b.map((p) => p[1])));
  return { yu, yl };
}

function fitCurve(xg, data, fixedX, freeXIdx, freeYIdx, fixedY, lo = 0.05, hi = 0.95, gap = 0.15) {
  const n = fixedX.length - 1;
  const evalFit = (xsFree) => {
    const Px = fixedX.slice();
    freeXIdx.forEach((k, i) => { Px[k] = xsFree[i]; });
    for (let i = 1; i <= n; i++) if (Px[i] < Px[i - 1]) return null;
    if (xsFree.some((v) => v < lo || v > hi) || (xsFree.length === 2 && xsFree[1] - xsFree[0] < gap)) {
      return null;
    }
    const A = [];
    const rhs = [];
    for (let r = 0; r < xg.length; r++) {
      const b = basis(n, uAt(Px, xg[r]));
      let fixed = 0;
      fixedY.forEach(([k, v]) => { fixed += b[k] * v; });
      A.push(freeYIdx.map((k) => b[k]));
      rhs.push(data[r] - fixed);
    }
    const ys = lsq(A, rhs);
    if (!ys) return null;
    let err = 0;
    for (let r = 0; r < xg.length; r++) {
      let s = 0;
      for (let j = 0; j < ys.length; j++) s += A[r][j] * ys[j];
      err = Math.max(err, Math.abs(s - rhs[r]));
    }
    return { Px, ys, err };
  };

  let best = null;
  const g = [];
  for (let v = lo; v <= hi + 1e-9; v += 0.05) g.push(v);
  const combos =
    freeXIdx.length === 2
      ? g.flatMap((a) => g.filter((b) => b >= a + gap - 1e-9).map((b) => [a, b]))
      : g.map((a) => [a]);
  for (const xs of combos) {
    const r = evalFit(xs);
    if (r && (!best || r.err < best.err)) best = { ...r, xs };
  }
  let step = 0.02;
  while (best && step > 2e-4) {
    let improved = false;
    for (let i = 0; i < best.xs.length; i++) {
      for (const d of [-step, step]) {
        const xs = best.xs.slice();
        xs[i] += d;
        const r = evalFit(xs);
        if (r && r.err < best.err) {
          best = { ...r, xs };
          improved = true;
        }
      }
    }
    if (!improved) step /= 2;
  }
  const P = best.Px.map((x) => [x, 0]);
  fixedY.forEach(([k, v]) => { P[k][1] = v; });
  freeYIdx.forEach((k, j) => { P[k][1] = best.ys[j]; });
  return { P, err: best.err };
}

export function surfaces(s, xg) {
  const yc = xg.map((x) => yAt(s.camber, x));
  const t = xg.map((x) => Math.max(0, yAt(s.thick, x)));
  return {
    yc,
    t,
    yu: xg.map((_, i) => yc[i] + t[i] / 2),
    yl: xg.map((_, i) => yc[i] - t[i] / 2),
  };
}

export function coordsFromShape(s, n = 81) {
  const xg = cosGrid(n);
  const r = surfaces(s, xg);
  const up = xg.map((x, i) => [x, r.yu[i]]).reverse();
  const lo = xg.map((x, i) => [x, r.yl[i]]).slice(1);
  return up.concat(lo);
}

export function stats(s) {
  const xg = cosGrid(201);
  const r = surfaces(s, xg);
  let ic = 0;
  let it = 0;
  for (let i = 0; i < xg.length; i++) {
    if (Math.abs(r.yc[i]) > Math.abs(r.yc[ic])) ic = i;
    if (r.t[i] > r.t[it]) it = i;
  }
  return { camber: r.yc[ic], camberX: xg[ic], thick: r.t[it], thickX: xg[it] };
}

export function fitShape(coords) {
  const xg = cosGrid(61);
  const { yu, yl } = split(coords, xg);
  const camber = xg.map((_, i) => 0.5 * (yu[i] + yl[i]));
  const thick = xg.map((_, i) => Math.max(0, yu[i] - yl[i]));
  const tte = thick[thick.length - 1];
  const cam = fitCurve(xg, camber, [0, 0.3, 0.7, 1], [1, 2], [1, 2], [[0, 0], [3, 0]]);
  const th = fitCurve(xg, thick, [0, 0, 0.3, 0.7, 1], [2, 3], [1, 2, 3], [[0, 0], [4, tte]]);
  th.P.forEach((p, i) => {
    if (i > 0 && i < 4) p[1] = Math.max(i === 1 ? 0.005 : 0, p[1]);
  });
  const shape = { camber: cam.P, thick: th.P };
  const r = surfaces(shape, xg);
  let err = 0;
  xg.forEach((_, i) => {
    err = Math.max(err, Math.abs(r.yu[i] - yu[i]), Math.abs(r.yl[i] - yl[i]));
  });
  return { shape, err };
}

export const BZ = { point, yAt, fit: fitShape, surfaces, coords: coordsFromShape, stats, cosGrid };
