import { useState, type FormEvent } from "react";
import { api, type Me } from "../api";
import type { Strings } from "../i18n";
import { Button, Input } from "../ui";

/** The sign-in screen of authenticated mode: the only thing shown until a person is known. */
export function Login({ t, onSignedIn }: { t: Strings; onSignedIn: (user: NonNullable<Me["user"]>) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) return;
    setBusy(true);
    setError(null);
    try {
      const { user } = await api.login(email.trim(), password);
      onSignedIn(user);
    } catch (err) {
      setError(err instanceof Error && err.message !== "sign in first" ? err.message : t.wrongCredentials);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-bg px-4">
      <form onSubmit={submit} className="w-full max-w-[380px] rounded-[14px] border border-line bg-panel p-7" aria-labelledby="signin-title">
        <div className="mb-6 flex items-center gap-2.5 font-display text-2xl font-semibold tracking-tight text-ink">
          <span className="accent-gradient flex h-[30px] w-[30px] items-center justify-center rounded-[9px] font-sans text-[15px] font-extrabold text-white">O</span>
          Opifer
        </div>
        <h1 id="signin-title" className="m-0 mb-1 font-display text-xl font-semibold">
          {t.signIn}
        </h1>
        <p className="mb-5 mt-0 text-sm text-mute">{t.signInHint}</p>
        <label className="mb-3 block text-sm font-semibold">
          {t.email}
          <div className="mt-1">
            <Input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          </div>
        </label>
        <label className="mb-5 block text-sm font-semibold">
          {t.password}
          <div className="mt-1">
            <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
        </label>
        {error && (
          <p role="alert" className="mb-4 mt-0 text-sm text-danger">
            {error}
          </p>
        )}
        <Button type="submit" disabled={busy || !email.trim() || !password} className="w-full justify-center">
          {t.signIn}
        </Button>
      </form>
    </main>
  );
}
