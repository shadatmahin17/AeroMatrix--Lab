import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Check, Compass, FileUp, Radar, RotateCcw, Trash2, UploadCloud } from "lucide-react";
import type { AppUser } from "./SupabaseProvider.tsx";
import { useToast } from "./PopupToast.tsx";
import type { AirfoilSelection, TunnelStats } from "../types/airfoil.ts";
import {
  DEFAULT_NEUTRAL_BASELINE,
  deleteBenchmarkRun,
  ensureUserProfile,
  interpolateReferenceAtAlpha,
  parseNeutralComparisonFile,
  publishBenchmarkRun,
  type BenchmarkRunDoc,
  type NeutralReferenceData,
} from "../lib/airfoilRepository.ts";
import { evaluateLiveAgainstNeuroFoil, type NeuroFoilPrediction } from "../lib/neurofoil.ts";
import { readFileText } from "../lib/files.js";

function fmtDelta(val: number | null | undefined, digits = 2): string {
  if (val === null || val === undefined || !Number.isFinite(val)) return "—";
  const sign = val >= 0 ? "+" : "";
  return `${sign}${val.toFixed(digits)}`;
}

interface BenchmarkComparisonProps {
  stats: TunnelStats;
  alpha: number;
  airfoil: AirfoilSelection;
  benchmarks?: BenchmarkRunDoc[];
  neurofoilPrediction: NeuroFoilPrediction;
  customRef?: NeutralReferenceData | null;
  onCustomRefChange: (nextRef: NeutralReferenceData | null) => void;
  onJumpToAlpha?: (alphaDeg: number) => void;
  user?: AppUser | null;
}

