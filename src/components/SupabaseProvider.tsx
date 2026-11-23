import {
  Component,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ErrorInfo,
  type ReactNode,
} from "react";
import type { User as SupabaseAuthUser } from "@supabase/supabase-js";
import { supabase } from "../utils/supabase.ts";
import {
  emitSync,
  ensureUserProfile,
  getLocalAvatar,
  getLocalBanner,
  getLocalPilotDetails,
  subscribePublicAirfoils,
  subscribePublicBenchmarks,
  subscribePublicGlbModels,
  subscribeUserProfile,
  updatePilotProfile,
  type BenchmarkRunDoc,
  type PilotDetails,
  type SharedAirfoilDoc,
  type SharedGlbModelDoc,
  type UserProfileDoc,
} from "../lib/airfoilRepository.ts";

export interface AppUser {
  uid: string;
  email: string;
  displayName: string;
  photoURL: string;
  bannerURL: string;
  bio: string;
  role: string;
  organization: string;
  location: string;
  emailVerified: boolean;
}

function toAppUser(u: SupabaseAuthUser | null): AppUser | null {
  if (!u) return null;
  const meta = u.user_metadata || {};
  const localDetails = getLocalPilotDetails(u.id);
  const localAvatar = getLocalAvatar(u.id);
  const localBanner = getLocalBanner(u.id);
  const avatarRemoved = meta.avatar_removed === true;
  const displayName = String(
    meta.full_name || meta.name || localDetails.displayName || u.email?.split("@")[0] || "AeroLab Pilot"
  );
  const photoURL = localAvatar
    ? localAvatar
    : avatarRemoved
      ? ""
      : String(meta.avatar_url || meta.picture || "");
  const bannerURL = localBanner || String(meta.banner_url || "");
  return {
    uid: u.id,
    email: u.email || "",
    displayName,
    photoURL,
    bannerURL,
    bio: String(meta.bio ?? localDetails.bio ?? ""),
    role: String(meta.role ?? localDetails.role ?? ""),
    organization: String(meta.organization ?? localDetails.organization ?? ""),
    location: String(meta.location ?? localDetails.location ?? ""),
    emailVerified: Boolean(u.email_confirmed_at || u.confirmed_at || u.email),
  };
}

export interface UpdateProfilePayload {
  displayName: string;
  bio: string;
  role: string;
  organization: string;
  location: string;
  avatarFile?: File | null;
  avatarDataUrl?: string | null;
  removeAvatar?: boolean;
  bannerFile?: File | null;
  bannerDataUrl?: string | null;
  removeBanner?: boolean;
}

const LOCAL_PILOT_UID = "local:pilot";
const LOCAL_PILOT_ACTIVE_KEY = "aerolab:local-pilot-active";

function buildLocalPilotUser(): AppUser {
  const details = getLocalPilotDetails(LOCAL_PILOT_UID);
  return {
    uid: LOCAL_PILOT_UID,
    email: "local-pilot@aerolab.workstation",
    displayName: details.displayName || "Local Pilot",
    photoURL: getLocalAvatar(LOCAL_PILOT_UID),
    bannerURL: getLocalBanner(LOCAL_PILOT_UID),
    bio: details.bio || "",
    role: details.role || "Aerodynamics Engineer",
    organization: details.organization || "Local Wind Tunnel",
    location: details.location || "",
    emailVerified: true,
  };
}

interface SupabaseContextValue {
  user: AppUser | null;
  userProfile: UserProfileDoc | null;
  authReady: boolean;
  authBusy: boolean;
  authError: string | null;
  authNotice: string | null;
  sharedAirfoils: SharedAirfoilDoc[];
  sharedGlbModels: SharedGlbModelDoc[];
  benchmarks: BenchmarkRunDoc[];
  cloudError: string | null;
  glbCloudError: string | null;
  isSupabaseReady: boolean;
  signInWithEmail: (email: string, password: string) => Promise<void>;
  signUpWithEmail: (email: string, password: string, displayName?: string) => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  enterLocalPilotMode: () => void;
  signOut: () => Promise<void>;
  updateProfile: (payload: UpdateProfilePayload) => Promise<PilotDetails>;
}

