import { useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  ArrowUpRight,
  BarChart3,
  Box,
  Briefcase,
  Building2,
  Camera,
  Check,
  Cloud,
  Download,
  Eye,
  EyeOff,
  FileJson,
  FileSpreadsheet,
  History,
  ImagePlus,
  Lock,
  LogIn,
  LogOut,
  Mail,
  MapPin,
  Play,
  Search,
  SquarePen,
  Trash2,
  TrendingUp,
  Trophy,
  Upload,
  User,
  Wind,
  X,
} from "lucide-react";
import { parseDatText } from "../lib/airfoilParser.js";
import { formatModelClassLabel } from "../lib/calibration.ts";
import {
  deleteBenchmarkRun,
  deleteSharedAirfoil,
  deleteSharedGlbModel,
  downloadSharedGlbBuffer,
  processAvatarImage,
  processBannerImage,
  type BenchmarkRunDoc,
  type PilotDetails,
  type SharedAirfoilDoc,
  type SharedGlbModelDoc,
  type UserProfileDoc,
} from "../lib/airfoilRepository.ts";
import { downloadText, toCsv } from "../lib/files.js";
import type { AppUser, UpdateProfilePayload } from "../components/SupabaseProvider.tsx";
import { useToast } from "../components/PopupToast.tsx";
import type { AirfoilSelection } from "../types/airfoil.ts";

function formatShortDate(ms: number): string {
  if (!ms) return "just now";
  try {
    return new Date(ms).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return "";
  }
}

