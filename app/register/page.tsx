import Link from "next/link";
import {requireChatGPTUser, safeStudioReturnPath} from "../chatgpt-auth";
import {database, ensureCollaborationSchema} from "../../db/collaboration";
import RegisterForm from "./RegisterForm";

export const dynamic = "force-dynamic";

type RegisterPageProps = {searchParams: Promise<{returnTo?: string | string[]}>};

export default async function RegisterPage({searchParams}: RegisterPageProps) {
  const params = await searchParams;
  const returnTo = safeStudioReturnPath(params.returnTo);
  const registerReturn = `/register?returnTo=${encodeURIComponent(returnTo)}`;
  const user = await requireChatGPTUser(registerReturn);
  await ensureCollaborationSchema();
  const profile = await database().prepare(
    "SELECT handle, display_name AS displayName FROM profiles WHERE email = ?",
  ).bind(user.email).first<{handle: string; displayName: string}>();
  return (
    <main className="account-shell">
      <section className="account-card">
        <Link className="account-brand" href="/"><span>L</span> Lumo Studio</Link>
        <p className="account-kicker">{profile ? "PERFIL" : "REGISTRO"}</p>
        <h1>{profile ? "Edita tu identidad de Lumo" : "Crea tu identidad de Lumo"}</h1>
        <p>Este nombre aparecerá en proyectos, comentarios y cursores colaborativos. Tu correo nunca se muestra a otros usuarios.</p>
        <RegisterForm
          email={user.email}
          initialName={profile?.displayName ?? user.fullName ?? user.displayName}
          initialHandle={profile?.handle}
          returnTo={returnTo}
          existing={Boolean(profile)}
        />
        <Link className="account-back" href={returnTo}>← Cancelar</Link>
      </section>
    </main>
  );
}
