import { calculateOmegaGW } from "./physics.js";

export function upperLimitLogLikelihood(model, upperLimit, sigma) {
  if (!(sigma > 0)) return Number.NEGATIVE_INFINITY;
  if (model > upperLimit) {
    const delta = (model - upperLimit) / sigma;
    return -0.5 * delta * delta;
  }
  return 0;
}

export function logPrior(Gmu, logP) {
  const logGmu = Math.log10(Gmu);
  if (logGmu < -15 || logGmu > -6) return Number.NEGATIVE_INFINITY;
  if (logP < -4 || logP > 0) return Number.NEGATIVE_INFINITY;
  return 0;
}

export function logLikelihoodPTA(Gmu, logP, ptaData, physicsOptions = {}) {
  const P = Math.pow(10, logP);
  let logL = 0;

  const { frequencies, upperLimits, errors } = ptaData;
  for (let i = 0; i < frequencies.length; i++) {
    const f = frequencies[i];
    const model = calculateOmegaGW(f, Gmu, P, physicsOptions);
    logL += upperLimitLogLikelihood(model, upperLimits[i], errors[i]);
  }
  return logL;
}

// Optional LISA Gaussian likelihood around omega_forecast with sigma
export function logLikelihoodLISA(Gmu, logP, lisaData, physicsOptions = {}) {
  if (!lisaData || !lisaData.frequencies?.length) return 0;

  const P = Math.pow(10, logP);
  let logL = 0;

  const { frequencies, omegaForecast, sigma } = lisaData;
  for (let i = 0; i < frequencies.length; i++) {
    const f = frequencies[i];
    const model = calculateOmegaGW(f, Gmu, P, physicsOptions);
    const s = sigma[i];
    if (!(s > 0)) continue;
    const r = (model - omegaForecast[i]) / s;
    logL += -0.5 * r * r;
  }
  return logL;
}

export function logPosterior(Gmu, logP, ptaData, options = {}) {
  const { physicsOptions = {}, lisaData = null, useLISA = false } = options;

  const lp = logPrior(Gmu, logP);
  if (!isFinite(lp)) return Number.NEGATIVE_INFINITY;

  const llPta = logLikelihoodPTA(Gmu, logP, ptaData, physicsOptions);
  if (!isFinite(llPta)) return Number.NEGATIVE_INFINITY;

  const llLisa = useLISA ? logLikelihoodLISA(Gmu, logP, lisaData, physicsOptions) : 0;
  if (!isFinite(llLisa)) return Number.NEGATIVE_INFINITY;

  return lp + llPta + llLisa;
}

// Goodman–Weare style stretch move, ndim=2
export function runEnsembleMCMC(ptaData, options = {}, onProgress = null) {
  const {
    nSteps = 2000,
    nWalkers = 32,
    burnIn = 0.5,
    physicsOptions = {},
    lisaData = null,
    useLISA = false,
    progressEvery = 50,
    rng = Math.random,
  } = options;

  const postOpts = { physicsOptions, lisaData, useLISA };

  let walkers = Array.from({ length: nWalkers }, () => ({
    Gmu: 1e-11 * Math.exp(0.3 * (rng() - 0.5)),
    logP: -2 + 0.5 * (rng() - 0.5),
    logProb: Number.NEGATIVE_INFINITY,
  }));

  for (let w = 0; w < nWalkers; w++) {
    walkers[w].logProb = logPosterior(walkers[w].Gmu, walkers[w].logP, ptaData, postOpts);
  }

  const samples = [];
  const logProbs = [];
  const a = 2.0;

  let acceptances = 0;
  let totalMoves = 0;
  const burnStart = Math.floor(nSteps * burnIn);

  for (let step = 0; step < nSteps; step++) {
    for (let w = 0; w < nWalkers; w++) {
      const current = walkers[w];

      let j = w;
      while (j === w) j = Math.floor(rng() * nWalkers);
      const comp = walkers[j];

      const z = Math.pow((a - 1) * rng() + 1, 2) / a;

      const proposed = {
        Gmu: comp.Gmu + z * (current.Gmu - comp.Gmu),
        logP: comp.logP + z * (current.logP - comp.logP),
        logProb: Number.NEGATIVE_INFINITY,
      };

      proposed.logProb = logPosterior(proposed.Gmu, proposed.logP, ptaData, postOpts);

      const logAcceptRatio = Math.log(z) + (proposed.logProb - current.logProb);

      if (Math.log(rng()) < logAcceptRatio) {
        walkers[w] = proposed;
        acceptances++;
      }
      totalMoves++;

      if (step >= burnStart) {
        samples.push({ Gmu: walkers[w].Gmu, logP: walkers[w].logP });
        logProbs.push(walkers[w].logProb);
      }
    }

    if (onProgress && (step % progressEvery === 0 || step === nSteps - 1)) {
      onProgress({
        step,
        totalSteps: nSteps,
        acceptanceRate: acceptances / Math.max(1, totalMoves),
      });
    }
  }

  return {
    samples,
    logProbs,
    acceptanceRate: acceptances / Math.max(1, totalMoves),
    nWalkers,
    nSteps,
    burnIn,
  };
}
