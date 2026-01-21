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

  const [logGmuPreview, setLogGmuPreview] = useState(-11.0);
  const [logPPreview, setLogPPreview] = useState(-2.0);

  const workerRef = useRef(null);

  useEffect(() => {
    buildCosmologyCache(settings.zMax, 600);
  }, [settings.zMax]);

  useEffect(() => {
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
    try {
      const data = await loadPTALimitsJSON("/data/pta_limits_example.json");
      setPtaData(data);
      return data;
    } catch {
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
    downloadText(
      "mcmc_samples.csv",
      toCSV(rows, ["logGmu", "logP", "Gmu", "P"]),
      "text/csv"
    );
  };

  const exportKDECSV = () => {
    if (!results) return;
    downloadText(
      "kde_grid.csv",
      toCSV(results.kde.grid, ["logGmu", "logP", "density"]),
      "text/csv"
    );
  };

  const heroUrl = `${import.meta.env.BASE_URL}hero.jpg`;

  const renderSetup = () => (
    <div style={{ background: "white", borderRadius: 12, padding: 18 }}>
      <h2 style={{ marginTop: 0 }}>
        Modular, Worker-Accelerated SGWB Inference Pipeline
      </h2>
      <p style={{ color: "#334155" }}>
        Use sliders to preview a spectrum. Then run ensemble MCMC off-thread and
        compute KDE credible regions.
      </p>

      {!ptaData ? (
        <div style={{ display: "flex", gap: 8, alignItems: "center", color: "#475569" }}>
          <AlertCircle size={16} /> PTA data not loaded yet. Click “Load PTA + Preview” or run analysis to auto-load.
        </div>
      ) : (
        <div style={{ marginTop: 12 }}>
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={spectrumData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="logFreq" />
              <YAxis />
              <Tooltip />
              <Legend />
              <Line type="monotone" dataKey="logOmegaModel" strokeWidth={2} name="Model" dot={false} />
              <Line type="monotone" dataKey="logOmegaLimit" strokeWidth={2} strokeDasharray="5 5" name="PTA Limit" dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      <div style={{ marginTop: 14 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <div style={{ fontWeight: 600 }}>log10(Gmu) = {logGmuPreview.toFixed(2)}</div>
            <input
              type="range"
              min={-15}
              max={-6}
              step={0.05}
              value={logGmuPreview}
              onChange={(e) => setLogGmuPreview(parseFloat(e.target.value))}
              style={{ width: "100%" }}
            />
          </div>
          <div>
            <div style={{ fontWeight: 600 }}>log10(P) = {logPPreview.toFixed(2)}</div>
            <input
              type="range"
              min={-4}
              max={0}
              step={0.05}
              value={logPPreview}
              onChange={(e) => setLogPPreview(parseFloat(e.target.value))}
              style={{ width: "100%" }}
            />
          </div>
        </div>

        <div style={{ marginTop: 12, display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button onClick={async () => { setStage("loading"); await loadPTA(); setStage("setup"); }}>
            Load PTA + Preview
          </button>
          <button onClick={() => setShowSettings((s) => !s)}>
            <Settings size={14} /> {showSettings ? "Hide" : "Show"} Advanced Settings
          </button>
        </div>

        {showSettings && (
          <div style={{ marginTop: 10, padding: 12, border: "1px solid #e2e8f0", borderRadius: 10 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <label>
                Steps
                <input
                  type="number"
                  value={settings.nSteps}
                  onChange={(e) => setSettings({ ...settings, nSteps: parseInt(e.target.value, 10) })}
                  style={{ width: "100%" }}
                />
              </label>
              <label>
                Walkers
                <input
                  type="number"
                  value={settings.nWalkers}
                  onChange={(e) => setSettings({ ...settings, nWalkers: parseInt(e.target.value, 10) })}
                  style={{ width: "100%" }}
                />
              </label>
              <label>
                Nk
                <input
                  type="number"
                  value={settings.Nk}
                  onChange={(e) => setSettings({ ...settings, Nk: parseInt(e.target.value, 10) })}
                  style={{ width: "100%" }}
                />
              </label>
              <label>
                zMax
                <input
                  type="number"
                  value={settings.zMax}
                  onChange={(e) => setSettings({ ...settings, zMax: parseInt(e.target.value, 10) })}
                  style={{ width: "100%" }}
                />
              </label>
            </div>
          </div>
        )}

        <div style={{ marginTop: 14 }}>
          <button onClick={runAnalysis} style={{ padding: "10px 14px" }}>
            <Play size={16} /> Launch Bayesian Analysis
          </button>
        </div>
      </div>
    </div>
  );

  const renderProgress = () => (
    <div style={{ background: "white", borderRadius: 12, padding: 18, textAlign: "center" }}>
      <Loader2 className="spin" size={48} />
      <h3 style={{ marginBottom: 6 }}>
        {stage === "loading" && "Loading Data"}
        {stage === "mcmc" && "Running Ensemble MCMC (Web Worker)"}
        {stage === "analyzing" && "Computing KDE Credible Regions"}
      </h3>
      {stage === "mcmc" && (
        <div style={{ color: "#475569" }}>
          Step {progress.step} / {progress.totalSteps} — Acceptance {(progress.acceptanceRate * 100).toFixed(1)}%
        </div>
      )}
    </div>
  );

  const renderResults = () => {
    if (!results || !ptaData) return null;

    const threshold = results.levels.level95 * 0.1;
    const filtered = results.kde.grid.filter((p) => p.density > threshold);

    return (
      <div style={{ display: "grid", gap: 14 }}>
        <div style={{ background: "white", borderRadius: 12, padding: 18 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <CheckCircle2 size={18} />
                <strong>Analysis Complete</strong>
              </div>
              <div style={{ color: "#475569", marginTop: 6 }}>
                Samples: {results.mcmc.samples.length.toLocaleString()} — Acceptance {(results.mcmc.acceptanceRate * 100).toFixed(1)}%
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button onClick={exportResultsJSON}><Download size={16} /> JSON</button>
              <button onClick={exportSamplesCSV}><Download size={16} /> Samples CSV</button>
              <button onClick={exportKDECSV}><Download size={16} /> KDE CSV</button>
            </div>
          </div>
        </div>

        <div style={{ background: "white", borderRadius: 12, padding: 18 }}>
          <h3 style={{ marginTop: 0 }}>Spectrum vs PTA Limits</h3>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={spectrumData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="logFreq" />
              <YAxis />
              <Tooltip />
              <Legend />
              <Line type="monotone" dataKey="logOmegaModel" strokeWidth={2} name="Model" dot={false} />
              <Line type="monotone" dataKey="logOmegaLimit" strokeWidth={2} strokeDasharray="5 5" name="PTA Limit" dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>

        <div style={{ background: "white", borderRadius: 12, padding: 18 }}>
          <h3 style={{ marginTop: 0 }}>Posterior KDE (Filtered)</h3>
          <ResponsiveContainer width="100%" height={420}>
            <ScatterChart margin={{ top: 20, right: 60, bottom: 50, left: 70 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis type="number" dataKey="logGmu" domain={[-15, -6]} />
              <YAxis type="number" dataKey="logP" domain={[-4, 0]} />
              <Tooltip />
              <Scatter data={filtered} fillOpacity={0.5} />
              <ReferenceLine y={0} strokeWidth={2} />
            </ScatterChart>
          </ResponsiveContainer>
        </div>
      </div>
    );
  };

  const renderError = () => (
    <div style={{ background: "white", borderRadius: 12, padding: 18, color: "#b91c1c" }}>
      <strong>Run Failed:</strong> {errorMsg || "Unknown error."}
    </div>
  );

  return (
    <div style={{ minHeight: "100vh", background: "#0b0f14" }}>
      {/* HERO */}
      <div
        style={{
          height: "320px",
          backgroundImage: `linear-gradient(to bottom, rgba(0,0,0,0.65), rgba(0,0,0,0.85)), url(${heroUrl})`,
          backgroundSize: "cover",
          backgroundPosition: "center",
          display: "flex",
          alignItems: "flex-end",
        }}
      >
        <div style={{ padding: "28px", color: "white", maxWidth: "1100px", width: "100%" }}>
          <h1 style={{ margin: 0, fontSize: "40px", fontWeight: 800 }}>Cosmic Superstring Constraints</h1>
          <p style={{ marginTop: "10px", marginBottom: 0, opacity: 0.9 }}>
            PTA upper-limit likelihood + affine-invariant ensemble MCMC + Web Worker acceleration.
          </p>
        </div>
      </div>

      {/* MAIN */}
      <div style={{ maxWidth: "1100px", margin: "0 auto", padding: "24px" }}>
        {stage === "setup" && renderSetup()}
        {(stage === "loading" || stage === "mcmc" || stage === "analyzing") && renderProgress()}
        {stage === "complete" && renderResults()}
        {stage === "error" && renderError()}
      </div>
    </div>
  );
}
