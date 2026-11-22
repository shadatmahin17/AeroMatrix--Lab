import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";

export type ToastKind = "success" | "info" | "error";

interface ToastItem {
  id: number;
  message: string;
  kind: ToastKind;
}

interface ToastContextValue {
  notify: (message: string, kind?: ToastKind) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    return {
      notify: () => {},
    };
  }
  return ctx;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextIdRef = useRef(1);
  const timersRef = useRef<Map<number, number>>(new Map());

  const dismiss = useCallback((id: number) => {
    const timer = timersRef.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timersRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const notify = useCallback(
    (message: string, kind: ToastKind = "success") => {
      const clean = message.trim();
      if (!clean) return;
      const id = nextIdRef.current++;
      setToasts((prev) => [...prev.slice(-2), { id, message: clean, kind }]);
      const timer = window.setTimeout(() => {
        timersRef.current.delete(id);
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 3200);
      timersRef.current.set(id, timer);
    },
    []
  );

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      timers.clear();
    };
  }, []);

  return (
    <ToastContext.Provider value={{ notify }}>
      {children}
      {toasts.length > 0 && (
        <div
          aria-live="polite"
          aria-atomic="true"
          className="fixed bottom-10 right-4 z-50 flex flex-col gap-2 max-w-sm w-[calc(100vw-2rem)] sm:w-auto pointer-events-none"
        >
          {toasts.map((item) => (
            <div
              key={item.id}
              role="status"
              className="pointer-events-auto antigravity-glass rounded-xl px-3.5 py-2.5 shadow-lg border border-[var(--border)] flex items-center gap-2.5 text-xs font-medium text-[#161A1D]"
            >
              {item.kind === "error" ? (
                <AlertCircle size={15} className="text-red-600 shrink-0" aria-hidden="true" />
              ) : item.kind === "info" ? (
                <Info size={15} className="text-[#1769AA] shrink-0" aria-hidden="true" />
              ) : (
                <CheckCircle2 size={15} className="text-[#047857] shrink-0" aria-hidden="true" />
              )}
              <span className="flex-1 leading-snug">{item.message}</span>
              <button
                type="button"
                onClick={() => dismiss(item.id)}
                aria-label="Dismiss message"
                className="p-0.5 rounded text-[#5C6670] hover:text-[#161A1D] transition-colors cursor-pointer shrink-0"
              >
                <X size={13} aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      )}
    </ToastContext.Provider>
  );
}
