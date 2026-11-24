<p align="center">
  <img src="public/aerolab-logo.png" alt="AeroLab Logo" width="220" />
</p>

<h1 align="center">AeroLab — 3D Aircraft Wind Tunnel &amp; 2D Airfoil CFD Workstation</h1>

<p align="center">
  Modular aerospace simulation workstation combining an <strong>SI Aerodynamic Physics Engine</strong>, a <strong>3D Biot–Savart Vortex-Lattice &amp; SDF Flow Tunnel</strong>, a GPU-accelerated <strong>2D Lattice-Boltzmann (D2Q9) Airfoil Lab</strong>, and a <strong>NeuroFoil Surrogate Predictor</strong> orchestrated over dedicated Web Workers with reproducible audit records and 5-level scientific verification.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL_v3-blue.svg" alt="License: AGPL v3" /></a>
  <a href="LICENSES/MIT.txt"><img src="https://img.shields.io/badge/Kutta_LBM-MIT-lightgrey.svg" alt="Kutta LBM: MIT License" /></a>
</p>

---

## System Architecture

AeroLab separates UI presentation, state management, simulation orchestration, numerical solvers, geometry preprocessing, and persistence into decoupled layers:

```text
+-------------------------------------------------------------------------+
|                    React 19 + TypeScript Workstation                    |
|  Setup . 3D Tunnel . 2D LBM Lab . D3.js Telemetry . Learning . Reports  |
+------------------------------------+------------------------------------+
                                     |
         +---------------------------+---------------------------+
         v                                                       v
+-----------------------------------+   +---------------------------------+
|        Application Services       |   |     Simulation Orchestrator     |
| Zustand Stores (src/state/)       |   | SimulationManager (src/sim...)  |
| IndexedDB + Supabase Repositories |   | Registry . Scheduler . LRU Cache|
+-----------------------------------+   +----------------+----------------+
                                                         |
                   Dedicated Web Workers (Transferable ArrayBuffers)
         +-----------------------+-----------------------+-----------------------+
         v                       v                       v                       v
+-----------------+     +-----------------+     +-----------------+     +-----------------+
| SI Physics      |     | 3D Flow Engine  |     | 2D CFD Engine   |     | Surrogate       |
| physics.worker  |     | fluid3d.worker  |     | tunnel2d.worker |     | NeuroFoilEngine |
| ISA . VLM . Drag|     | 84x48x84 SDF/RK2|     | D2Q9 Mach/tau0  |     | Bezier Polars   |
+--------+--------+     +--------+--------+     +--------+--------+     +--------+--------+
         |                       |                       |                       |
         +-----------------------+-----------------------+-----------------------+
                                     |
                                     v
+-------------------------------------------------------------------------+
|                Geometry, Verification & Reproducibility                 |
| Mesh Validator . PCA Normalization . Benchmarks . 3-Tier Audit Hashes   |
+------------------------------------+------------------------------------+
                                     |
                                     v
+-------------------------------------------------------------------------+
|                          Persistence & Export                           |
| IndexedDB (Local) . Supabase (Cloud) . A4 PDF (export.worker) . JSON/CSV|
+-------------------------------------------------------------------------+
```

---

## Core Architectural Pillars

### 1. Dedicated Web Workers & Zero-Copy Buffers (`src/workers/`, `src/simulation/workers/`)
Heavy computational workloads run off the browser's main UI thread via typed `SimulationRequest` / `SimulationResponse` protocols with Transferable `ArrayBuffer` objects (`Float32Array`, `Uint8Array`, PDF `ArrayBuffer`) and automatic in-process fallback in Node/Vitest environments:
- `physics.worker.ts` — SI atmospheric thermodynamics, polar sweeps, and NACA benchmark deviation checks.
- `fluid3d.worker.ts` — `84 × 48 × 84` SDF generation and adaptive RK2 streamline integration batches.
- `geometry.worker.ts` — Triangle soup topology validation and mesh bounding diagnostics.
- `tunnel2d.worker.ts` — Airfoil solid/fluid mask rasterization (`640 × 320`) and D2Q9 stability/Mach verification.
- `export.worker.ts` — Off-thread A4 engineering verification PDF, Markdown, and JSON serialization.

