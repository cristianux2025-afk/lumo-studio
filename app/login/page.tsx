import Link from "next/link";
import {chatGPTSignInPath, getChatGPTUser, safeStudioReturnPath} from "../chatgpt-auth";

export const dynamic = "force-dynamic";

type LoginPageProps = {searchParams: Promise<{returnTo?: string | string[]}>};

export default async function LoginPage({searchParams}: LoginPageProps) {
  const params = await searchParams;
  const returnTo = safeStudioReturnPath(params.returnTo);
  const registerHref = `/register?returnTo=${encodeURIComponent(returnTo)}`;
  const user = await getChatGPTUser();
  return (
    <main className="account-shell">
      <section className="account-card">
        <Link className="account-brand" href="/"><span>L</span> Lumo Studio</Link>
        <p className="account-kicker">TU ESTUDIO, EN CUALQUIER EQUIPO</p>
        <h1>{user ? "Sesión iniciada" : "Inicia sesión en Lumo"}</h1>
        <p>Usa una identidad verificada en comentarios y sesiones colaborativas. La autenticación se realiza de forma segura con ChatGPT.</p>
        {user ? (
          <>
            <div className="account-user"><b>{user.displayName}</b><span>{user.email}</span></div>
            <Link className="account-primary" href={returnTo}>Volver al estudio</Link>
          </>
        ) : (
          <>
            <a className="account-primary" href={chatGPTSignInPath(returnTo)}>Continuar con ChatGPT</a>
            <Link className="account-secondary" href={registerHref}>Crear perfil de Lumo</Link>
          </>
        )}
        <Link className="account-back" href={returnTo}>← Seguir como invitado</Link>
      </section>
    </main>
  );
}
