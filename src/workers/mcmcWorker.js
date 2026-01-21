import { runEnsembleMCMC } from "../lib/mcmc.js";

self.onmessage = (e) => {
  const msg = e.data;
  if (!msg || msg.type !== "RUN") return;

  try {
    const { ptaData, options } = msg;

    const result = runEnsembleMCMC(ptaData, options, (progress) => {
      self.postMessage({ type: "PROGRESS", progress });
    });

    self.postMessage({ type: "DONE", result });
  } catch (err) {
    self.postMessage({
      type: "ERROR",
      message: err?.message ?? String(err),
    });
  }
};