### 2. Unified Simulation Orchestration (`src/simulation/core/`, `src/simulation/engines/`)
- **`SimulationManager`**: Central coordinator unifying `SiPhysicsEngine` (`si-physics`), `Fluid3DFlowEngine` (`fluid-3d`), `Lbm2DEngine` (`lbm-2d`), and `NeuroFoilEngine` (`neurofoil`) behind a single `SimulationEngine<I, O>` interface (`validate`, `run`, `cancel`).
- **`SimulationRegistry` & `SimulationScheduler`**: Run-ID tracking, `AbortController` cancellation, and latest-wins superseding during rapid slider interaction.
- **`SimulationCache` & `SimulationEventBus`**: LRU result cache keyed by `engine@version::geometryHash::inputHash` plus typed progress/completion events.

### 3. Single-Source Scientific Data Contracts (`src/simulation/contracts/`, `src/domain/`, `src/physics/`)
- Strict SI calculation kernel (`src/lib/aeroPhysics.ts`) and derived `FlowConditions` (`deriveFlowConditions`) compute ISA air density $\rho(h)$, Sutherland dynamic viscosity $\mu(T)$, speed of sound $a(T)$, Mach number $M = V / \sqrt{\gamma R T}$, Reynolds number $Re = \rho V c / \mu$, Knudsen number $Kn$, and Prandtl–Glauert compressibility scaling from primary inputs so all solvers share one authoritative thermodynamic state.
- Explicit separation of physical computation (**SI Physics**), reduced-order visual flow trajectories (**Biot–Savart VLM**), and surface collision queries (**Geometry SDF**).

### 4. Universal 3D Geometry Normalization & Mesh Validation (`src/geometry/`, `src/engine/`)
- **Automatic Normalization & Framing**: Every built-in or uploaded `.glb` airframe is oriented (`nose -> -X`, `up -> +Y`, `span -> +Z`), centered with its aerodynamic center (`35%` aft of nose) at `(0, 0, 0)` in canonical `10.0`-unit wind-tunnel coordinates, and validated via `meshValidator.ts` (detecting degenerate triangles, disconnected mesh components, non-manifold edges, inverted hull normals, and raw unit scale mismatches) alongside 3D PCA orientation estimation.
- **`84 × 48 × 84` Dynamic SDF & RK2 Flow Pipeline**: `AircraftSurfaceField.ts` clears stale buffers on model switch and auto-sizes the distance grid to `1.35 × boundingBox` with minimum clearance $d_{\min} = 2.0 \times \text{cellSize}$. `FluidDynamics3D.ts` combines a 6-panel Biot–Savart horseshoe vortex lattice (auto-fitted to actual model span), axisymmetric slender-body fuselage potential deflection, and 2-step adaptive RK2 integration with smooth trilinear normal sliding.
- **Built-In Airframes & Validation Presets**: F-22 Raptor, Boeing 787 Dreamliner, Concorde SST, Airfoil Section 3D (`naca2412`), NACA 0012, **Validation Wing: Rectangular AR 6 (NACA 0012)** ($AR = 6.0, e = 0.95, Re = 3.0 \times 10^6, M = 0.15$), Circular Cylinder, Live 2D-to-3D Extruded Wing, and custom `.glb` uploads.

### 5. GPU 2D Lattice-Boltzmann CFD & Stability Diagnostics (`src/lib/lbm/`)
- Real-time `640 × 320` WebGL2 D2Q9 solver with Smagorinsky subgrid turbulence and four visualization shaders (**Velocity**, **Pressure $C_p$**, **Vorticity**, **Smoke**).
- `lbmDiagnostics.ts` continuously verifies low-Mach incompressible validity ($Ma_{\text{LBM}} = u_0\sqrt{3} < 0.30$), BGK relaxation stability ($\tau_0 > 0.505$), chord lattice resolution, and residual convergence.
- Interactive cubic Bézier airfoil editor (`ShapeEditor2D.tsx`), Selig `.dat` parser (`airfoilParser.js`), and **NeuroFoil** surrogate polar prediction (`neurofoil.ts`).

