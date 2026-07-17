import type { Metadata } from "next";
import LumoStudio from "./LumoStudio";
import {chatGPTSignOutPath, getChatGPTUser} from "./chatgpt-auth";
import {database, ensureCollaborationSchema} from "../db/collaboration";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Lumo Studio — Crea historias y juegos en equipo",
  description: "Un estudio de programación visual compatible con Scratch, con colaboración en tiempo real mediante enlaces de invitación.",
};

export default async function Home() {
  const user = await getChatGPTUser();
  let profile: {handle: string; displayName: string; avatarColor: string} | null = null;
  if (user) {
    await ensureCollaborationSchema();
    profile = await database().prepare(
      "SELECT handle, display_name AS displayName, avatar_color AS avatarColor FROM profiles WHERE email = ?",
    ).bind(user.email).first<{handle: string; displayName: string; avatarColor: string}>();
  }
  return <LumoStudio user={user} profile={profile} signOutPath={chatGPTSignOutPath("/")} />;
}
