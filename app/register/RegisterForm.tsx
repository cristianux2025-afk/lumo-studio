"use client";

import {FormEvent, useState} from "react";

type Props = {email: string; initialName: string; initialHandle?: string; returnTo: string; existing: boolean};

export default function RegisterForm({email, initialName, initialHandle, returnTo, existing}: Props) {
  const suggestedHandle = email.split("@")[0].toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 20);
  const [displayName, setDisplayName] = useState(initialName.slice(0, 50));
  const [handle, setHandle] = useState(initialHandle ?? suggestedHandle);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    const response = await fetch("/api/profile", {
      method: "PUT",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({displayName, handle}),
    }).catch(() => null);
    if (!response?.ok) {
      const body = await response?.json().catch(() => ({})) as {error?: string} | undefined;
      setError(body?.error ?? "No pudimos crear tu perfil.");
      setSaving(false);
      return;
    }
    window.location.href = returnTo;
  };

  return (
    <form className="account-form" onSubmit={submit}>
      <label>Nombre visible<input required maxLength={50} value={displayName} onChange={event => setDisplayName(event.target.value)} /></label>
      <label>Usuario<input required minLength={3} maxLength={24} pattern="[a-z0-9_]+" value={handle} onChange={event => setHandle(event.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))} /><small>Minúsculas, números y guion bajo.</small></label>
      <label>Cuenta verificada<input readOnly value={email} /></label>
      {error && <p className="account-error" role="alert">{error}</p>}
      <button className="account-primary" disabled={saving}>{saving ? "Guardando…" : existing ? "Guardar perfil" : "Crear mi perfil"}</button>
    </form>
  );
}