### 6. State Management & Interchangeable Persistence (`src/state/`, `src/data/`)
- **Zustand Domain Stores**: `useAircraftStore`, `useEnvironmentStore`, `useSimulationStore`, `useResultsStore`, and `useWorkspaceStore` decouple UI selections, execution progress, numerical telemetry, and geometry metadata.
- **`ISimulationRepository` Adapters**: Interchangeable `LocalSimulationRepository` (native browser **IndexedDB** `aerolab_sim_db` with in-memory fallback) and `SupabaseSimulationRepository` (storing compact metadata/summaries in Postgres and geometry/results artifacts in Storage).

### 7. D3.js Telemetry, Reproducible Simulation Records & 3-Tier Reporting (`src/reporting/`, `src/utils/`)
- **Telemetry & Analytics**: D3.js aerodynamic polars (`D3AdvancedGraphs.tsx`, `D3AirfoilLabGraphs.tsx`), Apache ECharts, Plotly polar overlays, structural load factor ($n_z = L / W_{\text{ref}}$) monitoring, and a subsonic attached VLM envelope status badge.
- **3-Tier Engineering Verification Reports**: `.pdf` (A4 document with embedded AeroLab logo), `.md`, `.json` (Verification Audit Record), and `.csv` explicitly distinguish:
  1. **Numerical Verification** — Equation consistency, exact drag decomposition summation, and quadrature lift checks.
  2. **Model Validation** — Comparison against NACA TR-824 / XFOIL polar benchmarks.
  3. **Operating Applicability** — Subsonic attached envelope ($M \le 0.70$, continuum $Kn \le 0.01$, pre-stall $\alpha$).
- Every run records deterministic `geometryHash`, `inputHash`, software/engine version, coordinate convention, discretization resolution, and validation status.

---

## Project Structure

```text
src/
├── components/           # Workstations, 3D/2D canvases, D3/ECharts/Plotly charts, GLB uploader, HUD
├── pages/                # Learning Lab (/learn) & Pilot Profile (/profile)
├── domain/               # Domain contracts (aircraft, aerodynamics, geometry, simulation)
├── physics/              # SI physics barrels (atmosphere, airfoil, compressibility, finite-wing, drag, validation)
├── geometry/             # GLB/2D importers, tunnel normalization, topology & mesh validation
├── simulation/
│   ├── contracts/        # ScientificContracts, SimulationMetadata, SimulationInput/Output
│   ├── core/             # SimulationManager, Registry, Scheduler, Cache, Events
│   ├── engines/          # SiPhysicsEngine, Fluid3DFlowEngine, Lbm2DEngine, NeuroFoilEngine
│   └── workers/          # WorkerClientPool (Transferables, cancellation, Node fallback)
├── workers/              # Dedicated Web Workers (physics, fluid3d, tunnel2d, geometry, export)
├── engine/               # Biot-Savart 3D flow field & 84x48x84 SDF surface collision grid
├── lib/                  # ISA SI physics kernel, D2Q9 WebGL2 LBM + diagnostics, NeuroFoil, calibration
├── data/                 # NACA TR-824 benchmarks, IndexedDB adapter, Repository interfaces
├── state/                # Zustand domain stores (aircraft, environment, simulation, results, workspace)
├── reporting/            # Typed PDF, Markdown, JSON, and CSV exporters
└── tests/                # Multi-level verification tests (numerical, integration, benchmarks)
```

---

## Scientific Verification Pyramid (`npm test`)