function AirfoilPreviewSvg({ coordsText }: { coordsText: string }) {
  const pathD = useMemo(() => {
    try {
      const { coords } = parseDatText(coordsText);
      if (!coords.length) return "";
      const pts = (coords as [number, number][]).map(([x, y]) => {
        const px = 4 + x * 64;
        const py = 14 - y * 52;
        return `${px.toFixed(1)},${py.toFixed(1)}`;
      });
      return `M ${pts.join(" L ")} Z`;
    } catch {
      return "";
    }
  }, [coordsText]);

  return (
    <svg
      viewBox="0 0 72 28"
      className="w-16 h-7 shrink-0 rounded border border-[var(--border)] bg-[var(--bg)]"
      aria-hidden="true"
    >
      <line x1="4" y1="14" x2="68" y2="14" stroke="#D9DEE2" strokeWidth="0.75" strokeDasharray="2 2" />
      {pathD && (
        <path
          d={pathD}
          fill="rgba(23, 105, 170, 0.14)"
          stroke="#1769AA"
          strokeWidth="1.25"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

function GoogleMark() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true" className="shrink-0">
      <path
        fill="#4285F4"
        d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.665-5.17 3.665-9.17Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.11-6.72-4.96H1.29v3.14C3.26 21.3 7.31 24 12 24Z"
      />
      <path
        fill="#FBBC05"
        d="M5.28 14.24c-.24-.72-.38-1.49-.38-2.24s.14-1.52.38-2.24V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.99-3.14Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.99 3.14c.95-2.85 3.6-4.96 6.72-4.96Z"
      />
    </svg>
  );
}

interface ProfilePageProps {
  user: AppUser | null;
  userProfile: UserProfileDoc | null;
  authReady: boolean;
  authBusy: boolean;
  authError: string | null;
  authNotice: string | null;
  cloudError: string | null;
  isSupabaseReady?: boolean;
  onSignInWithEmail: (email: string, password: string) => Promise<void>;
  onSignUpWithEmail: (email: string, password: string, displayName?: string) => Promise<void>;
  onSignInWithGoogle?: () => Promise<void>;
  onEnterLocalMode?: () => void;
  onSignOut: () => Promise<void>;
  onUpdateProfile: (payload: UpdateProfilePayload) => Promise<PilotDetails>;
  sharedAirfoils?: SharedAirfoilDoc[];
  sharedGlbModels?: SharedGlbModelDoc[];
  benchmarks?: BenchmarkRunDoc[];
  onLoadAirfoil?: (loaded: AirfoilSelection & { choice: string }) => void;
  onLoadGlbModel?: (doc: SharedGlbModelDoc) => Promise<void>;
  onApplyRun?: (run: BenchmarkRunDoc) => Promise<void>;
}

export default function ProfilePage({
  user,
  userProfile,
  authReady,
  authBusy,
  authError,
  authNotice,
  cloudError,
  isSupabaseReady = true,
  onSignInWithEmail,
  onSignUpWithEmail,
  onSignInWithGoogle,
  onEnterLocalMode,
  onSignOut,
  onUpdateProfile,
  sharedAirfoils = [],
  sharedGlbModels = [],
  benchmarks = [],
  onLoadAirfoil,
  onLoadGlbModel,
  onApplyRun,
}: ProfilePageProps) {
  const navigate = useNavigate();
  const { notify } = useToast();
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const bannerInputRef = useRef<HTMLInputElement>(null);

  const [imgErr, setImgErr] = useState(false);
  const [bannerErr, setBannerErr] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  // Auth form state
  const [authMode, setAuthMode] = useState<"signin" | "signup">("signin");
  const [emailInput, setEmailInput] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const [localAuthErr, setLocalAuthErr] = useState<string | null>(null);

  // Profile editor state
  const [editingProfile, setEditingProfile] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftRole, setDraftRole] = useState("");
  const [draftOrganization, setDraftOrganization] = useState("");
  const [draftLocation, setDraftLocation] = useState("");
  const [draftBio, setDraftBio] = useState("");
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreviewUrl, setAvatarPreviewUrl] = useState<string | null>(null);
  const [removeAvatarFlag, setRemoveAvatarFlag] = useState(false);
  const [avatarDragOver, setAvatarDragOver] = useState(false);
  const [processingAvatar, setProcessingAvatar] = useState(false);
  const [bannerFile, setBannerFile] = useState<File | null>(null);
  const [bannerPreviewUrl, setBannerPreviewUrl] = useState<string | null>(null);
  const [removeBannerFlag, setRemoveBannerFlag] = useState(false);
  const [bannerDragOver, setBannerDragOver] = useState(false);
  const [processingBanner, setProcessingBanner] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);

  // Filters
  const [runQuery, setRunQuery] = useState("");
  const [runSort, setRunSort] = useState<"recent" | "best" | "cl">("recent");
  const [uploadQuery, setUploadQuery] = useState("");
  const [glbQuery, setGlbQuery] = useState("");
  const [loadingGlbId, setLoadingGlbId] = useState<string | null>(null);

  useEffect(() => {
    setImgErr(false);
  }, [user?.photoURL]);

  useEffect(() => {
    setBannerErr(false);
  }, [user?.bannerURL]);

  useEffect(() => {
    return () => {
      if (avatarPreviewUrl && avatarPreviewUrl.startsWith("blob:")) {
        URL.revokeObjectURL(avatarPreviewUrl);
      }
      if (bannerPreviewUrl && bannerPreviewUrl.startsWith("blob:")) {
        URL.revokeObjectURL(bannerPreviewUrl);
      }
    };
  }, [avatarPreviewUrl, bannerPreviewUrl]);

  const myUploads = useMemo(
    () =>
      user
        ? sharedAirfoils
            .filter((a) => a.uploaderUid === user.uid)
            .slice()
            .sort((a, b) => b.createdAtMs - a.createdAtMs)
        : [],
    [sharedAirfoils, user]
  );

  const myGlbModels = useMemo(
    () =>
      user
        ? sharedGlbModels
            .filter((m) => m.uploaderUid === user.uid)
            .slice()
            .sort((a, b) => b.createdAtMs - a.createdAtMs)
        : [],
    [sharedGlbModels, user]
  );

  const myRuns = useMemo(
    () =>
      user
        ? benchmarks
            .filter((b) => b.recorderUid === user.uid)
            .slice()
            .sort((a, b) => {
              if (runSort === "best") return b.ld - a.ld || b.createdAtMs - a.createdAtMs;
              if (runSort === "cl") return b.cl - a.cl || b.createdAtMs - a.createdAtMs;
              return b.createdAtMs - a.createdAtMs;
            })
        : [],
    [benchmarks, user, runSort]
  );

  const filteredRuns = useMemo(() => {
    const q = runQuery.trim().toLowerCase();
    if (!q) return myRuns;
    return myRuns.filter(
      (r) =>
        r.airfoilName.toLowerCase().includes(q) ||
        r.sourceLabel.toLowerCase().includes(q)
    );
  }, [myRuns, runQuery]);

  const filteredUploads = useMemo(() => {
    const q = uploadQuery.trim().toLowerCase();
    if (!q) return myUploads;
    return myUploads.filter(
      (u) =>
        u.name.toLowerCase().includes(q) ||
        u.filename.toLowerCase().includes(q)
    );
  }, [myUploads, uploadQuery]);

  const filteredGlbModels = useMemo(() => {
    const q = glbQuery.trim().toLowerCase();
    if (!q) return myGlbModels;
    return myGlbModels.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        m.filename.toLowerCase().includes(q) ||
        m.modelClass.toLowerCase().includes(q)
    );
  }, [myGlbModels, glbQuery]);

  const personalBestRun = useMemo(() => {
    if (!myRuns.length) return null;
    return myRuns.reduce((best, r) => (r.ld > best.ld ? r : best), myRuns[0]);
  }, [myRuns]);

  const flightEnvelope = useMemo(() => {
    if (!myRuns.length) return null;
    const meanLd = myRuns.reduce((acc, r) => acc + r.ld, 0) / myRuns.length;
    const peakCl = Math.max(...myRuns.map((r) => r.cl));
    const minCd = Math.min(...myRuns.map((r) => r.cd));
    const attachedCount = myRuns.filter((r) => r.separationPct < 25).length;
    const attachedPct = Math.round((attachedCount / myRuns.length) * 100);

    const byFoil = new Map<string, { name: string; bestLd: number; runs: number }>();
    for (const r of myRuns) {
      const prev = byFoil.get(r.airfoilName);
      if (!prev) {
        byFoil.set(r.airfoilName, { name: r.airfoilName, bestLd: r.ld, runs: 1 });
      } else {
        prev.runs += 1;
        if (r.ld > prev.bestLd) prev.bestLd = r.ld;
      }
    }
    const topFoils = Array.from(byFoil.values())
      .sort((a, b) => b.bestLd - a.bestLd)
      .slice(0, 4);
    const maxFoilLd = Math.max(0.1, ...topFoils.map((f) => f.bestLd));

    return { meanLd, peakCl, minCd, attachedPct, topFoils, maxFoilLd };
  }, [myRuns]);

  const personalBestLd = personalBestRun?.ld ?? (userProfile?.bestLd || null);
  const personalBestFoil =
    personalBestRun?.airfoilName || userProfile?.bestAirfoil || "—";

  const displayName =
    userProfile?.displayName ||
    user?.displayName ||
    user?.email?.split("@")[0] ||
    "Pilot";

  const activePhotoUrl = user?.photoURL || userProfile?.photoURL || "";
  const activeBannerUrl = user?.bannerURL || "";

  const initials = displayName
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() || "")
    .join("");

  const openProfileEditor = () => {
    setDraftName(displayName);
    setDraftRole(user?.role || "");
    setDraftOrganization(user?.organization || "");
    setDraftLocation(user?.location || "");
    setDraftBio(user?.bio || "");
    setAvatarFile(null);
    setAvatarPreviewUrl(null);
    setRemoveAvatarFlag(false);
    setBannerFile(null);
    setBannerPreviewUrl(null);
    setRemoveBannerFlag(false);
    setEditingProfile(true);
    setErrMsg(null);
  };

  const closeProfileEditor = () => {
    setEditingProfile(false);
    setAvatarFile(null);
    if (avatarPreviewUrl && avatarPreviewUrl.startsWith("blob:")) {
      URL.revokeObjectURL(avatarPreviewUrl);
    }
    setAvatarPreviewUrl(null);
    setRemoveAvatarFlag(false);
    setBannerFile(null);
    if (bannerPreviewUrl && bannerPreviewUrl.startsWith("blob:")) {
      URL.revokeObjectURL(bannerPreviewUrl);
    }
    setBannerPreviewUrl(null);
    setRemoveBannerFlag(false);
  };

  const selectAvatarFile = async (file: File | undefined | null) => {
    if (!file) return;
    setErrMsg(null);
    setProcessingAvatar(true);
    if (!editingProfile) {
      setDraftName(displayName);
      setDraftRole(user?.role || "");
      setDraftOrganization(user?.organization || "");
      setDraftLocation(user?.location || "");
      setDraftBio(user?.bio || "");
      setEditingProfile(true);
    }
    try {
      const { dataUrl } = await processAvatarImage(file);
      if (avatarPreviewUrl && avatarPreviewUrl.startsWith("blob:")) {
        URL.revokeObjectURL(avatarPreviewUrl);
      }
      setAvatarFile(file);
      setAvatarPreviewUrl(dataUrl);
      setRemoveAvatarFlag(false);
      setImgErr(false);
    } catch (err) {
      setAvatarFile(null);
      setErrMsg(err instanceof Error ? err.message : "Could not read the selected avatar image.");
    } finally {
      setProcessingAvatar(false);
    }
  };

  const selectBannerFile = async (file: File | undefined | null) => {
    if (!file) return;
    setErrMsg(null);
    setProcessingBanner(true);
    if (!editingProfile) {
      setDraftName(displayName);
      setDraftRole(user?.role || "");
      setDraftOrganization(user?.organization || "");
      setDraftLocation(user?.location || "");
      setDraftBio(user?.bio || "");
      setEditingProfile(true);
    }
    try {
      const { dataUrl } = await processBannerImage(file);
      if (bannerPreviewUrl && bannerPreviewUrl.startsWith("blob:")) {
        URL.revokeObjectURL(bannerPreviewUrl);
      }
      setBannerFile(file);
      setBannerPreviewUrl(dataUrl);
      setRemoveBannerFlag(false);
      setBannerErr(false);
    } catch (err) {
      setBannerFile(null);
      setErrMsg(err instanceof Error ? err.message : "Could not read the selected cover image.");
    } finally {
      setProcessingBanner(false);
    }
  };

  const handleAvatarInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    void selectAvatarFile(e.target.files?.[0]);
    e.target.value = "";
  };

  const handleBannerInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    void selectBannerFile(e.target.files?.[0]);
    e.target.value = "";
  };

  const handleAvatarDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setAvatarDragOver(false);
    void selectAvatarFile(e.dataTransfer.files?.[0]);
  };

  const handleBannerDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setBannerDragOver(false);
    void selectBannerFile(e.dataTransfer.files?.[0]);
  };

  const handleSaveProfile = async (e: FormEvent) => {
    e.preventDefault();
    const trimmedName = draftName.trim();
    if (!trimmedName) {
      setErrMsg("Display name cannot be empty.");
      return;
    }
    setSavingProfile(true);
    setErrMsg(null);
    try {
      await onUpdateProfile({
        displayName: trimmedName,
        bio: draftBio,
        role: draftRole,
        organization: draftOrganization,
        location: draftLocation,
        avatarFile,
        avatarDataUrl: avatarPreviewUrl?.startsWith("data:") ? avatarPreviewUrl : null,
        removeAvatar: removeAvatarFlag,
        bannerFile,
        bannerDataUrl: bannerPreviewUrl?.startsWith("data:") ? bannerPreviewUrl : null,
        removeBanner: removeBannerFlag,
      });
      closeProfileEditor();
      setImgErr(false);
      setBannerErr(false);
      notify("Profile details updated.");
    } catch (err) {
      setErrMsg(err instanceof Error ? err.message : "Could not save profile changes.");
    } finally {
      setSavingProfile(false);
    }
  };

  const handleLoadUpload = (item: SharedAirfoilDoc) => {
    setErrMsg(null);
    try {
      const { coords, fixes } = parseDatText(item.coordsText);
      onLoadAirfoil?.({
        id: item.id,
        choice: `cloud:${item.id}`,
        name: item.name,
        filename: item.filename,
        coords,
        fixes,
        isCustom: false,
        isShared: true,
        uploaderName: item.uploaderName,
      });
      navigate("/");
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : "Could not parse airfoil coordinates.");
    }
  };

  const handleRunInTunnel = async (run: BenchmarkRunDoc) => {
    setErrMsg(null);
    try {
      await onApplyRun?.(run);
      navigate("/");
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : "Could not load run in wind tunnel.");
    }
  };

  const handleDeleteRun = async (run: BenchmarkRunDoc) => {
    setErrMsg(null);
    try {
      await deleteBenchmarkRun(run.id, run.recorderUid);
      notify("Simulation run deleted.");
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : "Could not delete simulation run.");
    }
  };

  const handleDownloadRunSummary = async (run: BenchmarkRunDoc) => {
    const fallbackSummary = {
      id: run.id,
      airfoilName: run.airfoilName,
      airfoilId: run.airfoilId,
      kind: run.kind,
      metrics: {
        alphaDeg: Number(run.alpha.toFixed(2)),
        reynolds: run.reynolds,
        cl: Number(run.cl.toFixed(4)),
        cd: Number(run.cd.toFixed(4)),
        ldRatio: Number(run.ld.toFixed(3)),
        separationPct: Number(run.separationPct.toFixed(1)),
      },
      sourceLabel: run.sourceLabel,
      recordedAt: run.createdAtMs ? new Date(run.createdAtMs).toISOString() : "",
    };

    let jsonText = JSON.stringify(fallbackSummary, null, 2);
    if (run.storageUrl) {
      try {
        const res = await fetch(run.storageUrl);
        if (res.ok) {
          const text = await res.text();
          if (text.trim().startsWith("{")) {
            jsonText = text;
          }
        }
      } catch {
        // use generated summary JSON fallback
      }
    }
    const safeFoil = run.airfoilName.toLowerCase().replace(/[^a-z0-9]+/g, "_") || "run";
    downloadText(`${safeFoil}_result_summary.json`, jsonText, "application/json;charset=utf-8");
  };

  const handleExportRunsCsv = () => {
    if (!myRuns.length) return;
    const rows = myRuns.map((r) => ({
      airfoil: r.airfoilName,
      alpha_deg: Number(r.alpha.toFixed(1)),
      reynolds: r.reynolds,
      cl: Number(r.cl.toFixed(4)),
      cd: Number(r.cd.toFixed(4)),
      ld_ratio: Number(r.ld.toFixed(3)),
      separation_pct: Number(r.separationPct.toFixed(1)),
      source: r.sourceLabel,
      recorded_at: r.createdAtMs ? new Date(r.createdAtMs).toISOString() : "",
    }));
    const safeSlug =
      displayName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "") || "pilot";
    downloadText(`${safeSlug}_flight_log.csv`, toCsv(rows), "text/csv;charset=utf-8");
  };

  const handleAuthSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setLocalAuthErr(null);
    const trimmedEmail = emailInput.trim();
    if (!trimmedEmail || !trimmedEmail.includes("@")) {
      setLocalAuthErr("Enter a valid email address.");
      return;
    }
    if (passwordInput.length < 6) {
      setLocalAuthErr("Password must be at least 6 characters.");
      return;
    }
    if (authMode === "signup") {
      await onSignUpWithEmail?.(trimmedEmail, passwordInput, nameInput);
    } else {
      await onSignInWithEmail?.(trimmedEmail, passwordInput);
    }
  };

  const handleDeleteUpload = async (item: SharedAirfoilDoc) => {
    setErrMsg(null);
    try {
      await deleteSharedAirfoil(item.id, item.uploaderUid);
      notify("Airfoil removed.");
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : "Could not delete uploaded airfoil.");
    }
  };

  const handleLoadGlb = async (item: SharedGlbModelDoc) => {
    if (!onLoadGlbModel) return;
    setErrMsg(null);
    setLoadingGlbId(item.id);
    try {
      await onLoadGlbModel(item);
      navigate("/");
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : "Could not load 3D model.");
    } finally {
      setLoadingGlbId(null);
    }
  };

  const handleDownloadGlb = async (item: SharedGlbModelDoc) => {
    setErrMsg(null);
    try {
      const buffer = await downloadSharedGlbBuffer(item);
      const blob = new Blob([buffer], { type: "model/gltf-binary" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = item.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : "Could not download 3D model.");
    }
  };

  const handleDeleteGlb = async (item: SharedGlbModelDoc) => {
    setErrMsg(null);
    try {
      await deleteSharedGlbModel(item.id, item.uploaderUid, item.storagePath);
      notify("3D model removed.");
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : "Could not delete 3D model.");
    }
  };

  const displayedEditorAvatar = removeAvatarFlag
    ? ""
    : avatarPreviewUrl || activePhotoUrl;

  const displayedEditorBanner = removeBannerFlag
    ? ""
    : bannerPreviewUrl || activeBannerUrl;

  return (
    <div className="min-h-screen w-full bg-[var(--bg)] text-[var(--text)] flex flex-col font-sans">
      <header className="h-14 px-4 sm:px-6 border-b border-[var(--border)] bg-[var(--surface)] flex items-center justify-between gap-8 sticky top-0 z-30 shrink-0">
        <Link
          to="/"
          className="flex items-center gap-2 whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-[var(--accent)] rounded"
        >
          <img
            src="/aerolab-logo.png"
            alt="AeroLab"
            className="h-6 sm:h-7 w-auto object-contain shrink-0"
          />
          <span className="hidden sm:inline font-script text-xl leading-none text-[#1769AA] pt-0.5 whitespace-nowrap">
            Wind Tunnel
          </span>
        </Link>

        <nav
          aria-label="Profile navigation"
          className="hidden md:flex items-center gap-6 text-sm font-medium text-[#5C6670]"
        >
          <Link
            to="/"
            className="hover:text-[#161A1D] transition-colors whitespace-nowrap shrink-0"
          >
            Wind Tunnel
          </Link>
          <span className="text-[#1769AA] font-semibold whitespace-nowrap shrink-0">
            {user ? "Pilot Profile" : "Sign In"}
          </span>
        </nav>

        <div className="flex items-center gap-2 shrink-0">
          <Link
            to="/"
            className="btn btn-primary-accent btn-sm whitespace-nowrap shrink-0"
          >
            <ArrowLeft size={14} aria-hidden="true" />
            <span>Back to Tunnel</span>
          </Link>
        </div>
      </header>

      <input
        ref={avatarInputRef}
        type="file"
        accept="image/*"
        onChange={handleAvatarInputChange}
        className="hidden"
        aria-label="Upload profile avatar photo"
      />
      <input
        ref={bannerInputRef}
        type="file"
        accept="image/*"
        onChange={handleBannerInputChange}
        className="hidden"
        aria-label="Upload profile cover image"
      />

      {!authReady ? (
        <main className="flex-1 flex items-center justify-center p-6">
          <div className="antigravity-glass rounded-2xl px-8 py-6 text-sm text-[#5C6670]">
            Loading session…
          </div>
        </main>
      ) : !user ? (
        <main className="flex-1 flex items-center justify-center p-4 sm:p-8 bg-[radial-gradient(#D9DEE2_1px,transparent_1px)] [background-size:22px_22px]">
          <div className="w-full max-w-[420px] flex flex-col gap-4">
            {cloudError && (
              <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
                {cloudError}
              </div>
            )}

            <section
              aria-label="Sign in"
              className="antigravity-glass rounded-2xl p-7 sm:p-8 shadow-sm flex flex-col gap-6"
            >
              <div className="flex flex-col items-center text-center gap-3">
                <div className="flex flex-col items-center gap-1.5">
                  <img
                    src="/aerolab-logo.png"
                    alt="AeroLab"
                    className="h-9 w-auto object-contain"
                  />
                  <span className="font-script text-2xl leading-none text-[#1769AA]">
                    Wind Tunnel
                  </span>
                </div>

                <h1 className="text-xl font-bold text-[#161A1D] tracking-tight mt-1">
                  {authMode === "signin" ? "Welcome back" : "Create your account"}
                </h1>
              </div>

              <div
                role="tablist"
                aria-label="Authentication mode"
                className="grid grid-cols-2 p-1 rounded-xl bg-[var(--bg)] border border-[var(--border)] text-xs gap-1"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={authMode === "signin"}
                  onClick={() => {
                    setAuthMode("signin");
                    setLocalAuthErr(null);
                  }}
                  className={`py-2 px-3 rounded-lg font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                    authMode === "signin"
                      ? "bg-[#1769AA] text-white shadow-xs"
                      : "text-[#5C6670] hover:text-[#161A1D]"
                  }`}
                >
                  Sign In
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={authMode === "signup"}
                  onClick={() => {
                    setAuthMode("signup");
                    setLocalAuthErr(null);
                  }}
                  className={`py-2 px-3 rounded-lg font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                    authMode === "signup"
                      ? "bg-[#1769AA] text-white shadow-xs"
                      : "text-[#5C6670] hover:text-[#161A1D]"
                  }`}
                >
                  Create Account
                </button>
              </div>

              <form onSubmit={handleAuthSubmit} className="flex flex-col gap-3.5">
                {authMode === "signup" && (
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="pilot-name" className="text-xs font-semibold text-[#161A1D]">
                      Full Name
                    </label>
                    <div className="relative">
                      <User
                        size={15}
                        className="absolute left-3 top-1/2 -translate-y-1/2 text-[#5C6670] pointer-events-none"
                        aria-hidden="true"
                      />
                      <input
                        id="pilot-name"
                        type="text"
                        value={nameInput}
                        onChange={(e) => setNameInput(e.target.value)}
                        placeholder="Amelia Earhart"
                        maxLength={80}
                        autoComplete="name"
                        className="input pl-9 text-sm"
                      />
                    </div>
                  </div>
                )}

                <div className="flex flex-col gap-1.5">
                  <label htmlFor="pilot-email" className="text-xs font-semibold text-[#161A1D]">
                    Email
                  </label>
                  <div className="relative">
                    <Mail
                      size={15}
                      className="absolute left-3 top-1/2 -translate-y-1/2 text-[#5C6670] pointer-events-none"
                      aria-hidden="true"
                    />
                    <input
                      id="pilot-email"
                      type="email"
                      value={emailInput}
                      onChange={(e) => setEmailInput(e.target.value)}
                      placeholder="pilot@example.com"
                      required
                      autoComplete="email"
                      className="input pl-9 text-sm"
                    />
                  </div>
                </div>

                <div className="flex flex-col gap-1.5">
                  <label htmlFor="pilot-password" className="text-xs font-semibold text-[#161A1D]">
                    Password
                  </label>
                  <div className="relative">
                    <Lock
                      size={15}
                      className="absolute left-3 top-1/2 -translate-y-1/2 text-[#5C6670] pointer-events-none"
                      aria-hidden="true"
                    />
                    <input
                      id="pilot-password"
                      type={showPassword ? "text" : "password"}
                      value={passwordInput}
                      onChange={(e) => setPasswordInput(e.target.value)}
                      placeholder="••••••••"
                      required
                      minLength={6}
                      autoComplete={authMode === "signup" ? "new-password" : "current-password"}
                      className="input pl-9 pr-10 text-sm"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((v) => !v)}
                      aria-label={showPassword ? "Hide password" : "Show password"}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 rounded text-[#5C6670] hover:text-[#161A1D] cursor-pointer"
                    >
                      {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                    </button>
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={authBusy}
                  className="btn btn-primary-accent w-full mt-1 py-2.5 whitespace-nowrap"
                >
                  <LogIn size={15} aria-hidden="true" />
                  <span>
                    {authBusy
                      ? authMode === "signup"
                        ? "Creating account…"
                        : "Signing in…"
                      : authMode === "signup"
                        ? "Create Account"
                        : "Sign In"}
                  </span>
                </button>
              </form>

              {authNotice && (
                <div className="text-xs text-[#047857] bg-emerald-50 border border-emerald-200 rounded-lg px-3.5 py-2.5">
                  {authNotice}
                </div>
              )}

              {(localAuthErr || authError) && (
                <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3.5 py-2.5">
                  {localAuthErr || authError}
                </div>
              )}

              {onSignInWithGoogle && isSupabaseReady && (
                <>
                  <div className="flex items-center gap-3 text-[11px] text-[#5C6670]">
                    <span className="h-px flex-1 bg-[var(--border)]" />
                    <span>or</span>
                    <span className="h-px flex-1 bg-[var(--border)]" />
                  </div>

                  <button
                    type="button"
                    onClick={onSignInWithGoogle}
                    disabled={authBusy}
                    className="btn btn-secondary w-full whitespace-nowrap text-xs py-2.5"
                  >
                    <GoogleMark />
                    <span>Continue with Google</span>
                  </button>
                </>
              )}

              {!isSupabaseReady && onEnterLocalMode && (
                <>
                  <div className="flex items-center gap-3 text-[11px] text-[#5C6670]">
                    <span className="h-px flex-1 bg-[var(--border)]" />
                    <span>local workstation</span>
                    <span className="h-px flex-1 bg-[var(--border)]" />
                  </div>

                  <button
                    type="button"
                    onClick={onEnterLocalMode}
                    className="btn btn-secondary w-full whitespace-nowrap text-xs py-2.5"
                  >
                    <User size={14} aria-hidden="true" />
                    <span>Continue in Local Pilot Mode</span>
                  </button>
                </>
              )}
            </section>
          </div>
        </main>
      ) : (
        <main className="flex-1 w-full max-w-6xl mx-auto px-4 sm:px-6 py-6 sm:py-8 flex flex-col gap-6">
          {cloudError && (
            <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
              {cloudError}
            </div>
          )}

          <section
            aria-label="Pilot account overview"
            className="antigravity-glass rounded-2xl overflow-hidden flex flex-col"
          >
            <div className="relative h-28 sm:h-36 w-full border-b border-[var(--border)] bg-[radial-gradient(#C7D6E4_1px,transparent_1px)] [background-size:16px_16px] bg-[#EEF4F9] overflow-hidden">
              {activeBannerUrl && !bannerErr && (
                <img
                  src={activeBannerUrl}
                  alt={`${displayName} profile cover`}
                  onError={() => setBannerErr(true)}
                  className="w-full h-full object-cover"
                  referrerPolicy="no-referrer"
                />
              )}
              <button
                type="button"
                onClick={() => bannerInputRef.current?.click()}
                className="absolute top-3 right-3 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold bg-white/90 backdrop-blur-xs border border-[var(--border)] text-[#161A1D] hover:text-[#1769AA] hover:border-[#1769AA] transition-colors inline-flex items-center gap-1.5 shadow-xs cursor-pointer whitespace-nowrap"
              >
                <ImagePlus size={13} aria-hidden="true" />
                <span>{activeBannerUrl && !bannerErr ? "Change cover" : "Add cover"}</span>
              </button>
            </div>

            <div className="p-6 sm:p-7 pt-0 sm:pt-0 flex flex-col gap-6">
              <div className="flex flex-col md:flex-row md:items-end justify-between gap-5 -mt-10 sm:-mt-12 relative z-10">
                <div className="flex flex-col sm:flex-row sm:items-end gap-5 min-w-0 flex-1">
                  <div className="relative group shrink-0 self-start">
                    <button
                      type="button"
                      onClick={() => avatarInputRef.current?.click()}
                      title="Upload profile avatar"
                      aria-label="Upload profile avatar"
                      className="relative w-20 h-20 sm:w-24 sm:h-24 rounded-2xl border border-[var(--border)] ring-4 ring-white bg-[var(--accent-light)] overflow-hidden flex items-center justify-center cursor-pointer focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                    >
                      {activePhotoUrl && !imgErr ? (
                        <img
                          src={activePhotoUrl}
                          alt={displayName}
                          onError={() => setImgErr(true)}
                          className="w-full h-full object-cover"
                          referrerPolicy="no-referrer"
                        />
                      ) : (
                        <span className="text-2xl font-bold text-[#1769AA] select-none">
                          {initials || "A"}
                        </span>
                      )}
                      <span className="absolute inset-0 bg-[#161A1D]/55 text-white opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity flex flex-col items-center justify-center gap-1 text-[10px] font-semibold">
                        <Camera size={16} aria-hidden="true" />
                        <span>Avatar</span>
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => avatarInputRef.current?.click()}
                      aria-label="Change profile avatar"
                      className="absolute -bottom-1.5 -right-1.5 w-7 h-7 rounded-lg bg-[var(--surface)] border border-[var(--border)] text-[#161A1D] hover:text-[#1769AA] hover:border-[#1769AA] shadow-xs flex items-center justify-center transition-colors cursor-pointer"
                    >
                      <Camera size={13} aria-hidden="true" />
                    </button>
                  </div>

                  <div className="min-w-0 flex-1 flex flex-col gap-1.5 pt-2 sm:pt-12">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <h1 className="text-2xl font-bold text-[#161A1D] tracking-tight truncate">
                        {displayName}
                      </h1>
                      {user.role && (
                        <span className="text-xs font-semibold text-[#1769AA]">
                          {user.role}
                        </span>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-[#5C6670]">
                      <span className="font-mono truncate">{user.email}</span>
                      {user.organization && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="inline-flex items-center gap-1">
                            <Building2 size={12} aria-hidden="true" />
                            <span>{user.organization}</span>
                          </span>
                        </>
                      )}
                      {user.location && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="inline-flex items-center gap-1">
                            <MapPin size={12} aria-hidden="true" />
                            <span>{user.location}</span>
                          </span>
                        </>
                      )}
                      {userProfile?.createdAtMs ? (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono">
                            Joined {formatShortDate(userProfile.createdAtMs)}
                          </span>
                        </>
                      ) : null}
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 shrink-0 sm:pb-1">
                  <button
                    type="button"
                    onClick={() => (editingProfile ? closeProfileEditor() : openProfileEditor())}
                    className={`btn btn-sm whitespace-nowrap ${
                      editingProfile ? "btn-primary-accent" : "btn-secondary"
                    }`}
                  >
                    <SquarePen size={13} aria-hidden="true" />
                    <span>{editingProfile ? "Editing Profile" : "Edit Profile"}</span>
                  </button>
                  <Link to="/" className="btn btn-secondary btn-sm whitespace-nowrap">
                    <Wind size={13} aria-hidden="true" />
                    <span>New Run</span>
                  </Link>
                  <button
                    type="button"
                    onClick={onSignOut}
                    disabled={authBusy}
                    className="btn btn-secondary btn-sm hover:text-red-600 hover:border-red-300 whitespace-nowrap"
                  >
                    <LogOut size={13} aria-hidden="true" />
                    <span>Sign out</span>
                  </button>
                </div>
              </div>

              {user.bio ? (
                <p className="text-sm text-[#161A1D]/85 leading-relaxed max-w-3xl">
                  {user.bio}
                </p>
              ) : (
                <button
                  type="button"
                  onClick={openProfileEditor}
                  className="self-start text-xs text-[#5C6670] hover:text-[#1769AA] transition-colors cursor-pointer"
                >
                  + Add a pilot description or research bio
                </button>
              )}

            {editingProfile && (
              <form
                onSubmit={handleSaveProfile}
                className="pt-5 border-t border-[var(--border)] flex flex-col gap-5"
              >
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-sm font-bold text-[#161A1D]">
                    Edit Profile Details
                  </h2>
                  <button
                    type="button"
                    onClick={closeProfileEditor}
                    aria-label="Close profile editor"
                    className="p-1.5 rounded-lg text-[#5C6670] hover:text-[#161A1D] hover:bg-[var(--bg)] transition-colors cursor-pointer"
                  >
                    <X size={15} aria-hidden="true" />
                  </button>
                </div>

                {errMsg && (
                  <div
                    role="alert"
                    className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-xl px-4 py-2.5"
                  >
                    {errMsg}
                  </div>
                )}

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div
                    onDragOver={(e) => {
                      e.preventDefault();
                      setAvatarDragOver(true);
                    }}
                    onDragLeave={() => setAvatarDragOver(false)}
                    onDrop={handleAvatarDrop}
                    className={`rounded-xl border border-dashed p-4 flex items-center justify-between gap-3 transition-colors ${
                      avatarDragOver
                        ? "border-[#1769AA] bg-[var(--accent-light)]"
                        : "border-[var(--border)] bg-[var(--bg)]"
                    }`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-14 h-14 rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden flex items-center justify-center shrink-0">
                        {displayedEditorAvatar ? (
                          <img
                            src={displayedEditorAvatar}
                            alt="Avatar preview"
                            className="w-full h-full object-cover"
                            referrerPolicy="no-referrer"
                          />
                        ) : (
                          <span className="text-base font-bold text-[#1769AA]">
                            {initials || "A"}
                          </span>
                        )}
                      </div>
                      <div className="min-w-0">
                        <div className="text-xs font-bold text-[#161A1D]">Avatar Image</div>
                        <p className="text-[11px] text-[#5C6670] mt-0.5 truncate">
                          {processingAvatar
                            ? "Decoding & cropping…"
                            : isSupabaseReady
                              ? "Drop or upload · PNG, JPG, WebP"
                              : "Drop or upload · Saved locally"}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        disabled={processingAvatar}
                        onClick={() => avatarInputRef.current?.click()}
                        className="btn btn-secondary btn-sm whitespace-nowrap"
                      >
                        <Upload size={12} aria-hidden="true" />
                        <span>{processingAvatar ? "Reading…" : "Upload"}</span>
                      </button>
                      {displayedEditorAvatar && (
                        <button
                          type="button"
                          onClick={() => {
                            setAvatarFile(null);
                            if (avatarPreviewUrl && avatarPreviewUrl.startsWith("blob:")) {
                              URL.revokeObjectURL(avatarPreviewUrl);
                            }
                            setAvatarPreviewUrl(null);
                            setRemoveAvatarFlag(true);
                          }}
                          aria-label="Remove avatar image"
                          className="p-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-[#5C6670] hover:text-red-600 hover:border-red-300 transition-colors cursor-pointer"
                        >
                          <Trash2 size={13} aria-hidden="true" />
                        </button>
                      )}
                    </div>
                  </div>

                  <div
                    onDragOver={(e) => {
                      e.preventDefault();
                      setBannerDragOver(true);
                    }}
                    onDragLeave={() => setBannerDragOver(false)}
                    onDrop={handleBannerDrop}
                    className={`rounded-xl border border-dashed p-4 flex items-center justify-between gap-3 transition-colors ${
                      bannerDragOver
                        ? "border-[#1769AA] bg-[var(--accent-light)]"
                        : "border-[var(--border)] bg-[var(--bg)]"
                    }`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-20 h-14 rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden flex items-center justify-center shrink-0">
                        {displayedEditorBanner ? (
                          <img
                            src={displayedEditorBanner}
                            alt="Profile cover preview"
                            className="w-full h-full object-cover"
                            referrerPolicy="no-referrer"
                          />
                        ) : (
                          <ImagePlus size={18} className="text-[#5C6670]" aria-hidden="true" />
                        )}
                      </div>
                      <div className="min-w-0">
                        <div className="text-xs font-bold text-[#161A1D]">Profile Image</div>
                        <p className="text-[11px] text-[#5C6670] mt-0.5 truncate">
                          {processingBanner
                            ? "Decoding & cropping…"
                            : isSupabaseReady
                              ? "Wide cover banner · PNG, JPG, WebP"
                              : "Wide cover banner · Saved locally"}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        disabled={processingBanner}
                        onClick={() => bannerInputRef.current?.click()}
                        className="btn btn-secondary btn-sm whitespace-nowrap"
                      >
                        <Upload size={12} aria-hidden="true" />
                        <span>{processingBanner ? "Reading…" : "Upload"}</span>
                      </button>
                      {displayedEditorBanner && (
                        <button
                          type="button"
                          onClick={() => {
                            setBannerFile(null);
                            if (bannerPreviewUrl && bannerPreviewUrl.startsWith("blob:")) {
                              URL.revokeObjectURL(bannerPreviewUrl);
                            }
                            setBannerPreviewUrl(null);
                            setRemoveBannerFlag(true);
                          }}
                          aria-label="Remove profile cover image"
                          className="p-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-[#5C6670] hover:text-red-600 hover:border-red-300 transition-colors cursor-pointer"
                        >
                          <Trash2 size={13} aria-hidden="true" />
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="edit-display-name" className="text-xs font-semibold text-[#161A1D]">
                      Display Name
                    </label>
                    <div className="relative">
                      <User
                        size={14}
                        className="absolute left-3 top-1/2 -translate-y-1/2 text-[#5C6670] pointer-events-none"
                        aria-hidden="true"
                      />
                      <input
                        id="edit-display-name"
                        type="text"
                        value={draftName}
                        onChange={(e) => setDraftName(e.target.value)}
                        maxLength={80}
                        required
                        placeholder="Your name"
                        className="input pl-8 text-sm"
                      />
                    </div>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="edit-role" className="text-xs font-semibold text-[#161A1D]">
                      Role / Title
                    </label>
                    <div className="relative">
                      <Briefcase
                        size={14}
                        className="absolute left-3 top-1/2 -translate-y-1/2 text-[#5C6670] pointer-events-none"
                        aria-hidden="true"
                      />
                      <input
                        id="edit-role"
                        type="text"
                        value={draftRole}
                        onChange={(e) => setDraftRole(e.target.value)}
                        maxLength={60}
                        placeholder="e.g. Aerodynamics Engineer"
                        className="input pl-8 text-sm"
                      />
                    </div>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="edit-organization" className="text-xs font-semibold text-[#161A1D]">
                      Organization / Lab
                    </label>
                    <div className="relative">
                      <Building2
                        size={14}
                        className="absolute left-3 top-1/2 -translate-y-1/2 text-[#5C6670] pointer-events-none"
                        aria-hidden="true"
                      />
                      <input
                        id="edit-organization"
                        type="text"
                        value={draftOrganization}
                        onChange={(e) => setDraftOrganization(e.target.value)}
                        maxLength={60}
                        placeholder="e.g. Flight Test Group"
                        className="input pl-8 text-sm"
                      />
                    </div>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="edit-location" className="text-xs font-semibold text-[#161A1D]">
                      Location
                    </label>
                    <div className="relative">
                      <MapPin
                        size={14}
                        className="absolute left-3 top-1/2 -translate-y-1/2 text-[#5C6670] pointer-events-none"
                        aria-hidden="true"
                      />
                      <input
                        id="edit-location"
                        type="text"
                        value={draftLocation}
                        onChange={(e) => setDraftLocation(e.target.value)}
                        maxLength={60}
                        placeholder="e.g. Munich, DE"
                        className="input pl-8 text-sm"
                      />
                    </div>
                  </div>
                </div>

                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <label htmlFor="edit-bio" className="text-xs font-semibold text-[#161A1D]">
                      Description
                    </label>
                    <span className="text-[11px] font-mono tabular-nums text-[#5C6670]">
                      {draftBio.length} / 280
                    </span>
                  </div>
                  <textarea
                    id="edit-bio"
                    rows={3}
                    value={draftBio}
                    onChange={(e) => setDraftBio(e.target.value)}
                    maxLength={280}
                    placeholder="Share what airfoils, Reynolds regimes, or wing configurations you are testing…"
                    className="input text-sm leading-relaxed resize-y min-h-[82px]"
                  />
                </div>

                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={closeProfileEditor}
                    disabled={savingProfile}
                    className="btn btn-secondary btn-sm whitespace-nowrap"
                  >
                    <X size={13} aria-hidden="true" />
                    <span>Cancel</span>
                  </button>
                  <button
                    type="submit"
                    disabled={savingProfile}
                    className="btn btn-primary-accent btn-sm whitespace-nowrap"
                  >
                    <Check size={13} aria-hidden="true" />
                    <span>{savingProfile ? "Saving…" : "Save Changes"}</span>
                  </button>
                </div>
              </form>
            )}

            <div className="grid grid-cols-2 lg:grid-cols-4 divide-y sm:divide-y-0 sm:divide-x divide-[var(--border)] border-t border-[var(--border)] pt-4 -mx-1">
              <div className="px-3 py-1.5">
                <div className="text-xs font-medium text-[#5C6670]">Saved Runs</div>
                <div className="flex items-baseline gap-2 mt-0.5">
                  <span className="text-2xl font-bold font-mono tabular-nums text-[#161A1D]">
                    {myRuns.length}
                  </span>
                  {flightEnvelope && (
                    <span className="text-[11px] font-mono text-[#5C6670]">
                      {flightEnvelope.attachedPct}% attached
                    </span>
                  )}
                </div>
              </div>
              <div className="px-3 py-1.5">
                <div className="text-xs font-medium text-[#5C6670]">Uploaded Models</div>
                <div className="flex items-baseline gap-2 mt-0.5">
                  <span className="text-2xl font-bold font-mono tabular-nums text-[#161A1D]">
                    {myUploads.length + myGlbModels.length}
                  </span>
                  <span className="text-[11px] font-mono text-[#5C6670]">
                    {myUploads.length} .dat · {myGlbModels.length} .glb
                  </span>
                </div>
              </div>
              <div className="px-3 py-1.5">
                <div className="text-xs font-medium text-[#5C6670]">Personal Best L/D</div>
                <div className="flex items-baseline gap-2 mt-0.5">
                  <span className="text-2xl font-bold font-mono tabular-nums text-[#047857]">
                    {personalBestLd !== null && personalBestLd !== 0
                      ? personalBestLd.toFixed(2)
                      : "—"}
                  </span>
                  {personalBestRun && (
                    <span className="text-[11px] font-mono text-[#5C6670]">
                      @ {personalBestRun.alpha.toFixed(1)}°
                    </span>
                  )}
                </div>
              </div>
              <div className="px-3 py-1.5">
                <div className="text-xs font-medium text-[#5C6670]">Best Airfoil</div>
                <div className="flex items-baseline justify-between gap-2 mt-1">
                  <span className="text-lg sm:text-xl font-bold text-[#1769AA] truncate">
                    {personalBestFoil}
                  </span>
                  {personalBestRun && (
                    <span className="text-[11px] font-mono text-[#5C6670] shrink-0">
                      Re {personalBestRun.reynolds.toLocaleString()}
                    </span>
                  )}
                </div>
              </div>
            </div>
            </div>
          </section>

          {flightEnvelope && (
            <section
              aria-label="Flight envelope summary"
              className="antigravity-glass rounded-2xl p-5 sm:p-6 flex flex-col lg:flex-row lg:items-center justify-between gap-5"
            >
              <div className="flex flex-col gap-3 min-w-0 lg:w-1/2">
                <div className="flex items-center gap-2 text-sm font-bold text-[#161A1D]">
                  <BarChart3 size={16} className="text-[#1769AA]" aria-hidden="true" />
                  <span>Flight Envelope Summary</span>
                </div>
                <div className="grid grid-cols-3 divide-x divide-[var(--border)] rounded-xl border border-[var(--border)] bg-[var(--bg)] py-3 font-mono tabular-nums">
                  <div className="px-3.5">
                    <div className="text-[10.5px] font-sans text-[#5C6670]">Mean L/D</div>
                    <div className="text-base font-bold text-[#161A1D] mt-0.5">
                      {flightEnvelope.meanLd.toFixed(2)}
                    </div>
                  </div>
                  <div className="px-3.5">
                    <div className="text-[10.5px] font-sans text-[#5C6670]">Peak CL</div>
                    <div className="text-base font-bold text-[#1769AA] mt-0.5">
                      {flightEnvelope.peakCl.toFixed(3)}
                    </div>
                  </div>
                  <div className="px-3.5">
                    <div className="text-[10.5px] font-sans text-[#5C6670]">Min CD</div>
                    <div className="text-base font-bold text-[#D97706] mt-0.5">
                      {flightEnvelope.minCd.toFixed(4)}
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex flex-col gap-2 min-w-0 lg:w-1/2 lg:pl-6 lg:border-l border-[var(--border)]">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-bold text-[#161A1D] flex items-center gap-1.5">
                    <TrendingUp size={14} className="text-[#047857]" aria-hidden="true" />
                    <span>Top Airfoils by Peak L/D</span>
                  </span>
                  <span className="font-mono text-[11px] text-[#5C6670]">
                    {flightEnvelope.topFoils.length} tested
                  </span>
                </div>
                <div className="flex flex-col gap-2">
                  {flightEnvelope.topFoils.map((f) => {
                    const pct = Math.max(
                      8,
                      Math.min(100, (f.bestLd / flightEnvelope.maxFoilLd) * 100)
                    );
                    return (
                      <div key={f.name} className="flex items-center gap-2.5 text-xs">
                        <span className="w-28 truncate font-semibold text-[#161A1D] shrink-0">
                          {f.name}
                        </span>
                        <div className="flex-1 h-2 rounded-full bg-[var(--bg)] border border-[var(--border)] overflow-hidden">
                          <div
                            className="h-full bg-[#1769AA] rounded-full"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <span className="w-20 text-right font-mono tabular-nums text-[11px] text-[#047857] font-semibold shrink-0">
                          {f.bestLd.toFixed(2)} ({f.runs})
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </section>
          )}

          {(errMsg || authError) && (
            <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-xl px-4 py-2.5">
              {errMsg || authError}
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            <section
              aria-label="Past simulation results"
              className="lg:col-span-7 antigravity-glass rounded-2xl overflow-hidden flex flex-col min-w-0"
            >
              <div className="px-5 py-4 border-b border-[var(--border)] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <History size={16} className="text-[#1769AA] shrink-0" aria-hidden="true" />
                  <h2 className="text-sm font-bold text-[#161A1D]">
                    Past Simulation Results ({myRuns.length})
                  </h2>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <div className="relative flex-1 sm:w-40">
                    <Search
                      size={13}
                      className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#5C6670]"
                      aria-hidden="true"
                    />
                    <input
                      type="text"
                      value={runQuery}
                      onChange={(e) => setRunQuery(e.target.value)}
                      placeholder="Filter runs…"
                      aria-label="Filter simulation runs"
                      className="w-full pl-8 pr-2.5 py-1.5 rounded-lg text-xs bg-[var(--bg)] border border-[var(--border)] text-[var(--text)] focus:outline-none focus:border-[#1769AA]"
                    />
                  </div>
                  <div className="flex items-center p-0.5 rounded-lg bg-[var(--bg)] border border-[var(--border)] text-xs shrink-0">
                    {(
                      [
                        ["recent", "Recent"],
                        ["best", "Best L/D"],
                        ["cl", "Max CL"],
                      ] as const
                    ).map(([modeKey, label]) => (
                      <button
                        key={modeKey}
                        type="button"
                        onClick={() => setRunSort(modeKey)}
                        className={`px-2 py-1 rounded-md font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                          runSort === modeKey
                            ? "bg-white text-[#161A1D] shadow-xs"
                            : "text-[#5C6670] hover:text-[#161A1D]"
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  {myRuns.length > 0 && (
                    <button
                      type="button"
                      onClick={handleExportRunsCsv}
                      title="Export simulation history as CSV"
                      className="px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-[var(--bg)] border border-[var(--border)] text-[#161A1D] hover:border-[#1769AA] hover:text-[#1769AA] transition-colors inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                    >
                      <FileSpreadsheet size={13} aria-hidden="true" />
                      <span>CSV</span>
                    </button>
                  )}
                </div>
              </div>

              {filteredRuns.length === 0 ? (
                <div className="p-8 text-center flex flex-col items-center gap-3">
                  <p className="text-sm text-[#5C6670] max-w-sm leading-relaxed">
                    {myRuns.length === 0
                      ? "No saved simulation runs yet. Run an airfoil in the Wind Tunnel and save your result from NeuroFoil."
                      : "No simulation runs match your search filter."}
                  </p>
                  {myRuns.length === 0 && (
                    <Link to="/" className="btn btn-primary-accent btn-sm">
                      <Wind size={13} aria-hidden="true" />
                      <span>Open Wind Tunnel</span>
                    </Link>
                  )}
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-xs">
                    <thead className="bg-[var(--bg)] border-b border-[var(--border)] text-[#5C6670] font-semibold">
                      <tr>
                        <th className="text-left px-4 py-2.5">Airfoil</th>
                        <th className="text-right px-3 py-2.5">α</th>
                        <th className="text-right px-3 py-2.5">Re</th>
                        <th className="text-right px-3 py-2.5">CL</th>
                        <th className="text-right px-3 py-2.5">CD</th>
                        <th className="text-right px-3 py-2.5">L/D</th>
                        <th className="text-right px-4 py-2.5">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--border)] bg-white font-mono tabular-nums">
                      {filteredRuns.map((run) => (
                        <tr key={run.id} className="hover:bg-[var(--bg)] transition-colors">
                          <td className="px-4 py-3 font-sans">
                            <div className="flex items-center gap-1.5">
                              <span className="font-bold text-[#161A1D]">{run.airfoilName}</span>
                              {personalBestRun?.id === run.id && (
                                <Trophy
                                  size={13}
                                  className="text-[#D97706] shrink-0"
                                  aria-label="Personal best"
                                />
                              )}
                            </div>
                            <div className="text-[11px] font-mono text-[#5C6670] mt-0.5">
                              {formatShortDate(run.createdAtMs)} · Sep{" "}
                              {run.separationPct.toFixed(0)}%
                            </div>
                          </td>
                          <td className="px-3 py-3 text-right text-[#161A1D]">
                            {run.alpha.toFixed(1)}°
                          </td>
                          <td className="px-3 py-3 text-right text-[#5C6670]">
                            {run.reynolds.toLocaleString()}
                          </td>
                          <td className="px-3 py-3 text-right font-semibold text-[#1769AA]">
                            {run.cl.toFixed(3)}
                          </td>
                          <td className="px-3 py-3 text-right text-[#D97706]">
                            {run.cd.toFixed(4)}
                          </td>
                          <td className="px-3 py-3 text-right font-bold text-[#047857]">
                            {run.ld.toFixed(2)}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <div className="inline-flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => handleRunInTunnel(run)}
                                title="Re-run in Wind Tunnel"
                                className="px-2 py-1 rounded-md text-[11px] font-sans font-semibold bg-[var(--accent-light)] text-[#1769AA] hover:bg-[#1769AA] hover:text-white transition-colors inline-flex items-center gap-1 whitespace-nowrap cursor-pointer"
                              >
                                <Play size={11} aria-hidden="true" />
                                <span>Run</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => void handleDownloadRunSummary(run)}
                                title="Download result summary JSON"
                                aria-label={`Download summary for ${run.airfoilName}`}
                                className="p-1.5 rounded-md text-[#5C6670] hover:text-[#1769AA] transition-colors cursor-pointer"
                              >
                                <FileJson size={13} aria-hidden="true" />
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDeleteRun(run)}
                                title="Delete run"
                                aria-label={`Delete run ${run.airfoilName}`}
                                className="p-1.5 rounded-md text-[#5C6670] hover:text-red-600 transition-colors cursor-pointer"
                              >
                                <Trash2 size={13} aria-hidden="true" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section
              aria-label="Uploaded airfoils"
              className="lg:col-span-5 antigravity-glass rounded-2xl overflow-hidden flex flex-col min-w-0"
            >
              <div className="px-5 py-4 border-b border-[var(--border)] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Cloud size={16} className="text-[#1769AA] shrink-0" aria-hidden="true" />
                  <h2 className="text-sm font-bold text-[#161A1D]">
                    My Uploaded Airfoils ({myUploads.length})
                  </h2>
                </div>

                {myUploads.length > 0 && (
                  <div className="relative sm:w-44">
                    <Search
                      size={13}
                      className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#5C6670]"
                      aria-hidden="true"
                    />
                    <input
                      type="text"
                      value={uploadQuery}
                      onChange={(e) => setUploadQuery(e.target.value)}
                      placeholder="Search uploads…"
                      aria-label="Search uploaded airfoils"
                      className="w-full pl-8 pr-2.5 py-1.5 rounded-lg text-xs bg-[var(--bg)] border border-[var(--border)] text-[var(--text)] focus:outline-none focus:border-[#1769AA]"
                    />
                  </div>
                )}
              </div>

              {filteredUploads.length === 0 ? (
                <div className="p-8 text-center flex flex-col items-center gap-3">
                  <p className="text-sm text-[#5C6670] max-w-xs leading-relaxed">
                    {myUploads.length === 0
                      ? "No airfoils uploaded while signed in yet. Upload or share an airfoil from Controls → Airfoils."
                      : "No uploaded airfoils match your search."}
                  </p>
                  {myUploads.length === 0 && (
                    <Link to="/" className="btn btn-secondary btn-sm">
                      <Wind size={13} aria-hidden="true" />
                      <span>Go to Controls</span>
                    </Link>
                  )}
                </div>
              ) : (
                <div className="divide-y divide-[var(--border)] bg-white">
                  {filteredUploads.map((item) => (
                    <div
                      key={item.id}
                      className="px-4 py-3 flex items-center justify-between gap-3 hover:bg-[var(--bg)] transition-colors"
                    >
                      <button
                        type="button"
                        onClick={() => handleLoadUpload(item)}
                        className="flex items-center gap-3 flex-1 min-w-0 text-left cursor-pointer"
                      >
                        <AirfoilPreviewSvg coordsText={item.coordsText} />
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-bold text-[#161A1D] truncate">
                            {item.name}
                          </div>
                          <div className="text-[11px] font-mono tabular-nums text-[#5C6670] truncate mt-0.5">
                            c {item.camberPct.toFixed(1)}% · t {item.thicknessPct.toFixed(1)}% ·{" "}
                            {item.pointCount} pts · {formatShortDate(item.createdAtMs)}
                          </div>
                        </div>
                      </button>

                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          onClick={() => handleLoadUpload(item)}
                          title="Load in Wind Tunnel"
                          className="px-2 py-1 rounded-md text-[11px] font-semibold bg-[var(--accent-light)] text-[#1769AA] hover:bg-[#1769AA] hover:text-white transition-colors inline-flex items-center gap-1 whitespace-nowrap cursor-pointer"
                        >
                          <span>Load</span>
                          <ArrowUpRight size={11} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          onClick={() => downloadText(item.filename, item.coordsText)}
                          title="Download .dat"
                          aria-label={`Download ${item.name}`}
                          className="p-1.5 rounded-md text-[#5C6670] hover:text-[#1769AA] transition-colors cursor-pointer"
                        >
                          <Download size={13} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteUpload(item)}
                          title="Delete uploaded airfoil"
                          aria-label={`Delete ${item.name}`}
                          className="p-1.5 rounded-md text-[#5C6670] hover:text-red-600 transition-colors cursor-pointer"
                        >
                          <Trash2 size={13} aria-hidden="true" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>

          <section
            aria-label="Uploaded 3D models"
            className="antigravity-glass rounded-2xl overflow-hidden flex flex-col min-w-0"
          >
            <div className="px-5 py-4 border-b border-[var(--border)] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Box size={16} className="text-[#1769AA] shrink-0" aria-hidden="true" />
                <h2 className="text-sm font-bold text-[#161A1D]">
                  My Uploaded 3D Models (.glb) ({myGlbModels.length})
                </h2>
              </div>

              {myGlbModels.length > 0 && (
                <div className="relative sm:w-56">
                  <Search
                    size={13}
                    className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#5C6670]"
                    aria-hidden="true"
                  />
                  <input
                    type="text"
                    value={glbQuery}
                    onChange={(e) => setGlbQuery(e.target.value)}
                    placeholder="Search 3D models…"
                    aria-label="Search uploaded 3D models"
                    className="w-full pl-8 pr-2.5 py-1.5 rounded-lg text-xs bg-[var(--bg)] border border-[var(--border)] text-[var(--text)] focus:outline-none focus:border-[#1769AA]"
                  />
                </div>
              )}
            </div>

            {filteredGlbModels.length === 0 ? (
              <div className="p-8 text-center flex flex-col items-center gap-3">
                <p className="text-sm text-[#5C6670] max-w-md leading-relaxed">
                  {myGlbModels.length === 0
                    ? "No 3D .glb models uploaded while signed in yet. Upload any .glb mesh in the 3D CFD Wind Tunnel and it will be saved automatically."
                    : "No uploaded 3D models match your search."}
                </p>
                {myGlbModels.length === 0 && (
                  <Link to="/" className="btn btn-secondary btn-sm">
                    <Wind size={13} aria-hidden="true" />
                    <span>Open 3D Wind Tunnel</span>
                  </Link>
                )}
              </div>
            ) : (
              <div className="divide-y divide-[var(--border)] bg-white">
                {filteredGlbModels.map((item) => {
                  const sizeLabel =
                    item.fileSizeBytes >= 1024 * 1024
                      ? `${(item.fileSizeBytes / (1024 * 1024)).toFixed(1)} MB`
                      : `${Math.max(1, Math.round(item.fileSizeBytes / 1024))} KB`;
                  const isBusy = loadingGlbId === item.id;
                  return (
                    <div
                      key={item.id}
                      className="px-4 sm:px-5 py-3 flex items-center justify-between gap-3 hover:bg-[var(--bg)] transition-colors"
                    >
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => void handleLoadGlb(item)}
                        className="flex items-center gap-3 flex-1 min-w-0 text-left cursor-pointer disabled:opacity-60"
                      >
                        <div className="w-10 h-10 rounded-lg border border-[var(--border)] bg-[var(--bg)] flex items-center justify-center text-[#1769AA] shrink-0">
                          <Box size={16} aria-hidden="true" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="text-sm font-bold text-[#161A1D] truncate">
                              {item.name}
                            </span>
                            <span className="text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded bg-[var(--accent-light)] text-[#1769AA] shrink-0">
                              {formatModelClassLabel(item.modelClass)}
                            </span>
                          </div>
                          <div className="text-[11px] font-mono tabular-nums text-[#5C6670] truncate mt-0.5">
                            {sizeLabel} · Nose {item.noseAxis} · Up {item.upAxis} ·{" "}
                            {formatShortDate(item.createdAtMs)}
                          </div>
                        </div>
                      </button>

                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void handleLoadGlb(item)}
                          title="Load in 3D Wind Tunnel"
                          className="px-2.5 py-1 rounded-md text-[11px] font-semibold bg-[var(--accent-light)] text-[#1769AA] hover:bg-[#1769AA] hover:text-white disabled:opacity-60 transition-colors inline-flex items-center gap-1 whitespace-nowrap cursor-pointer"
                        >
                          <span>{isBusy ? "Loading…" : "Load 3D"}</span>
                          <ArrowUpRight size={11} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDownloadGlb(item)}
                          title="Download .glb"
                          aria-label={`Download ${item.name}`}
                          className="p-1.5 rounded-md text-[#5C6670] hover:text-[#1769AA] transition-colors cursor-pointer"
                        >
                          <Download size={13} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDeleteGlb(item)}
                          title="Delete uploaded 3D model"
                          aria-label={`Delete ${item.name}`}
                          className="p-1.5 rounded-md text-[#5C6670] hover:text-red-600 transition-colors cursor-pointer"
                        >
                          <Trash2 size={13} aria-hidden="true" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </main>
      )}

      <footer className="mt-auto py-3 px-4 sm:px-6 border-t border-[var(--border)] bg-[var(--surface)] flex flex-wrap items-center justify-between gap-2 text-[11px] text-[#5C6670]">
        <span className="font-medium text-[#161A1D]">AeroLab Workstation</span>
        <div className="flex items-center gap-2 whitespace-nowrap">
          <span className="font-medium text-[#161A1D]">Develop by Shadat Hossen Mahin</span>
          <span className="text-[var(--border)]" aria-hidden="true">·</span>
          <span className="font-mono">@2026</span>
        </div>
      </footer>
    </div>
  );
}