export default function BenchmarkComparison({
  stats,
  alpha,
  airfoil,
  benchmarks = [],
  neurofoilPrediction,
  customRef = null,
  onCustomRefChange,
  onJumpToAlpha,
  user = null,
}: BenchmarkComparisonProps) {
  const { notify } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const savedTimerRef = useRef<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedFeedback, setSavedFeedback] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (savedTimerRef.current !== null) {
        window.clearTimeout(savedTimerRef.current);
      }
    };
  }, []);

  const liveCl = stats.cl;
  const liveCd = stats.cd;
  const liveLd = liveCl !== null && liveCd !== null && liveCd > 0.001 ? liveCl / liveCd : null;

  const bestRun = benchmarks.length > 0 ? benchmarks[0] : null;
  const foilBestRun =
    benchmarks.find((b) => b.airfoilName.toLowerCase() === airfoil.name.toLowerCase()) || null;

  const neuroEval = evaluateLiveAgainstNeuroFoil(neurofoilPrediction, alpha, liveCl, liveCd);

  const activeRef = customRef || neurofoilPrediction.asReference;
  const refAtAlpha = customRef
    ? interpolateReferenceAtAlpha(customRef, alpha)
    : neuroEval.atAlpha;

  const deltaLdVsRef = liveLd !== null && refAtAlpha ? liveLd - refAtAlpha.ld : null;
  const deltaClVsRef = liveCl !== null && refAtAlpha ? liveCl - refAtAlpha.cl : null;
  const deltaCdVsRef = liveCd !== null && refAtAlpha ? liveCd - refAtAlpha.cd : null;

  const targetBestLd = bestRun ? bestRun.ld : neurofoilPrediction.maxLd;
  const bestRatioPct =
    liveLd !== null && targetBestLd && targetBestLd > 0.1
      ? Math.max(0, Math.min(140, (liveLd / targetBestLd) * 100))
      : null;

  const handleSaveBestRun = async () => {
    if (liveCl === null || liveCd === null || liveLd === null) {
      setErrMsg("Wait for solver telemetry before publishing a result.");
      return;
    }
    setErrMsg(null);
    setSavedFeedback(false);
    setSaving(true);
    try {
      const saved = await publishBenchmarkRun({
        airfoilName: airfoil.name,
        airfoilId: airfoil.id || airfoil.filename || "",
        kind: "best_run",
        alpha,
        reynolds: stats.reynolds,
        cl: liveCl,
        cd: liveCd,
        ld: liveLd,
        separationPct: stats.separationPct,
        sourceLabel: "Live 2D LBM + NeuroFoil",
        summaryExtra: {
          regime: neuroEval.regime,
          optimalAlpha: neurofoilPrediction.optimalAlpha,
          stallAlpha: neurofoilPrediction.stallAlpha,
          neurofoilPeakLd: neurofoilPrediction.maxLd,
          agreementPct: neuroEval.agreementPct,
        },
      });
      if (user) {
        const myRunsCount = benchmarks.filter((b) => b.recorderUid === user.uid).length + 1;
        void ensureUserProfile({
          totalRuns: myRunsCount,
          bestLd: saved.ld,
          bestAirfoil: saved.airfoilName,
        }).catch(() => {});
      }
      setSavedFeedback(true);
      if (savedTimerRef.current !== null) window.clearTimeout(savedTimerRef.current);
      savedTimerRef.current = window.setTimeout(() => setSavedFeedback(false), 1800);
      notify(`Saved ${saved.airfoilName} (L/D ${saved.ld.toFixed(2)}).`);
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : "Could not save benchmark.");
    } finally {
      setSaving(false);
    }
  };

  const handleReferenceFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    setErrMsg(null);
    try {
      const txt = (await readFileText(f)) as string;
      const parsed = parseNeutralComparisonFile(txt, f.name);
      onCustomRefChange(parsed);
      notify(`Loaded reference: ${parsed.label}.`);
    } catch (err) {
      setErrMsg(err instanceof Error ? err.message : "Invalid reference/NeuroFoil file.");
    }
  };

  const handleDeleteBenchmark = async (item: BenchmarkRunDoc) => {
    setErrMsg(null);
    try {
      await deleteBenchmarkRun(item.id, item.recorderUid);
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : "Could not delete benchmark.");
    }
  };

  return (
    <div className="antigravity-glass rounded-xl p-3.5 flex flex-col gap-3 min-w-0">
      <div className="flex items-center justify-between gap-2 pb-2.5 border-b border-[var(--border)]">
        <div className="flex items-center gap-1.5 text-xs font-bold text-[#161A1D]">
          <Radar size={14} className="text-[#1769AA]" aria-hidden="true" />
          <span>NeuroFoil &amp; Best</span>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,.csv,.dat,.txt"
            hidden
            onChange={handleReferenceFile}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            title="Upload custom NeuroFoil / baseline file (.json, .csv, .dat)"
            className="px-2 py-1 rounded-md text-[11px] font-semibold bg-[var(--bg)] border border-[var(--border)] hover:border-[#1769AA] text-[#161A1D] hover:text-[#1769AA] transition-colors flex items-center gap-1 whitespace-nowrap cursor-pointer"
          >
            <FileUp size={11} aria-hidden="true" />
            <span>Load Ref</span>
          </button>
          <button
            type="button"
            onClick={() =>
              onCustomRefChange(customRef ? null : DEFAULT_NEUTRAL_BASELINE)
            }
            title={customRef ? "Switch back to live NeuroFoil surrogate" : "Compare against Neutral NACA 0012"}
            className={`px-2 py-1 rounded-md text-[11px] font-semibold border transition-colors whitespace-nowrap cursor-pointer ${
              customRef
                ? "bg-[var(--accent-light)] border-[#1769AA]/35 text-[#1769AA]"
                : "bg-[var(--bg)] border-[var(--border)] text-[#5C6670] hover:text-[#1769AA]"
            }`}
          >
            {customRef ? "Surrogate" : "Neutral"}
          </button>
          {customRef && (
            <button
              type="button"
              onClick={() => {
                onCustomRefChange(null);
              }}
              title="Reset to live NeuroFoil surrogate"
              aria-label="Reset comparison target"
              className="p-1 rounded-md text-[#5C6670] hover:text-[#1769AA] bg-[var(--bg)] border border-[var(--border)] cursor-pointer"
            >
              <RotateCcw size={12} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2 text-[11.5px]">
          <div className="flex items-center gap-1.5 min-w-0 font-semibold text-[#161A1D]">
            <Compass size={13} className="text-[#1769AA] shrink-0" aria-hidden="true" />
            <span className="truncate">{neuroEval.regime}</span>
          </div>
          <span className="font-mono tabular-nums font-semibold text-[#1769AA] shrink-0">
            {neuroEval.agreementPct !== null ? `${neuroEval.agreementPct}% match` : "Predicting"}
          </span>
        </div>

        <div className="grid grid-cols-3 divide-x divide-[var(--border)] rounded-lg border border-[var(--border)] bg-[var(--bg)] text-center py-2 font-mono tabular-nums">
          <div className="px-1">
            <div className="text-[10px] font-sans text-[#5C6670]">Opt α*</div>
            <div className="text-xs font-bold text-[#1769AA] mt-0.5">
              {neurofoilPrediction.optimalAlpha.toFixed(1)}°
            </div>
          </div>
          <div className="px-1">
            <div className="text-[10px] font-sans text-[#5C6670]">Peak L/D</div>
            <div className="text-xs font-bold text-[#047857] mt-0.5">
              {neurofoilPrediction.maxLd.toFixed(1)}
            </div>
          </div>
          <div className="px-1">
            <div className="text-[10px] font-sans text-[#5C6670]">α Stall</div>
            <div className="text-xs font-bold text-[#D97706] mt-0.5">
              {neurofoilPrediction.stallAlpha.toFixed(1)}°
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] text-[#5C6670] leading-snug flex-1">{neuroEval.hint}</p>
          {onJumpToAlpha && (
            <button
              type="button"
              onClick={() => onJumpToAlpha(neurofoilPrediction.optimalAlpha)}
              className="px-2.5 py-1 rounded-md text-[11px] font-semibold bg-[#1769AA] hover:bg-[#12568C] text-white shrink-0 whitespace-nowrap cursor-pointer"
            >
              Jump α*
            </button>
          )}
        </div>
      </div>

      <div className="rounded-lg border border-[var(--border)] overflow-hidden">
        <table className="w-full border-collapse text-[11.5px] font-mono tabular-nums">
          <thead className="bg-[var(--bg)] border-b border-[var(--border)] text-[#5C6670]">
            <tr>
              <th className="text-left font-semibold px-2.5 py-1.5">Metric</th>
              <th className="text-right font-semibold px-2.5 py-1.5">Live</th>
              <th className="text-right font-semibold px-2.5 py-1.5">
                {customRef ? "Ref" : "NeuroFoil"}
              </th>
              <th className="text-right font-semibold px-2.5 py-1.5 text-[#047857]">Best</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)] bg-white">
            <tr>
              <td className="px-2.5 py-1.5 text-[#5C6670]">CL</td>
              <td className="px-2.5 py-1.5 text-right font-semibold text-[#1769AA]">
                {liveCl !== null ? liveCl.toFixed(3) : "—"}
              </td>
              <td className="px-2.5 py-1.5 text-right text-[#161A1D]">
                {refAtAlpha ? refAtAlpha.cl.toFixed(3) : "—"}
              </td>
              <td className="px-2.5 py-1.5 text-right font-semibold text-[#047857]">
                {bestRun ? bestRun.cl.toFixed(3) : neurofoilPrediction.maxCl.toFixed(3)}
              </td>
            </tr>
            <tr>
              <td className="px-2.5 py-1.5 text-[#5C6670]">CD</td>
              <td className="px-2.5 py-1.5 text-right font-semibold text-[#D97706]">
                {liveCd !== null ? liveCd.toFixed(3) : "—"}
              </td>
              <td className="px-2.5 py-1.5 text-right text-[#161A1D]">
                {refAtAlpha ? refAtAlpha.cd.toFixed(3) : "—"}
              </td>
              <td className="px-2.5 py-1.5 text-right font-semibold text-[#047857]">
                {bestRun ? bestRun.cd.toFixed(3) : "—"}
              </td>
            </tr>
            <tr>
              <td className="px-2.5 py-1.5 text-[#5C6670]">L/D</td>
              <td className="px-2.5 py-1.5 text-right font-bold text-[#1769AA]">
                {liveLd !== null ? liveLd.toFixed(2) : "—"}
              </td>
              <td className="px-2.5 py-1.5 text-right text-[#161A1D]">
                {refAtAlpha ? refAtAlpha.ld.toFixed(2) : "—"}
              </td>
              <td className="px-2.5 py-1.5 text-right font-bold text-[#047857]">
                {bestRun ? bestRun.ld.toFixed(2) : neurofoilPrediction.maxLd.toFixed(2)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="flex flex-col gap-1.5 text-[11px] font-mono tabular-nums pt-1 border-t border-[var(--border)]">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[#5C6670] truncate" title={activeRef.label}>
            vs {activeRef.airfoilName}
          </span>
          <span className="font-semibold shrink-0">
            <span className={deltaLdVsRef !== null && deltaLdVsRef >= 0 ? "text-[#047857]" : "text-[#B45309]"}>
              ΔL/D {fmtDelta(deltaLdVsRef, 2)}
            </span>
            <span className="text-[#D9DEE2] mx-1">·</span>
            <span className="text-[#161A1D]">ΔCL {fmtDelta(deltaClVsRef, 2)}</span>
            {deltaCdVsRef !== null && (
              <>
                <span className="text-[#D9DEE2] mx-1">·</span>
                <span className="text-[#5C6670]">ΔCD {fmtDelta(deltaCdVsRef, 3)}</span>
              </>
            )}
          </span>
        </div>

        <div className="flex items-center justify-between gap-2">
          <span className="text-[#5C6670] truncate">
            {bestRun ? `Best: ${bestRun.airfoilName} (${bestRun.alpha.toFixed(1)}°)` : "NeuroFoil Peak"}
          </span>
          <span className="font-semibold text-[#1769AA] shrink-0">
            {bestRatioPct !== null ? `${bestRatioPct.toFixed(0)}% of best` : "—"}
            {foilBestRun ? ` · Foil ${foilBestRun.ld.toFixed(1)}` : ""}
          </span>
        </div>

        {bestRatioPct !== null && (
          <div className="w-full h-1.5 rounded-full bg-[var(--bg)] border border-[var(--border)] overflow-hidden">
            <div
              className="h-full bg-[#1769AA] rounded-full transition-all"
              style={{ width: `${Math.min(100, bestRatioPct)}%` }}
            />
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={handleSaveBestRun}
        disabled={saving || liveLd === null}
        className="btn btn-primary-accent btn-sm w-full whitespace-nowrap"
      >
        {savedFeedback ? <Check size={14} aria-hidden="true" /> : <UploadCloud size={14} aria-hidden="true" />}
        <span>{saving ? "Saving…" : savedFeedback ? "Saved" : "Save Result Summary"}</span>
      </button>
      {errMsg && (
        <div className="text-[11px] text-red-700 bg-red-50 border border-red-200 rounded-lg px-2.5 py-1.5">
          {errMsg}
        </div>
      )}

      {benchmarks.length > 0 && (
        <div className="flex flex-col gap-1.5 pt-2 border-t border-[var(--border)]">
          <div className="text-[11px] font-bold text-[#5C6670]">
            Best Recorded Leaderboard ({benchmarks.length})
          </div>
          <div className="max-h-36 overflow-y-auto custom-scrollbar rounded-lg border border-[var(--border)] divide-y divide-[var(--border)] bg-white">
            {benchmarks.slice(0, 8).map((b, idx) => {
              const canDelete = Boolean(user && b.recorderUid === user.uid);
              return (
                <div
                  key={b.id}
                  className="flex items-center justify-between gap-2 px-2.5 py-1.5 text-[11px] font-mono tabular-nums"
                >
                  <span className="truncate text-[#161A1D]">
                    <strong className="text-[#1769AA]">#{idx + 1}</strong> {b.airfoilName} @ {b.alpha.toFixed(1)}°
                  </span>
                  <span className="flex items-center gap-1.5 shrink-0">
                    <span className="font-semibold text-[#047857]">L/D {b.ld.toFixed(2)}</span>
                    {canDelete && (
                      <button
                        type="button"
                        onClick={() => handleDeleteBenchmark(b)}
                        aria-label={`Delete benchmark ${b.airfoilName}`}
                        className="text-[#5C6670] hover:text-red-600 cursor-pointer"
                      >
                        <Trash2 size={11} aria-hidden="true" />
                      </button>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