const SupabaseContext = createContext<SupabaseContextValue | null>(null);

export function useSupabase() {
  const ctx = useContext(SupabaseContext);
  if (!ctx) throw new Error("useSupabase must be used inside SupabaseProvider");
  return ctx;
}

interface ErrorBoundaryState {
  hasError: boolean;
  message: string;
}

export class AppErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, message: "" };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, message: error?.message || "Unexpected application error" };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Application ErrorBoundary caught:", error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen w-full bg-[var(--bg)] text-[var(--text)] flex items-center justify-center p-4">
          <div className="max-w-md w-full antigravity-glass rounded-xl p-5 flex flex-col gap-3">
            <h1 className="text-base font-bold text-[#161A1D]">AeroLab Encountered an Error</h1>
            <p className="text-xs text-[#5C6670] font-mono break-all bg-[var(--bg)] border border-[var(--border)] rounded-lg p-3">
              {this.state.message}
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="btn btn-primary-accent btn-sm self-start"
            >
              Reload Workstation
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export function SupabaseProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AppUser | null>(null);
  const [userProfile, setUserProfile] = useState<UserProfileDoc | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authNotice, setAuthNotice] = useState<string | null>(null);
  const [sharedAirfoils, setSharedAirfoils] = useState<SharedAirfoilDoc[]>([]);
  const [sharedGlbModels, setSharedGlbModels] = useState<SharedGlbModelDoc[]>([]);
  const [benchmarks, setBenchmarks] = useState<BenchmarkRunDoc[]>([]);
  const [cloudError, setCloudError] = useState<string | null>(null);
  const [glbCloudError, setGlbCloudError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;

    if (!supabase) {
      try {
        if (window.localStorage.getItem(LOCAL_PILOT_ACTIVE_KEY) === "1") {
          setUser(buildLocalPilotUser());
        }
      } catch {
        // ignore storage access issues
      }
      setAuthReady(true);
      setCloudError(null);
      return () => {
        alive = false;
      };
    }

    void supabase.auth.getSession().then(({ data }) => {
      if (!alive) return;
      const mapped = toAppUser(data.session?.user ?? null);
      setUser(mapped);
      setAuthReady(true);
      if (mapped) {
        void ensureUserProfile().catch(() => {});
      }
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      void supabase?.realtime.setAuth(session?.access_token ?? null);
      const mapped = toAppUser(session?.user ?? null);
      setUser(mapped);
      setAuthReady(true);
      if (!mapped) {
        setUserProfile(null);
      } else {
        void ensureUserProfile().catch(() => {});
      }
      emitSync("glb_models");
    });

    const unsubFoils = subscribePublicAirfoils(
      (items) => {
        setSharedAirfoils(items);
        setCloudError(null);
      },
      (err) => setCloudError(err.message)
    );

    const unsubBench = subscribePublicBenchmarks(
      (items) => {
        setBenchmarks(items);
        setCloudError(null);
      },
      (err) => setCloudError(err.message)
    );

    const unsubGlb = subscribePublicGlbModels(
      (items) => {
        setSharedGlbModels(items);
        setGlbCloudError(null);
      },
      (err) => setGlbCloudError(err.message)
    );

    return () => {
      alive = false;
      subscription.unsubscribe();
      unsubFoils();
      unsubBench();
      unsubGlb();
    };
  }, []);

  useEffect(() => {
    if (!authReady || !user || user.uid.startsWith("local:")) return undefined;
    const unsubProfile = subscribeUserProfile(
      user.uid,
      (profile) => setUserProfile(profile),
      (err) => setCloudError(err.message)
    );
    return () => unsubProfile();
  }, [authReady, user]);

  const signInWithEmail = useCallback(async (email: string, password: string) => {
    if (!supabase) {
      setAuthError("Account sign-in is unavailable in local mode.");
      return;
    }
    setAuthBusy(true);
    setAuthError(null);
    setAuthNotice(null);
    try {
      const { error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (error) throw error;
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : "Sign-in failed.");
    } finally {
      setAuthBusy(false);
    }
  }, []);

  const signUpWithEmail = useCallback(
    async (email: string, password: string, displayName?: string) => {
      if (!supabase) {
        setAuthError("Account registration is unavailable in local mode.");
        return;
      }
      setAuthBusy(true);
      setAuthError(null);
      setAuthNotice(null);
      try {
        const cleanName = (displayName || email.split("@")[0] || "AeroLab Pilot").trim().slice(0, 80);
        const { data, error } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: {
            data: { full_name: cleanName },
            emailRedirectTo: `${window.location.origin}/profile`,
          },
        });
        if (error) throw error;
        if (!data.session) {
          setAuthNotice(
            "Account created. Check your email inbox for the confirmation link, then sign in."
          );
        }
      } catch (err) {
        setAuthError(err instanceof Error ? err.message : "Sign-up failed.");
      } finally {
        setAuthBusy(false);
      }
    },
    []
  );

  const signInWithGoogle = useCallback(async () => {
    if (!supabase) {
      setAuthError("Google sign-in is unavailable in local mode.");
      return;
    }
    setAuthBusy(true);
    setAuthError(null);
    setAuthNotice(null);
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: `${window.location.origin}/profile`,
        },
      });
      if (error) throw error;
    } catch (err) {
      setAuthError(
        err instanceof Error
          ? err.message
          : "Google sign-in is currently unavailable."
      );
    } finally {
      setAuthBusy(false);
    }
  }, []);

  const enterLocalPilotMode = useCallback(() => {
    try {
      window.localStorage.setItem(LOCAL_PILOT_ACTIVE_KEY, "1");
    } catch {
      // ignore storage failure
    }
    setAuthError(null);
    setAuthNotice(null);
    setUser(buildLocalPilotUser());
  }, []);

  const handleSignOut = useCallback(async () => {
    if (!supabase || user?.uid.startsWith("local:")) {
      try {
        window.localStorage.removeItem(LOCAL_PILOT_ACTIVE_KEY);
      } catch {
        // ignore storage failure
      }
      setUser(null);
      setUserProfile(null);
      return;
    }
    setAuthBusy(true);
    setAuthError(null);
    setAuthNotice(null);
    setCloudError(null);
    try {
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : "Sign-out failed.");
    } finally {
      setAuthBusy(false);
    }
  }, [user?.uid]);

  const updateProfile = useCallback(
    async (payload: UpdateProfilePayload): Promise<PilotDetails> => {
      const saved = await updatePilotProfile({
        ...payload,
        localUid: user?.uid,
      });
      setUser((prev) =>
        prev
          ? {
              ...prev,
              displayName: saved.displayName,
              bio: saved.bio,
              role: saved.role,
              organization: saved.organization,
              location: saved.location,
              photoURL: saved.photoURL,
              bannerURL: saved.bannerURL,
            }
          : prev
      );
      setUserProfile((prev) =>
        prev
          ? {
              ...prev,
              displayName: saved.displayName,
              photoURL: saved.photoURL.startsWith("data:") ? prev.photoURL : saved.photoURL,
            }
          : prev
      );
      return saved;
    },
    [user?.uid]
  );

  return (
    <SupabaseContext.Provider
      value={{
        user,
        userProfile,
        authReady,
        authBusy,
        authError,
        authNotice,
        sharedAirfoils,
        sharedGlbModels,
        benchmarks,
        cloudError,
        glbCloudError,
        isSupabaseReady: Boolean(supabase),
        signInWithEmail,
        signUpWithEmail,
        signInWithGoogle,
        enterLocalPilotMode,
        signOut: handleSignOut,
        updateProfile,
      }}
    >
      {children}
    </SupabaseContext.Provider>
  );
}
