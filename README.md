<p align="center">
  <img src="public/aerolab-logo.png" alt="AeroLab Logo" width="220" />
</p>

<h1 align="center">AeroLab — 3D Aircraft Wind Tunnel &amp; 2D Airfoil CFD Workstation</h1>

<p align="center">
  Interactive aerospace simulation workstation combining an <strong>SI Aerodynamic Physics Engine</strong>, a <strong>3D Biot–Savart Vortex-Lattice &amp; SDF Wind Tunnel</strong>, a GPU-accelerated <strong>2D Lattice-Boltzmann (D2Q9) Airfoil Lab</strong>, and a <strong>NeuroFoil Surrogate Predictor</strong> over dedicated Web Workers.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL_v3-blue.svg" alt="License: AGPL v3" /></a>
  <a href="LICENSES/MIT.txt"><img src="https://img.shields.io/badge/Kutta_LBM-MIT-lightgrey.svg" alt="Kutta LBM: MIT License" /></a>
</p>

---

## Architecture

AeroLab separates UI presentation, state, simulation orchestration, numerical solvers, geometry preprocessing, and persistence into decoupled layers:

- **Workstation UI (`src/components/`, `src/pages/`)**: React 19 + TypeScript interface featuring the 3D Wind Tunnel, 2D Airfoil Lab, Interactive Bézier Shape Editor, D3.js / ECharts / Plotly telemetry analytics, Learning Lab, and Pilot Profile.
- **State & Orchestration (`src/state/`, `src/simulation/`)**: Zustand domain stores paired with `SimulationManager` (`si-physics`, `fluid-3d`, `lbm-2d`, `neurofoil`), run cancellation, latest-wins scheduling, and deterministic result caching.
- **Web Workers (`src/workers/`)**: Off-thread execution with Transferable `ArrayBuffer` payloads (and automatic in-process fallback in Node/Vitest) for physics sweeps, 3D SDF/streamline integration, mesh validation, 2D LBM masking/diagnostics, and PDF/JSON/Markdown exports.
- **Geometry & Flow Pipeline (`src/geometry/`, `src/engine/`)**: Automatic `.glb` orientation & canonical tunnel normalization, mesh topology validation, dynamic `84 × 48 × 84` SDF surface collision grids, 6-panel Biot–Savart vortex filaments, slender-body fuselage deflection, and adaptive RK2 streamline integration.
- **SI Physics & 2D CFD (`src/lib/`, `src/physics/`, `src/domain/`)**: ISA atmosphere thermodynamics, Prandtl–Glauert compressibility, finite-wing lifting-line theory, WebGL2 D2Q9 LBM solver with Mach/relaxation stability diagnostics, and NeuroFoil surrogate polars.
- **Persistence & Reporting (`src/data/`, `src/reporting/`, `src/utils/`)**: Local IndexedDB (`aerolab_sim_db`) and optional Supabase cloud sync, plus reproducible A4 PDF, JSON, CSV, and Markdown engineering reports separating numerical verification, NACA TR-824 benchmark validation, and operating envelope applicability.

---

## Project Structure

```text
src/
├── components/           # Workstations, 3D/2D canvases, telemetry charts, GLB uploader, HUD
├── pages/                # Learning Lab (/learn) & Pilot Profile (/profile)
├── domain/               # Domain types and aerodynamic/geometry contracts
├── physics/              # SI physics barrels (atmosphere, airfoil, finite-wing, drag, validation)
├── geometry/             # GLB/2D importers, tunnel normalization, and mesh validation
├── simulation/           # Orchestrator, contracts, engine adapters, and worker pool client
├── workers/              # Dedicated Web Workers (physics, fluid3d, tunnel2d, geometry, export)
├── engine/               # Biot–Savart 3D flow field & 84x48x84 SDF collision grid
├── lib/                  # ISA SI physics kernel, WebGL2 D2Q9 LBM + diagnostics, NeuroFoil
├── data/                 # NACA TR-824 benchmarks, IndexedDB adapter, repository layer
├── state/                # Zustand domain stores
├── reporting/            # PDF, Markdown, JSON, and CSV exporters
└── tests/                # Numerical, integration, and aerodynamic benchmark tests
```

---

## Tech Stack

- **Frontend & State**: React 19, TypeScript, Tailwind CSS v4, React Router, Zustand, Lucide & Phosphor Icons
- **3D & CFD**: Three.js (`GLTFLoader`, `MeshoptDecoder`, `OrbitControls`, `RoomEnvironment`), WebGL2 GLSL D2Q9 LBM Solver, Biot–Savart VLM + `84 × 48 × 84` SDF, Web Workers
- **Charts & Export**: D3.js, Apache ECharts, Plotly (`plotly.js-basic-dist-min`), jsPDF
- **Storage & Testing**: IndexedDB, optional Supabase (`@supabase/supabase-js`), Vitest

---

## Local Development

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Configure environment variables (optional)**
   Copy `.env.example` to `.env` if enabling Supabase cloud sync:
   ```env
   VITE_SUPABASE_URL=""
   VITE_SUPABASE_PUBLISHABLE_KEY=""
   ```

3. **Start the development server** (port `3000`)
   ```bash
   npm run dev
   ```

4. **Type-check, run tests, and build**
   ```bash
   npm run lint
   npm test
   npm run build
   ```

---

## Licenses

- **Primary Project License**: **GNU Affero General Public License v3.0 (AGPL-3.0)** — see [`LICENSE`](LICENSE).
- **Third-Party Components**: Incorporates the **Kutta** 2D LBM visualizer (`MIT`, [`LICENSES/MIT.txt`](LICENSES/MIT.txt)) and open-source npm packages. See [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md) for full details.
