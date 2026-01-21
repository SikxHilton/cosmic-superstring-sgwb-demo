/* code/src/lib/physics.js
 * Cosmology cache + SGWB spectrum evaluator with adaptive Simpson integration.
 */

export const CONSTANTS = Object.freeze({
  // SI units unless noted
  H0: 2.184e-18, // Hubble constant in Hz (approx 67.4 km/s/Mpc)
  G_N: 6.674e-11,
  c: 2.998e8,
  Omega_m: 0.315,
  Omega_Lambda: 0.685,
});

let cosmologyCache = null;
let cosmologyKey = null;

export function buildCosmologyCache(zMax = 10, nz = 600) {
  const key = `${zMax}:${nz}`;
  if (cosmologyCache && cosmologyKey === key) return cosmologyCache;

  const zArr = new Float64Array(nz);
  const tArr = new Float64Array(nz);
  const dtdzArr = new Float64Array(nz);
  const HArr = new Float64Array(nz);

  for (let i = 0; i < nz; i++) {
    const z = (zMax * i) / (nz - 1);
    const a = 1 / (1 + z);

    const Ez = Math.sqrt(
      CONSTANTS.Omega_m * Math.pow(1 + z, 3) + CONSTANTS.Omega_Lambda
    );
    const Hz = CONSTANTS.H0 * Ez;

    // Speed-focused approximation:
// For publication-grade cosmology replace with the proper integral definition for t(z).
    const t = (2 / 3) / CONSTANTS.H0 * Math.pow(a, 1.5);

    // magnitude of dt/dz (positive)
    const dtdz = 1 / (Hz * (1 + z));

    zArr[i] = z;
    tArr[i] = t;
    dtdzArr[i] = dtdz;
    HArr[i] = Hz;
  }

  cosmologyCache = { zMax, nz, z: zArr, t: tArr, dtdz: dtdzArr, H: HArr };
  cosmologyKey = key;
  return cosmologyCache;
}

function interpolate(x, xArr, yArr) {
  const n = xArr.length;
  if (x <= xArr[0]) return yArr[0];
  if (x >= xArr[n - 1]) return yArr[n - 1];

  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xArr[mid] <= x) lo = mid;
    else hi = mid;
  }

  const t = (x - xArr[lo]) / (xArr[hi] - xArr[lo]);
  return yArr[lo] * (1 - t) + yArr[hi] * t;
}

function harmonicCoeffs(Nk) {
  const Gamma = 50.0;
  const coeffs = new Float64Array(Nk);
  for (let k = 0; k < Nk; k++) {
    coeffs[k] = Gamma / Math.pow(k + 1, 4 / 3);
  }
  return coeffs;
}

function simpson(a, b, fa, fb, fm) {
  return (b - a) * (fa + 4 * fm + fb) / 6;
}

function adaptiveSimpson(f, a, b, tol, maxDepth = 22) {
  const fa = f(a);
  const fb = f(b);
  const m = 0.5 * (a + b);
  const fm = f(m);
  const I1 = simpson(a, b, fa, fb, fm);

  function rec(a0, b0, fa0, fb0, fm0, I0, tol0, depth) {
    const m0 = 0.5 * (a0 + b0);
    const m1 = 0.5 * (a0 + m0);
    const m2 = 0.5 * (m0 + b0);

    const fm1 = f(m1);
    const fm2 = f(m2);

    const Ileft = simpson(a0, m0, fa0, fm0, fm1);
    const Iright = simpson(m0, b0, fm0, fb0, fm2);
    const I2 = Ileft + Iright;

    const err = Math.abs(I2 - I0);

    if (depth <= 0 || err < 15 * tol0) {
      return I2 + (I2 - I0) / 15;
    }

    return (
      rec(a0, m0, fa0, fm0, fm1, Ileft, tol0 / 2, depth - 1) +
      rec(m0, b0, fm0, fb0, fm2, Iright, tol0 / 2, depth - 1)
    );
  }

  return rec(a, b, fa, fb, fm, I1, tol, maxDepth);
}

export function calculateOmegaGW(f, Gmu, P, options = {}) {
  const {
    Nk = 50,
    alpha = 0.1,
    beta = 1.0,
    zMax = 10,
    nz = 600,
    adaptiveTol = 1e-4,
  } = options;

  if (!(f > 0) || !(Gmu > 0) || !(P > 0)) return 0;

  const cache = buildCosmologyCache(zMax, nz);

  // stylized VOS-inspired effective coefficient
  const Ceff = 0.1 * Math.pow(P, -0.6);

  // critical density
  const rho_c = (3 * Math.pow(CONSTANTS.H0, 2)) / (8 * Math.PI * CONSTANTS.G_N);

  const hCoeffs = harmonicCoeffs(Nk);

  const integrand = (z) => {
    const t = interpolate(z, cache.z, cache.t);
    const dtdz = interpolate(z, cache.z, cache.dtdz);
    if (!(t > 0)) return 0;

    // loop formation rate (parametric scaling)
    const dRhodt = (Ceff / (alpha * Math.pow(t, 4))) * Math.pow(Gmu, -beta);

    const fObs = f * (1 + z);

    let harmonicSum = 0;
    for (let k = 0; k < Nk; k++) {
      const kVal = k + 1;
      const Pk = hCoeffs[k] * Math.pow(Gmu, 2);
      harmonicSum += (2 * kVal / fObs) * Pk * dRhodt / rho_c;
    }

    return harmonicSum * dtdz;
  };

  return adaptiveSimpson(integrand, 0, zMax, adaptiveTol, 22);
}

export function Sh_to_OmegaGW(f, Sh) {
  if (!(f > 0) || !(Sh > 0)) return 0;
  return (
    (2 * Math.pow(Math.PI, 2)) / (3 * Math.pow(CONSTANTS.H0, 2)) *
    Math.pow(f, 3) *
    Sh
  );
}