Verification is structured across five progressive test layers in Vitest:
- **Level 1–2 (Unit & Numerical Properties)**: `src/lib/__tests__/aeroPhysics.test.ts`, `src/engine/__tests__/biotSavart.test.ts`, and `src/tests/numerical/conservationAndSymmetry.test.ts` (ISA checkpoints, $\pm\alpha$ lift antisymmetry, Prandtl–Glauert $1/\sqrt{1-M^2}$, $C_{D,i} = C_L^2 / (\pi e AR)$, Biot–Savart core regularization).
- **Level 3 (Integration)**: `src/tests/integration/orchestratorPipeline.test.ts` (`SimulationManager` execution across all 4 engines, LRU cache determinism, mesh topology defect detection, `LocalSimulationRepository` CRUD).
- **Level 4–5 (Benchmarks & Experimental Validation)**: `src/tests/benchmarks/aerodynamicBenchmarks.test.ts` (NACA 0012 & 2412 TR-824 attached RMSE validation, Blasius/Schlichting skin friction, LBM Mach/$\tau_0$ stability guards, PDF & 3-tier verification audit generation).

---

## Tech Stack

- **UI & State**: React 19, TypeScript, Tailwind CSS v4, React Router, Zustand, Lucide & Phosphor Icons
- **3D & CFD**: Three.js (`GLTFLoader`, `MeshoptDecoder`, `OrbitControls`, `RoomEnvironment`), WebGL2 GLSL D2Q9 LBM Solver, Biot–Savart VLM + `84 × 48 × 84` EDT/SDF, Web Workers
- **Visualization & Reports**: D3.js (`d3`), Apache ECharts (`echarts`), `plotly.js-basic-dist-min`, `jsPDF`
- **Persistence**: Native IndexedDB (`aerolab_sim_db`) & optional Supabase (`@supabase/supabase-js`)
- **Testing**: Vitest

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

4. **Type-check, run verification tests, and build**
   ```bash
   npm run lint
   npm test
   npm run build
   ```

5. **Database & Storage Setup (Optional Supabase SQL)**
   Run this SQL in your Supabase SQL Editor if `glb_models` or the `models` bucket are not yet provisioned:
   ```sql
   create table if not exists public.glb_models (
     id text primary key,
     name text not null,
     filename text not null,
     file_size_bytes bigint not null default 0,
     model_class text not null default 'other',
     nose_axis text not null default '-X',
     up_axis text not null default '+Y',
     calibration jsonb not null default '{}'::jsonb,
     bounds jsonb not null default '{}'::jsonb,
     uploader_name text not null default 'Community',
     uploader_uid text not null default '',
     visibility text not null default 'public',
     storage_path text not null default '',
     storage_url text not null default '',
     created_at timestamptz not null default now()
   );

   alter table public.glb_models enable row level security;
   create policy "Public read glb_models" on public.glb_models for select using (visibility = 'public');
   create policy "Public insert glb_models" on public.glb_models for insert with check (true);
   create policy "Owner update glb_models" on public.glb_models for update using (uploader_uid = '' or uploader_uid = auth.uid()::text);
   create policy "Owner delete glb_models" on public.glb_models for delete using (uploader_uid = '' or uploader_uid = auth.uid()::text);

   insert into storage.buckets (id, name, public)
   values ('models', 'models', true)
   on conflict (id) do nothing;

   create policy "Public read models bucket" on storage.objects for select using (bucket_id = 'models');
   create policy "Public upload models bucket" on storage.objects for insert with check (bucket_id = 'models');
   create policy "Public update models bucket" on storage.objects for update using (bucket_id = 'models');
   create policy "Public delete models bucket" on storage.objects for delete using (bucket_id = 'models');
   ```

---

## Licenses

- **Primary Project License**: **GNU Affero General Public License v3.0 (AGPL-3.0)** — see [`LICENSE`](LICENSE).
- **Third-Party Components**: Incorporates the **Kutta** 2D LBM visualizer (`MIT`, [`LICENSES/MIT.txt`](LICENSES/MIT.txt)) and open-source npm packages (`MIT`, `Apache-2.0`, `BSD-2-Clause`, `ISC`, and GSAP Standard License). See [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md) for full details.
