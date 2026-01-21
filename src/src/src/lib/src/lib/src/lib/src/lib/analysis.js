/* code/src/lib/analysis.js
 * 2D KDE and credible-level extraction for posterior visualization.
 */

export function kde2D(samples, gridSize = 60, bandwidth = 0.2) {
  const logGmuVals = samples.map((s) => Math.log10(s.Gmu));
  const logPVals = samples.map((s) => s.logP);

  const logGmuMin = Math.min(...logGmuVals) - bandwidth;
  const logGmuMax = Math.max(...logGmuVals) + bandwidth;
  const logPMin = Math.min(...logPVals) - bandwidth;
  const logPMax = Math.max(...logPVals) + bandwidth;

  const grid = [];
  const densityGrid = Array.from({ length: gridSize }, () =>
    Array(gridSize).fill(0)
  );

  const norm = samples.length * 2 * Math.PI * bandwidth * bandwidth;

  for (let j = 0; j < gridSize; j++) {
    const logP = logPMin + (j / (gridSize - 1)) * (logPMax - logPMin);
    for (let i = 0; i < gridSize; i++) {
      const logGmu =
        logGmuMin + (i / (gridSize - 1)) * (logGmuMax - logGmuMin);

      let density = 0;
      for (let k = 0; k < samples.length; k++) {
        const dx = (logGmu - logGmuVals[k]) / bandwidth;
        const dy = (logP - logPVals[k]) / bandwidth;
        density += Math.exp(-0.5 * (dx * dx + dy * dy));
      }

      density /= norm;
      densityGrid[j][i] = density;
      grid.push({ logGmu, logP, density });
    }
  }

  return {
    grid,
    densityGrid,
    logGmuMin,
    logGmuMax,
    logPMin,
    logPMax,
    gridSize,
    bandwidth,
  };
}

export function findCredibleLevels(
  densityGrid,
  { levelA = 0.68, levelB = 0.95 } = {}
) {
  const flat = densityGrid.flat().slice().sort((a, b) => b - a);
  const total = flat.reduce((a, b) => a + b, 0);

  let cum = 0;
  let levA = 0;
  let levB = 0;

  for (let i = 0; i < flat.length; i++) {
    cum += flat[i];
    const frac = cum / total;

    if (frac >= levelA && levA === 0) levA = flat[i];
    if (frac >= levelB && levB === 0) {
      levB = flat[i];
      break;
    }
  }

  return { level68: levA, level95: levB };
}
