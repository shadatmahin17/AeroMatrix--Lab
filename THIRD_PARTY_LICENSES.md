# Third-Party & Component Licenses

**AeroLab — 3D Aircraft CFD & 2D Airfoil Wind Tunnel** is distributed under the **GNU Affero General Public License v3.0 (AGPL-3.0)** (see [`LICENSE`](LICENSE)).  
It incorporates open-source aerodynamic solvers, 3D geometry assets, and runtime libraries under the additional licenses documented below.

---

## Upstream & Component Attributions

| Component | Source / Author | License | Reference |
| :--- | :--- | :--- | :--- |
| **AeroLab Airfoils Analysis (2D LBM & Pilot Platform)** | `shadatmahin17/AeroLab-Airfoils-analysis` | `AGPL-3.0` | [`LICENSE`](LICENSE) |
| **Aeromaterix-CFD (3D Vortex Lattice & WebGL Wind Tunnel)** | `shadatmahin17/Aeromaterix-CFD` | `Apache-2.0` | [`LICENSES/Apache-2.0.txt`](LICENSES/Apache-2.0.txt) |
| **Kutta 2D Lattice-Boltzmann Flow Visualizer** | Cesar Gimenes (`crgimenes/kutta`) | `MIT` | [`LICENSES/MIT.txt`](LICENSES/MIT.txt) |

---

## Runtime & Build Dependencies

| Package | License |
| :--- | :--- |
| `@google/genai`, `echarts`, `typescript` | `Apache-2.0` ([`LICENSES/Apache-2.0.txt`](LICENSES/Apache-2.0.txt)) |
| `@phosphor-icons/react`, `@supabase/supabase-js`, `@tailwindcss/vite`, `@types/express`, `@types/node`, `@types/react`, `@types/react-dom`, `@types/three`, `@vitejs/plugin-react`, `autoprefixer`, `esbuild`, `express`, `motion`, `plotly.js-basic-dist-min`, `react`, `react-dom`, `react-router-dom`, `tailwindcss`, `three`, `tsx`, `vite` | `MIT` ([`LICENSES/MIT.txt`](LICENSES/MIT.txt)) |
| `dotenv` | `BSD-2-Clause` |
| `lucide-react` | `ISC` |
| `gsap` | GSAP Standard "No Charge" License (`https://gsap.com/standard-license`) |

---

## 3D CAD Assets (`public/models/`)

- **Boeing 787 Dreamliner** (`boeing_787.glb`) — Commercial airliner CAD reference mesh
- **Concorde SST** (`concorde_free_with_interior.glb`) — Supersonic transport CAD reference mesh
- **F-22 Raptor** (`f22_raptor.glb`) — 5th-gen fighter CAD mesh by `bohmerang`
- **Airfoil Section 3D** (`airfoil.glb`) — 3D aerodynamic lifting-surface mesh
