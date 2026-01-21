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
  ExternalLink,
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
  for (const r of rows) lines.push(header.map((h) => String(r[h] ?? "")).join(","));
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
  const [progress, setProgress] = useState({ step: 0, totalSteps: DEFAULT_SETTINGS.nSteps, acceptanceRate: 0 });
  const [results, setResults] = useState(null);
  const [ptaData, setPtaData] = useState(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);

  const [logGmuPreview, setLogGmuPreview] = useState(-11.0);
  const [logPPreview, setLogPPreview] = useState(-2.0);

  const workerRef = useRef(null);

  // Parallax state
  const [scrollY, setScrollY] = useState(0);
  useEffect(() => {
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setScrollY(window.scrollY || 0));
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll);
    };
  }, []);

  useEffect(() => {
    buildCosmologyCache(settings.zMax, 600);
  }, [settings.zMax]);

  useEffect(() => {
    try {
      workerRef.current = new Worker(new URL("../workers/mcmcWorker.js", import.meta.url), { type: "module" });
    } catch {
      workerRef.current = null;
    }
    return () => {
      if (workerRef.current) workerRef.current.terminate();
    };
  }, []);

  const physicsOptions = useMemo(
    () => ({ Nk: settings.Nk, zMax: settings.zMax, adaptiveTol: settings.adaptiveTol, nz: 600 }),
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
        logOmegaModel: Math.log10(Math.max(model, 1e-60)),
        logOmegaLimit: Math.log10(Math.max(limit, 1e-60)),
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
      // fallback (should rarely happen)
      const { runEnsembleMCMC } = await import("../lib/mcmc.js");
      const mcmc = runEnsembleMCMC(
        data,
        { nSteps: settings.nSteps, nWalkers: settings.nWalkers, burnIn: settings.burnIn, physicsOptions, progressEvery: settings.progressEvery },
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
      if (msg?.type === "PROGRESS") setProgress(msg.progress);
      else if (msg?.type === "DONE") {
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
      meta: { createdAt: new Date().toISOString(), settings, ptaName: ptaData?.name ?? null },
      mcmc: { samples: results.mcmc.samples, logProbs: results.mcmc.logProbs, acceptanceRate: results.mcmc.acceptanceRate },
      kde: results.kde,
      levels: results.levels,
    };
    downloadText("cosmic_superstring_results.json", JSON.stringify(payload, null, 2), "application/json");
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

  // assets + links
  const heroUrl = `${import.meta.env.BASE_URL}hero.jpg`;
  const doiUrl = "https://doi.org/10.5281/zenodo.18323281";
  const paperUrl = "https://doi.org/10.5281/zenodo.18299204";

  // parallax: adjust background position as you scroll
  const heroShift = Math.min(140, scrollY * 0.18);

  const css = `
:root{
  --bg:#070a10;
  --text:rgba(255,255,255,.92);
  --muted:rgba(255,255,255,.72);
  --muted2:rgba(255,255,255,.55);
  --panel:rgba(255,255,255,.06);
  --panel2:rgba(255,255,255,.09);
  --border:rgba(255,255,255,.14);
  --shadow: 0 18px 60px rgba(0,0,0,.55);
  --shadow2: 0 10px 30px rgba(0,0,0,.35);
  --r:18px;
  --accent:#60a5fa;
  --accent2:#22d3ee;
}
*{box-sizing:border-box}
html,body{height:100%}
body{
  margin:0;
  background:
    radial-gradient(1200px 700px at 30% -10%, rgba(96,165,250,0.18), transparent 60%),
    radial-gradient(900px 600px at 85% 0%, rgba(34,211,238,0.15), transparent 55%),
    var(--bg);
  color:var(--text);
  font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,"Apple Color Emoji","Segoe UI Emoji";
}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
.container{max-width:1100px;margin:0 auto;padding:24px}
.card{
  background:linear-gradient(180deg,var(--panel2),var(--panel));
  border:1px solid var(--border);
  border-radius:var(--r);
  box-shadow:var(--shadow2);
  backdrop-filter:blur(10px);
}
.pad{padding:18px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
@media (max-width: 860px){.grid2{grid-template-columns:1fr}}
.h1{margin:0;font-size:44px;font-weight:900;letter-spacing:-.02em}
.h2{margin:0 0 8px 0;font-size:20px;font-weight:800}
.p{margin:0;color:var(--muted);line-height:1.55}
.muted{color:var(--muted2)}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.hr{height:1px;border:none;background:rgba(255,255,255,.10);margin:14px 0}
.badge{
  display:inline-flex;align-items:center;gap:8px;
  padding:8px 10px;border-radius:999px;
  border:1px solid var(--border);
  background:rgba(255,255,255,.06);
  color:var(--muted);font-weight:800;
}
.btn{
  appearance:none;
  border:1px solid var(--border);
  background:rgba(255,255,255,.06);
  color:var(--text);
  border-radius:14px;
  padding:10px 14px;
  font-weight:900;
  cursor:pointer;
  display:inline-flex;align-items:center;gap:8px;
  transition:transform .08s ease, background .18s ease, border-color .18s ease, filter .18s ease;
}
.btn:hover{background:rgba(255,255,255,.10);border-color:rgba(255,255,255,.20)}
.btn:active{transform:translateY(1px)}
.btnPrimary{
  border-color:rgba(96,165,250,.35);
  background:linear-gradient(90deg, rgba(96,165,250,.90), rgba(34,211,238,.75));
  color:#061018;
}
.btnPrimary:hover{filter:brightness(1.04)}
.input{
  width:100%;
  border-radius:14px;
  border:1px solid var(--border);
  background:rgba(255,255,255,.06);
  color:var(--text);
  padding:10px 12px;
  outline:none;
}
.input:focus{
  border-color:rgba(96,165,250,.45);
  box-shadow:0 0 0 3px rgba(96,165,250,.16);
}
.range{width:100%}
.heroWrap{
  position:relative;
  height: 420px;
  overflow:hidden;
  border-bottom:1px solid rgba(255,255,255,.10);
}
.heroBg{
  position:absolute;inset:0;
  background-image:
    radial-gradient(800px 420px at 22% 30%, rgba(34,211,238,.16), transparent 60%),
    radial-gradient(900px 500px at 72% 20%, rgba(96,165,250,.16), transparent 60%),
    linear-gradient(to bottom, rgba(0,0,0,.20), rgba(0,0,0,.90)),
    url("${heroUrl}");
  background-size:cover;
  background-position:center;
  transform:translateY(0);
  will-change: background-position;
  filter:saturate(1.05) contrast(1.03);
}
.heroOverlay{
  position:absolute;inset:0;
  background:
    linear-gradient(to bottom, rgba(0,0,0,.05), rgba(0,0,0,.65));
}
.heroContent{
  position:relative;
  height:100%;
  display:flex;
  align-items:flex-end;
}
.heroCard{
  display:inline-block;
  max-width: 920px;
  background: rgba(0,0,0,.45);
  border: 1px solid rgba(255,255,255,.18);
  box-shadow: var(--shadow);
}
.kicker{
  display:flex;gap:10px;flex-wrap:wrap;margin-top:12px
}
.smallLink{
  display:inline-flex;align-items:center;gap:6px;
  padding:8px 10px;border-radius:999px;
  border:1px solid rgba(255,255,255,.16);
  background:rgba(0,0,0,.25);
  color:rgba(255,255,255,.85);
  font-weight:900;
}
.smallLink:hover{background:rgba(255,255,255,.10);text-decoration:none}
.spin{animation:spin 1s linear infinite}
@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}
`;

  const renderSetup = () => (
    <div className="card pad">
      <div className="h2">Modular, Worker-Accelerated SGWB Inference Pipeline</div>
      <p className="p">
        Preview a spectrum with sliders, then run ensemble MCMC off-thread and compute KDE credible regions.
      </p>

      <hr className="hr" />

      <div className="h2">Live Spectrum Preview</div>
      <div className="muted" style={{ fontWeight: 800 }}>
        log10(Gmu)={logGmuPreview.toFixed(2)} &nbsp; log10(P)={logPPreview.toFixed(2)}
      </div>

      {!ptaData ? (
        <div className="row" style={{ marginTop: 12 }}>
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

      <div style={{ marginTop: 16 }} className="grid2">
        <div>
          <div className="label" style={{ fontWeight: 900, marginBottom: 8 }}>log10(Gmu)</div>
          <input className="range" type="range" min={-15} max={-6} step={0.05} value={logGmuPreview}
            onChange={(e) => setLogGmuPreview(parseFloat(e.target.value))} />
        </div>
        <div>
          <div className="label" style={{ fontWeight: 900, marginBottom: 8 }}>log10(P)</div>
          <input className="range" type="range" min={-4} max={0} step={0.05} value={logPPreview}
            onChange={(e) => setLogPPreview(parseFloat(e.target.value))} />
        </div>
      </div>

      <div style={{ marginTop: 16 }} className="row">
        <button className="btn" onClick={async () => { setStage("loading"); await loadPTA(); setStage("setup"); }}>
          Load PTA + Preview
        </button>

        <button className="btn" onClick={() => setShowSettings((s) => !s)}>
          <Settings size={16} />
          {showSettings ? "Hide" : "Show"} Advanced Settings
        </button>
      </div>

      {showSettings && (
        <div style={{ marginTop: 14 }} className="card pad">
          <div className="grid2">
            <div>
              <div className="label" style={{ fontWeight: 900, marginBottom: 8 }}>MCMC Steps</div>
              <input className="input" type="number" value={settings.nSteps}
                onChange={(e) => setSettings({ ...settings, nSteps: parseInt(e.target.value, 10) })} />
            </div>
            <div>
              <div className="label" style={{ fontWeight: 900, marginBottom: 8 }}>Walkers</div>
              <input className="input" type="number" value={settings.nWalkers}
                onChange={(e) => setSettings({ ...settings, nWalkers: parseInt(e.target.value, 10) })} />
            </div>
            <div>
              <div className="label" style={{ fontWeight: 900, marginBottom: 8 }}>Harmonics (Nk)</div>
              <input className="input" type="number" value={settings.Nk}
                onChange={(e) => setSettings({ ...settings, Nk: parseInt(e.target.value, 10) })} />
            </div>
            <div>
              <div className="label" style={{ fontWeight: 900, marginBottom: 8 }}>Max Redshift</div>
              <input className="input" type="number" value={settings.zMax}
                onChange={(e) => setSettings({ ...settings, zMax: parseInt(e.target.value, 10) })} />
            </div>
          </div>
        </div>
      )}

      <div style={{ marginTop: 14 }} className="card pad">
        <div className="h2">Implementation Notes</div>
        <ul className="p" style={{ marginTop: 8 }}>
          <li>Replace the example PTA JSON with real NANOGrav/EPTA/PPTA limits.</li>
          <li>For publication: increase steps/walkers and replace approximate t(z) with exact integral.</li>
          <li>MCMC runs in a Web Worker for responsiveness; main-thread fallback is included.</li>
        </ul>
      </div>

      <div style={{ marginTop: 14 }}>
        <button className="btn btnPrimary" onClick={runAnalysis}>
          <Play size={18} />
          Launch Bayesian Analysis
        </button>
      </div>
    </div>
  );

  const renderProgress = () => (
    <div className="card pad" style={{ textAlign: "center" }}>
      <div className="row" style={{ justifyContent: "center" }}>
        <Loader2 className="spin" size={48} />
      </div>
      <div style={{ marginTop: 10 }} className="h2">
        {stage === "loading" && "Loading Data"}
        {stage === "mcmc" && "Running Ensemble MCMC (Web Worker)"}
        {stage === "analyzing" && "Computing KDE Credible Regions"}
      </div>
      {stage === "mcmc" && (
        <div className="muted" style={{ marginTop: 6, fontWeight: 800 }}>
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
        <div className="card pad">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div>
              <div className="row">
                <CheckCircle2 size={18} />
                <strong>Analysis Complete</strong>
              </div>
              <div className="muted" style={{ marginTop: 6, fontWeight: 800 }}>
                Sampled {results.mcmc.samples.length.toLocaleString()} points — Acceptance {(results.mcmc.acceptanceRate * 100).toFixed(1)}%
              </div>
            </div>

            <div className="row">
              <button className="btn" onClick={exportResultsJSON}><Download size={16} /> JSON</button>
              <button className="btn" onClick={exportSamplesCSV}><Download size={16} /> Samples CSV</button>
              <button className="btn" onClick={exportKDECSV}><Download size={16} /> KDE CSV</button>
            </div>
          </div>
        </div>

        <div className="card pad">
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

        <div className="card pad">
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
    <div className="card pad">
      <div className="row">
        <AlertCircle size={18} />
        <strong>Run Failed</strong>
      </div>
      <div className="muted" style={{ marginTop: 6, fontWeight: 800 }}>
        {errorMsg || "Unknown error."}
      </div>
    </div>
  );

  return (
    <>
      <style>{css}</style>

      <div className="heroWrap">
        <div
          className="heroBg"
          style={{
            backgroundPosition: `center ${50 + heroShift}%`,
          }}
        />
        <div className="heroOverlay" />
        <div className="heroContent">
          <div className="container" style={{ paddingBottom: 26 }}>
            <div className="card pad heroCard">
              <div className="h1">Cosmic Superstring SGWB Demo</div>
              <div className="subtitle" style={{ marginTop: 10 }}>
                PTA upper-limit likelihood • ensemble MCMC • Web Worker acceleration • KDE credible regions
              </div>

              <div className="kicker">
                <a className="smallLink" href={doiUrl} target="_blank" rel="noreferrer">
                  Zenodo DOI <ExternalLink size={14} />
                </a>
                <a className="smallLink" href={paperUrl} target="_blank" rel="noreferrer">
                  Origin Paper <ExternalLink size={14} />
                </a>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="container">
        {stage === "setup" && renderSetup()}
        {(stage === "loading" || stage === "mcmc" || stage === "analyzing") && renderProgress()}
        {stage === "complete" && renderResults()}
        {stage === "error" && renderError()}
      </div>
    </>
  );
}
