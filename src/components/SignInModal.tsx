import { useEffect, useState } from "react";
import type { User } from "firebase/auth";
import { AUTH_PROVIDERS } from "../watchlist";

const G = (
  <svg viewBox="0 0 48 48" width="19" height="19" aria-hidden="true">
    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
    <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
  </svg>
);
const Apple = (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
    <path d="M16.36 12.78c.02 2.32 2.03 3.09 2.05 3.1-.02.05-.32 1.11-1.06 2.19-.64.94-1.31 1.87-2.35 1.89-1.03.02-1.36-.61-2.54-.61-1.18 0-1.55.59-2.52.63-1.01.04-1.78-1.02-2.43-1.95-1.32-1.91-2.33-5.41-.97-7.77.67-1.17 1.87-1.91 3.17-1.93.99-.02 1.93.67 2.54.67.61 0 1.75-.83 2.95-.71.5.02 1.92.2 2.83 1.54-.07.05-1.69.99-1.67 2.94M14.62 5.9c.54-.66.9-1.57.8-2.47-.78.03-1.72.52-2.28 1.17-.5.58-.94 1.51-.82 2.39.87.07 1.76-.44 2.3-1.09" />
  </svg>
);
const FB = (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="#1877F2" aria-hidden="true">
    <path d="M24 12.07C24 5.4 18.63 0 12 0S0 5.4 0 12.07C0 18.1 4.39 23.1 10.13 24v-8.44H7.08v-3.49h3.05V9.41c0-3.02 1.79-4.69 4.53-4.69 1.31 0 2.68.24 2.68.24v2.97h-1.51c-1.49 0-1.96.93-1.96 1.89v2.25h3.33l-.53 3.49h-2.8V24C19.61 23.1 24 18.1 24 12.07" />
  </svg>
);

// Brand icons keyed by provider id. Any provider without an entry here still
// renders — it just gets a monogram of its label. So adding a provider to
// AUTH_PROVIDERS is enough; a bespoke icon is optional.
const ICONS: Record<string, React.ReactNode> = { google: G, apple: Apple, facebook: FB };

function friendlyError(e: unknown): string {
  const code = (e as { code?: string })?.code || "";
  if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") return "";
  if (code === "auth/unauthorized-domain") return "This site isn't an authorized domain in Firebase yet.";
  if (code === "auth/operation-not-allowed") return "That sign-in provider isn't enabled in Firebase.";
  if (code === "auth/popup-blocked") return "Your browser blocked the popup — allow popups and retry.";
  return "Sign-in failed. Please try again.";
}

interface SignInModalProps {
  user: User | null;
  signIn: (id: string) => Promise<void>;
  signOut: () => void;
  onClose: () => void;
}

export default function SignInModal({ user, signIn, signOut, onClose }: SignInModalProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const go = async (id: string) => {
    setBusy(id);
    setErr("");
    try {
      await signIn(id);
      onClose();
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className="si-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="si-modal" role="dialog" aria-modal="true" aria-label="Sign in">
        <button className="si-close" aria-label="Close" onClick={onClose}>
          &times;
        </button>
        <div className="si-badge" aria-hidden="true">★</div>

        {user ? (
          <>
            <h3>You're signed in</h3>
            <p>
              Synced as <b>{user.email ?? user.displayName ?? "your account"}</b>. Your watchlist
              follows you across devices.
            </p>
            <button className="si-out" type="button" onClick={() => { signOut(); onClose(); }}>
              Sign out
            </button>
          </>
        ) : (
          <>
            <h3>Sync your watchlist</h3>
            <p>Sign in to track stocks and see them on every device — iPhone, iPad and PC.</p>
            <div className="si-provs">
              {AUTH_PROVIDERS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="si-prov"
                  disabled={busy != null}
                  onClick={() => go(p.id)}
                >
                  <span className="si-ico">
                    {ICONS[p.id] ?? <span className="si-mono">{p.label.slice(0, 1).toUpperCase()}</span>}
                  </span>
                  {busy === p.id ? "Signing in…" : `Continue with ${p.label}`}
                </button>
              ))}
            </div>
            {err && <p className="si-err">{err}</p>}
            <p className="si-fine">Private to you — we only store your ticker list.</p>
          </>
        )}
      </div>
    </div>
  );
}
