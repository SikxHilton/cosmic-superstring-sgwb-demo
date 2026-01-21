# Cosmic Superstring SGWB Demo (PTA + Ensemble MCMC)

Interactive, browser-based inference of a cosmic-superstring SGWB using PTA upper-limit likelihoods and an affine-invariant ensemble MCMC sampler, with Web Worker acceleration and KDE credible regions.

## DOI (Citable Supplement / Source)
Zenodo: https://doi.org/10.5281/zenodo.18323281

## Origin Paper (Motivation)
Zenodo: https://doi.org/10.5281/zenodo.18299204

## Quickstart
```bash
npm install
npm run dev
npm run build
npm test

### B) `CITATION.cff`
Create a new file `CITATION.cff`:

```yaml
cff-version: 1.2.0
message: "If you use this software, please cite the Zenodo record and the origin paper."
type: software
title: "Cosmic Superstring SGWB Demo (PTA + Ensemble MCMC + Web Workers)"
authors:
  - family-names: "HILTON"
    given-names: "SIKX"
    orcid: "https://orcid.org/0009-0004-3405-7467"
doi: "10.5281/zenodo.18323281"
repository-code: "https://github.com/SikxHilton/cosmic-superstring-sgwb-demo"
url: "https://github.com/SikxHilton/cosmic-superstring-sgwb-demo"
keywords:
  - "cosmic superstrings"
  - "cosmic strings"
  - "SGWB"
  - "PTA"
  - "Bayesian inference"
  - "MCMC"
references:
  - type: article
    title: "String Theory Signatures in Cosmological Observables: Swampland Bounds, Cosmic Superstrings, and Axiverse Phenomenology"
    authors:
      - family-names: "HILTON"
        given-names: "SIKX"
        orcid: "https://orcid.org/0009-0004-3405-7467"
    doi: "10.5281/zenodo.18299204"
    year: 2026
