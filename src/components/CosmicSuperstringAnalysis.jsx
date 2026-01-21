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
  const [results, setResults] = useState(null);
  const [ptaData, setPtaData] = useState(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);

  // Preview sliders (log-space)
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
    <div className="card card-pad">
      <div className="h2">Modular, Worker-Accelerated SGWB Inference Pipeline</div>
      <p className="p">
        Use sliders to preview a spectrum. Then run ensemble MCMC off-thread and
        compute KDE credible regions.
      </p>

      <hr className="hr" />

      <div className="h2">Live Spectrum Preview</div>
      <div className="muted">
        log10(Gmu)={logGmuPreview.toFixed(2)} &nbsp; log10(P)={logPPreview.toFixed(2)}
      </div>

      {!ptaData ? (
        <div className="row" style={{ marginTop: 10 }}>
          <span className="badge">
            <AlertCircle size={16} />
            PTA data not loaded yet. Click “Load PTA + Preview” or run analysis to auto-load.
          </span>
        </div>
      ) : (
        <div style={{ marginTop: 14 }}>
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

      <div style={{ marginTop: 14 }} className="grid2">
        <div>
          <div className="label">log10(Gmu)</div>
          <input
            className="range"
            type="range"
            min={-15}
            max={-6}
            step={0.05}
            value={logGmuPreview}
            onChange={(e) => setLogGmuPreview(parseFloat(e.target.value))}
          />
        </div>
        <div>
          <div className="label">log10(P)</div>
          <input
            className="range"
            type="range"
            min={-4}
            max={0}
            step={0.05}
            value={logPPreview}
            onChange={(e) => setLogPPreview(parseFloat(e.target.value))}
          />
        </div>
      </div>

      <div style={{ marginTop: 14 }} className="row">
        <button
          className="btn"
          onClick={async () => {
            setStage("loading");
            await loadPTA();
            setStage("setup");
          }}
        >
          Load PTA + Preview
        </button>

        <button className="btn" onClick={() => setShowSettings((s) => !s)}>
          <Settings size={16} />
          {showSettings ? "Hide" : "Show"} Advanced Settings
        </button>
      </div>

      {showSettings && (
        <div style={{ marginTop: 12 }} className="card card-pad">
          <div className="grid2">
            <div>
              <div className="label">MCMC Steps</div>
              <input
                className="input"
                type="number"
                value={settings.nSteps}
                onChange={(e) =>
                  setSettings({ ...settings, nSteps: parseInt(e.target.value, 10) })
                }
              />
            </div>
            <div>
              <div className="label">Walkers</div>
              <input
                className="input"
                type="number"
                value={settings.nWalkers}
                onChange={(e) =>
                  setSettings({ ...settings, nWalkers: parseInt(e.target.value, 10) })
                }
              />
            </div>
            <div>
              <div className="label">Harmonics (Nk)</div>
              <input
                className="input"
                type="number"
                value={settings.Nk}
                onChange={(e) =>
                  setSettings({ ...settings, Nk: parseInt(e.target.value, 10) })
                }
              />
            </div>
            <div>
              <div className="label">Max Redshift</div>
              <input
                className="input"
                type="number"
                value={settings.zMax}
                onChange={(e) =>
                  setSettings({ ...settings, zMax: parseInt(e.target.value, 10) })
                }
              />
            </div>
          </div>
        </div>
      )}

      <div style={{ marginTop: 14 }} className="card card-pad">
        <div className="h2">Implementation Notes</div>
        <ul className="p" style={{ marginTop: 8 }}>
          <li>Replace the example PTA JSON with real NANOGrav/EPTA/PPTA limits.</li>
          <li>For publication: increase steps/walkers and replace approximate t(z) with exact integral.</li>
          <li>MCMC runs in a Web Worker for responsiveness; main-thread fallback is included.</li>
        </ul>
      </div>

      <div style={{ marginTop: 14 }}>
        <button className="btn btn-primary" onClick={runAnalysis}>
          <Play size={18} />
          Launch Bayesian Analysis
        </button>
      </div>
    </div>
  );

  const renderProgress = () => (
    <div className="card card-pad" style={{ textAlign: "center" }}>
      <div className="row" style={{ justifyContent: "center" }}>
        <Loader2 className="spin" size={48} />
      </div>
      <div style={{ marginTop: 10 }} className="h2">
        {stage === "loading" && "Loading Data"}
        {stage === "mcmc" && "Running Ensemble MCMC (Web Worker)"}
        {stage === "analyzing" && "Computing KDE Credible Regions"}
      </div>
      {stage === "mcmc" && (
        <div className="muted" style={{ marginTop: 6 }}>
          Step {progress.step} / {progress.totalSteps} — Acceptance{" "}
          {(progress.acceptanceRate * 100).toFixed(1)}%
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
        <div className="card card-pad">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div>
              <div className="row">
                <CheckCircle2 size={18} />
                <strong>Analysis Complete</strong>
              </div>
              <div className="muted" style={{ marginTop: 6 }}>
                Sampled {results.mcmc.samples.length.toLocaleString()} points — Acceptance{" "}
                {(results.mcmc.acceptanceRate * 100).toFixed(1)}%
              </div>
            </div>

            <div className="row">
              <button className="btn" onClick={exportResultsJSON}>
                <Download size={16} /> JSON
              </button>
              <button className="btn" onClick={exportSamplesCSV}>
                <Download size={16} /> Samples CSV
              </button>
              <button className="btn" onClick={exportKDECSV}>
                <Download size={16} /> KDE CSV
              </button>
            </div>
          </div>
        </div>

        <div className="card card-pad">
          <div className="h2">Spectrum vs PTA Limits</div>
          <div style={{ marginTop: 10 }}>
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
        </div>

        <div className="card card-pad">
          <div className="h2">Posterior KDE (Filtered)</div>
          <div style={{ marginTop: 10 }}>
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
      </div>
    );
  };

  const renderError = () => (
    <div className="card card-pad">
      <div className="row">
        <AlertCircle size={18} />
        <strong>Run Failed</strong>
      </div>
      <div className="muted" style={{ marginTop: 6 }}>
        {errorMsg || "Unknown error."}
      </div>
    </div>
  );

  return (
    <div style={{ minHeight: "100vh" }}>
      {/* HERO */}
      <div
        style={{
          height: 340,
          backgroundImage: `linear-gradient(to bottom, rgba(0,0,0,0.55), rgba(0,0,0,0.88)), url(${heroUrl})`,
          backgroundSize: "cover",
          backgroundPosition: "center",
          display: "flex",
          alignItems: "flex-end",
        }}
      >
        <div className="container" style={{ paddingBottom: 22 }}>
          <div className="h1">Cosmic Superstring Constraints</div>
          <div className="subtitle">
            PTA upper-limit likelihood + affine-invariant ensemble MCMC + Web Worker acceleration.
          </div>
        </div>
      </div>

      {/* MAIN */}
      <div className="container">
        {stage === "setup" && renderSetup()}
        {(stage === "loading" || stage === "mcmc" || stage === "analyzing") && renderProgress()}
        {stage === "complete" && renderResults()}
        {stage === "error" && renderError()}
      </div>
    </div>
  );
}
