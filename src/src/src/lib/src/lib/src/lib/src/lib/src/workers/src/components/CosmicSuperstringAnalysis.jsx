/* code/src/components/CosmicSuperstringAnalysis.jsx
 * Main UI: live spectrum preview, worker MCMC, KDE, exports.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ScatterChart,
  Scatter,
  ReferenceLine,
} from "recharts";

import {
  Play,
  Download,
  AlertCircle,
  CheckCircle2,
  Loader2,
  Settings,
} from "lucide-react";

import { buildCosmologyCache, calculateOmegaGW } from "../lib/physics.js";
import { loadPTALimitsJSON, generateMockPTALimits } from "../lib/ptaData.js";
import { kde2D, findCredibleLevels } from "../lib/analysis.js";

function downloadText(filename, text, mime = "text/plain") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function toCSV(rows, header) {
  const lines = [];
  lines.push(header.join(","));
  for (const r of rows) {
    lines.push(header.map((h) => String(r[h] ?? "")).join(","));
  }
  return lines.join("\n");
}

const DEFAULT_SETTINGS = {
  nSteps: 1200,
  nWalkers: 24,
  burnIn: 0.5,
  Nk: 40,
  zMax: 8,
  adaptiveTol: 1e-4,
  progressEvery: 50,
};

export default function CosmicSuperstringAnalysis() {
  const [stage, setStage] = useState("setup"); // setup|loading|mcmc|analyzing|complete|error
  const [progress, setProgress] = useState({
    step: 0,
    totalSteps: DEFAULT_SETTINGS.nSteps,
    acceptanceRate: 0,
  });
  const [ptaData, setPtaData] = useState(null);
  const [results, setResults] = useState(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);

  // Live preview parameters (log10-space)
  const [logGmuPreview, setLogGmuPreview] = useState(-11.0);
  const [logPPreview, setLogPPreview] = useState(-2.0);

  const workerRef = useRef(null);

  useEffect(() => {
    buildCosmologyCache(settings.zMax, 600);
  }, [settings.zMax]);

  useEffect(() => {
    // Vite module worker pattern
    try {
      workerRef.current = new Worker(
        new URL("../workers/mcmcWorker.js", import.meta.url),
        { type: "module" }
      );
    } catch {
      workerRef.current = null;
    }

    return () => {
      if (workerRef.current) workerRef.current.terminate();
    };
  }, []);

  const physicsOptions = useMemo(
    () => ({
      Nk: settings.Nk,
      zMax: settings.zMax,
      adaptiveTol: settings.adaptiveTol,
      nz: 600,
    }),
    [settings.Nk, settings.zMax, settings.adaptiveTol]
  );

  const loadPTA = async () => {
    // Put a real asset at /data/pta_limits_example.json in the web app
    // (public/data/pta_limits_example.json in Vite/CRA)
    try {
      const data = await loadPTALimitsJSON("/data/pta_limits_example.json");
      setPtaData(data);
      return data;
    } catch {
      // fallback demo
      const mock = generateMockPTALimits();
      setPtaData(mock);
      return mock;
    }
  };

  const spectrumData = useMemo(() => {
    if (!ptaData) return [];
    const Gmu = Math.pow(10, logGmuPreview);
    const P = Math.pow(10, logPPreview);

    const out = [];
    for (let i = 0; i < ptaData.frequencies.length; i++) {
      const f = ptaData.frequencies[i];
      const model = calculateOmegaGW(f, Gmu, P, physicsOptions);
      const limit = ptaData.upperLimits[i];

      out.push({
        logFreq: Math.log10(f),
        logOmegaModel: Math.log10(Math.max(model, 1e-40)),
        logOmegaLimit: Math.log10(Math.max(limit, 1e-40)),
      });
    }
    return out;
  }, [ptaData, logGmuPreview, logPPreview, physicsOptions]);

  const runAnalysis = async () => {
    setErrorMsg("");
    setResults(null);
    setStage("loading");

    const data = await loadPTA();

    setStage("mcmc");
    setProgress({ step: 0, totalSteps: settings.nSteps, acceptanceRate: 0 });

    const worker = workerRef.current;
    if (!worker) {
      // Fallback: run on main thread (not preferred)
      const { runEnsembleMCMC } = await import("../lib/mcmc.js");
      const mcmc = runEnsembleMCMC(
        data,
        {
          nSteps: settings.nSteps,
          nWalkers: settings.nWalkers,
          burnIn: settings.burnIn,
          physicsOptions,
          progressEvery: settings.progressEvery,
        },
        (p) => setProgress(p)
      );

      setStage("analyzing");
      const kde = kde2D(mcmc.samples, 60, 0.18);
      const levels = findCredibleLevels(kde.densityGrid);

      setResults({ mcmc, kde, levels });
      setStage("complete");
      return;
    }

    const onMessage = (ev) => {
      const msg = ev.data;
      if (msg?.type === "PROGRESS") {
        setProgress(msg.progress);
      } else if (msg?.type === "DONE") {
        worker.removeEventListener("message", onMessage);

        const mcmc = msg.result;

        setStage("analyzing");
        const kde = kde2D(mcmc.samples, 60, 0.18);
        const levels = findCredibleLevels(kde.densityGrid);

        setResults({ mcmc, kde, levels });
        setStage("complete");
      } else if (msg?.type === "ERROR") {
        worker.removeEventListener("message", onMessage);
        setErrorMsg(msg.message ?? "Worker error");
        setStage("error");
      }
    };

    worker.addEventListener("message", onMessage);

    worker.postMessage({
      type: "RUN",
      ptaData: data,
      options: {
        nSteps: settings.nSteps,
        nWalkers: settings.nWalkers,
        burnIn: settings.burnIn,
        physicsOptions,
        progressEvery: settings.progressEvery,
      },
    });
  };

  const exportResultsJSON = () => {
    if (!results) return;
    const payload = {
      meta: {
        createdAt: new Date().toISOString(),
        settings,
        ptaName: ptaData?.name ?? null,
      },
      mcmc: {
        samples: results.mcmc.samples,
        logProbs: results.mcmc.logProbs,
        acceptanceRate: results.mcmc.acceptanceRate,
      },
      kde: results.kde,
      levels: results.levels,
    };
    downloadText(
      "cosmic_superstring_results.json",
      JSON.stringify(payload, null, 2),
      "application/json"
    );
  };

  const exportSamplesCSV = () => {
    if (!results) return;
    const rows = results.mcmc.samples.map((s) => ({
      logGmu: Math.log10(s.Gmu),
      logP: s.logP,
      Gmu: s.Gmu,
      P: Math.pow(10, s.logP),
    }));
    downloadText("mcmc_samples.csv", toCSV(rows, ["logGmu", "logP", "Gmu", "P"]), "text/csv");
  };

  const exportKDECSV = () => {
    if (!results) return;
    downloadText("kde_grid.csv", toCSV(results.kde.grid, ["logGmu", "logP", "density"]), "text/csv");
  };

  const renderSetup = () => (
    <div className="space-y-6">
      <div className="bg-gradient-to-r from-blue-50 to-indigo-50 rounded-lg p-6 border border-blue-200">
        <h2 className="text-xl font-semibold mb-2 text-blue-900">
          Modular, Worker-Accelerated SGWB Inference Pipeline
        </h2>
        <p className="text-sm text-blue-800">
          Use sliders to preview a spectrum. Then run ensemble MCMC off-thread and compute KDE credible regions.
        </p>
      </div>

      <div className="bg-white border rounded-lg p-5 space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h3 className="font-semibold text-lg">Live Spectrum Preview</h3>
          <div className="text-sm text-gray-600">
            log10(Gμ)={logGmuPreview.toFixed(2)} &nbsp; log10(P)={logPPreview.toFixed(2)}
          </div>
        </div>

        {!ptaData ? (
          <div className="text-sm text-gray-600 flex items-center gap-2">
            <AlertCircle size={16} />
            PTA data not loaded yet. Click “Load PTA + Preview” or run analysis to auto-load.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={spectrumData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis
                dataKey="logFreq"
                label={{ value: "log10(f [Hz])", position: "insideBottom", offset: -5 }}
              />
              <YAxis
                label={{ value: "log10(Ωgw)", angle: -90, position: "insideLeft" }}
              />
              <Tooltip />
              <Legend />
              <Line type="monotone" dataKey="logOmegaModel" strokeWidth={2} name="Model" dot={false} />
              <Line type="monotone" dataKey="logOmegaLimit" strokeWidth={2} strokeDasharray="5 5" name="PTA Limit" dot={false} />
            </LineChart>
          </ResponsiveContainer>
        )}

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium mb-1">log10(Gμ)</label>
            <input
              type="range"
              min={-15}
              max={-6}
              step={0.05}
              value={logGmuPreview}
              onChange={(e) => setLogGmuPreview(parseFloat(e.target.value))}
              className="w-full"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">log10(P)</label>
            <input
              type="range"
              min={-4}
              max={0}
              step={0.05}
              value={logPPreview}
              onChange={(e) => setLogPPreview(parseFloat(e.target.value))}
              className="w-full"
            />
          </div>
        </div>

        <div className="flex gap-3 flex-wrap">
          <button
            onClick={async () => {
              setStage("loading");
              await loadPTA();
              setStage("setup");
            }}
            className="px-4 py-2 border rounded-lg hover:bg-gray-50"
          >
            Load PTA + Preview
          </button>

          <button
            onClick={() => setShowSettings((s) => !s)}
            className="px-4 py-2 border rounded-lg hover:bg-gray-50 flex items-center gap-2"
          >
            <Settings size={16} />
            {showSettings ? "Hide" : "Show"} Advanced Settings
          </button>
        </div>

        {showSettings && (
          <div className="bg-gray-50 rounded-lg p-4 space-y-3 border">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1">MCMC Steps</label>
                <input
                  type="number"
                  value={settings.nSteps}
                  onChange={(e) => setSettings({ ...settings, nSteps: parseInt(e.target.value, 10) })}
                  className="w-full px-3 py-2 border rounded"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Walkers</label>
                <input
                  type="number"
                  value={settings.nWalkers}
                  onChange={(e) => setSettings({ ...settings, nWalkers: parseInt(e.target.value, 10) })}
                  className="w-full px-3 py-2 border rounded"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Harmonics (Nk)</label>
                <input
                  type="number"
                  value={settings.Nk}
                  onChange={(e) => setSettings({ ...settings, Nk: parseInt(e.target.value, 10) })}
                  className="w-full px-3 py-2 border rounded"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Max Redshift</label>
                <input
                  type="number"
                  value={settings.zMax}
                  onChange={(e) => setSettings({ ...settings, zMax: parseInt(e.target.value, 10) })}
                  className="w-full px-3 py-2 border rounded"
                />
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
        <div className="flex items-start gap-2">
          <AlertCircle className="text-amber-600 mt-0.5" size={18} />
          <div className="text-sm text-amber-900">
            <p className="font-medium mb-1">Implementation Notes</p>
            <ul className="space-y-1 text-amber-800 ml-4 list-disc">
              <li>Replace the example PTA JSON with real NANOGrav/EPTA/PPTA limits.</li>
              <li>For publication: increase steps/walkers and replace approximate t(z) with exact integral.</li>
              <li>MCMC runs in a Web Worker for responsiveness; main-thread fallback is included.</li>
            </ul>
          </div>
        </div>
      </div>

      <button
        onClick={runAnalysis}
        className="w-full bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white font-semibold py-4 px-6 rounded-lg transition flex items-center justify-center gap-2 shadow-lg"
      >
        <Play size={20} />
        Launch Bayesian Analysis
      </button>
    </div>
  );

  const renderProgress = () => (
    <div className="py-12">
      <div className="max-w-md mx-auto text-center space-y-6">
        <Loader2 className="animate-spin mx-auto text-blue-600" size={56} />
        <div>
          <h3 className="text-2xl font-semibold mb-2">
            {stage === "loading" && "Loading Data"}
            {stage === "mcmc" && "Running Ensemble MCMC (Web Worker)"}
            {stage === "analyzing" && "Computing KDE Credible Regions"}
          </h3>

          {stage === "mcmc" && (
            <>
              <div className="w-full bg-gray-200 rounded-full h-4 mb-3">
                <div
                  className="bg-gradient-to-r from-blue-600 to-indigo-600 h-4 rounded-full transition-all duration-300"
                  style={{ width: `${(progress.step / progress.totalSteps) * 100}%` }}
                />
              </div>
              <div className="text-gray-600 space-y-1">
                <p>
                  Step {progress.step} / {progress.totalSteps}
                </p>
                <p className="text-sm">
                  Acceptance rate: {(progress.acceptanceRate * 100).toFixed(1)}%
                </p>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );

  const renderResults = () => {
    if (!results || !ptaData) return null;

    const threshold = results.levels.level95 * 0.1;
    const filtered = results.kde.grid
      .filter((p) => p.density > threshold)
      .map((p) => ({ ...p })); // recharts reads plain objects

    return (
      <div className="space-y-6">
        <div className="bg-gradient-to-r from-green-50 to-emerald-50 border border-green-200 rounded-lg p-4">
          <div className="flex items-start gap-3">
            <CheckCircle2 className="text-green-600 mt-0.5" size={20} />
            <div className="flex-1">
              <h3 className="font-semibold text-green-900 mb-1">Analysis Complete</h3>
              <div className="text-sm text-green-800 space-y-1">
                <p>Sampled {results.mcmc.samples.length.toLocaleString()} posterior points</p>
                <p>Final acceptance rate: {(results.mcmc.acceptanceRate * 100).toFixed(1)}%</p>
                <p>
                  KDE levels: 68%={results.levels.level68.toExponential(3)}, 95%={results.levels.level95.toExponential(3)}
                </p>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <button
                onClick={exportResultsJSON}
                className="px-3 py-2 border rounded-lg hover:bg-white flex items-center gap-2"
              >
                <Download size={16} />
                JSON
              </button>
              <button
                onClick={exportSamplesCSV}
                className="px-3 py-2 border rounded-lg hover:bg-white flex items-center gap-2"
              >
                <Download size={16} />
                Samples CSV
              </button>
              <button
                onClick={exportKDECSV}
                className="px-3 py-2 border rounded-lg hover:bg-white flex items-center gap-2"
              >
                <Download size={16} />
                KDE CSV
              </button>
            </div>
          </div>
        </div>

        <div className="bg-white border rounded-lg p-6">
          <h3 className="font-semibold text-lg mb-4">
            Spectrum (Preview Params) vs PTA Upper Limits
          </h3>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={spectrumData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis
                dataKey="logFreq"
                label={{ value: "log10(f [Hz])", position: "insideBottom", offset: -5 }}
              />
              <YAxis label={{ value: "log10(Ωgw)", angle: -90, position: "insideLeft" }} />
              <Tooltip />
              <Legend />
              <Line type="monotone" dataKey="logOmegaModel" strokeWidth={2} name="Model" dot={false} />
              <Line type="monotone" dataKey="logOmegaLimit" strokeWidth={2} strokeDasharray="5 5" name="PTA Limit" dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>

        <div className="bg-white border rounded-lg p-6">
          <h3 className="font-semibold text-lg mb-4">Posterior KDE (Filtered)</h3>
          <ResponsiveContainer width="100%" height={420}>
            <ScatterChart margin={{ top: 20, right: 60, bottom: 50, left: 70 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis
                type="number"
                dataKey="logGmu"
                domain={[-15, -6]}
                label={{ value: "log10(Gμ)", position: "insideBottom", offset: -15 }}
              />
              <YAxis
                type="number"
                dataKey="logP"
                domain={[-4, 0]}
                label={{ value: "log10(P)", angle: -90, position: "insideLeft" }}
              />
              <Tooltip />
              <Scatter data={filtered} fillOpacity={0.5} />
              <ReferenceLine y={0} strokeWidth={2} label="P=1" />
            </ScatterChart>
          </ResponsiveContainer>
        </div>
      </div>
    );
  };

  const renderError = () => (
    <div className="bg-red-50 border border-red-200 rounded-lg p-4">
      <div className="flex items-start gap-2">
        <AlertCircle className="text-red-600 mt-0.5" size={18} />
        <div className="text-sm text-red-900">
          <div className="font-medium mb-1">Run Failed</div>
          <div>{errorMsg || "Unknown error."}</div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-6">
      <div className="max-w-7xl mx-auto">
        <div className="bg-white rounded-xl shadow-xl p-8">
          <div className="mb-8">
            <h1 className="text-4xl font-bold text-gray-900 mb-3">
              Cosmic Superstring Constraints
            </h1>
            <p className="text-gray-600">
              PTA upper-limit likelihood + affine-invariant ensemble MCMC + Web Worker acceleration.
            </p>
          </div>

          {stage === "setup" && renderSetup()}
          {(stage === "loading" || stage === "mcmc" || stage === "analyzing") && renderProgress()}
          {stage === "complete" && renderResults()}
          {stage === "error" && renderError()}
        </div>
      </div>
    </div>
  );
}
