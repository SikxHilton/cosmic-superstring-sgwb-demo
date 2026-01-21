/* code/src/lib/ptaData.js
 * Load PTA limits from JSON or CSV and normalize units.
 * Supported formats:
 *  - OmegaGW: upper_limits are Omega_GW(f)
 *  - Sh:      upper_limits are strain PSD S_h(f) [1/Hz]
 *  - hc:      upper_limits are characteristic strain h_c(f)
 */

import { Sh_to_OmegaGW } from "./physics.js";

function toFloat64(arr) {
  return arr instanceof Float64Array ? arr : new Float64Array(arr);
}

export async function loadPTALimitsJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load PTA JSON: ${res.status}`);
  const j = await res.json();

  const name = j.name ?? "PTA dataset";
  const format = (j.format ?? "OmegaGW").toLowerCase();

  const freqUnit = (j.frequency_unit ?? "Hz").toLowerCase();
  const freqScale = freqUnit === "nhz" ? 1e-9 : 1.0;

  const frequenciesHz = j.frequencies.map((x) => x * freqScale);

  let upperOmega = null;

  if (format === "omegagw") {
    upperOmega = j.upper_limits.slice();
  } else if (format === "sh") {
    upperOmega = frequenciesHz.map((f, i) => Sh_to_OmegaGW(f, j.upper_limits[i]));
  } else if (format === "hc") {
    upperOmega = frequenciesHz.map((f, i) => {
      const hc = j.upper_limits[i];
      const Sh = Math.pow(hc / f, 2);
      return Sh_to_OmegaGW(f, Sh);
    });
  } else {
    throw new Error(`Unknown PTA format: ${j.format}`);
  }

  const errs =
    j.errors && j.errors.length === upperOmega.length
      ? j.errors.slice()
      : upperOmega.map((x) => 0.2 * x);

  return {
    name,
    frequencies: toFloat64(frequenciesHz),
    upperLimits: toFloat64(upperOmega),
    errors: toFloat64(errs),
  };
}

export async function loadPTALimitsCSV(
  url,
  { frequencyUnit = "Hz", format = "OmegaGW" } = {}
) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load PTA CSV: ${res.status}`);
  const text = await res.text();

  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) throw new Error("CSV appears empty");

  const freqScale = frequencyUnit.toLowerCase() === "nhz" ? 1e-9 : 1.0;
  const fmt = format.toLowerCase();

  const freqs = [];
  const upper = [];
  const errs = [];

  // expected header: frequency,upper_limit,error
  for (let i = 1; i < lines.length; i++) {
    const [fStr, uStr, eStr] = lines[i].split(",").map((s) => s.trim());

    const f = parseFloat(fStr) * freqScale;
    const u = parseFloat(uStr);
    const e = eStr != null && eStr !== "" ? parseFloat(eStr) : NaN;

    freqs.push(f);

    if (fmt === "omegagw") {
      upper.push(u);
    } else if (fmt === "sh") {
      upper.push(Sh_to_OmegaGW(f, u));
    } else if (fmt === "hc") {
      const Sh = Math.pow(u / f, 2);
      upper.push(Sh_to_OmegaGW(f, Sh));
    } else {
      throw new Error(`Unknown format: ${format}`);
    }

    errs.push(isFinite(e) ? e : 0.2 * upper[upper.length - 1]);
  }

  return {
    name: "PTA CSV",
    frequencies: toFloat64(freqs),
    upperLimits: toFloat64(upper),
    errors: toFloat64(errs),
  };
}

// Keep a mock generator for offline/demo use
export function generateMockPTALimits() {
  const frequencies = [];
  const upperLimits = [];
  const errors = [];

  for (let i = 0; i < 15; i++) {
    const f = Math.pow(10, -9 + i * 0.15); // Hz
    frequencies.push(f);

    // Mock scaling ~ f^(-2/3) for characteristic strain, then convert
    const hc = 1e-15 * Math.pow(f / 1e-8, -2 / 3);
    const Sh = Math.pow(hc / f, 2);
    const omega = Sh_to_OmegaGW(f, Sh);

    upperLimits.push(omega);
    errors.push(0.2 * omega);
  }

  return {
    name: "NANOGrav 15yr (Mock)",
    frequencies: new Float64Array(frequencies),
    upperLimits: new Float64Array(upperLimits),
    errors: new Float64Array(errors),
  };
}
