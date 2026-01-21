/* src/lib/lisaData.js
 * LISA forecast/noise loader.
 * Schema:
 * {
 *  name: string,
 *  frequency_unit: "Hz" | "mHz",
 *  frequencies: number[],
 *  omega_forecast: number[],
 *  sigma: number[]
 * }
 */

function toFloat64(arr) {
  return arr instanceof Float64Array ? arr : new Float64Array(arr);
}

export async function loadLISAJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load LISA JSON: ${res.status}`);
  const j = await res.json();

  const unit = (j.frequency_unit ?? "Hz").toLowerCase();
  const scale = unit === "mhz" ? 1e-3 : 1.0;

  const f = j.frequencies.map((x) => x * scale);
  const omegaForecast = j.omega_forecast.slice();
  const sigma = j.sigma.slice();

  if (f.length !== omegaForecast.length || f.length !== sigma.length) {
    throw new Error("LISA JSON arrays must have same length: frequencies, omega_forecast, sigma");
  }

  return {
    name: j.name ?? "LISA dataset",
    frequencies: toFloat64(f),
    omegaForecast: toFloat64(omegaForecast),
    sigma: toFloat64(sigma),
    notes: j.notes ?? ""
  };
}
