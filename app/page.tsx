import type { Metadata } from "next";
import LumoStudio from "./LumoStudio";

export const metadata: Metadata = {
  title: "Lumo Studio — Crea historias y juegos en equipo",
  description: "Un estudio de programación visual compatible con Scratch, con colaboración en tiempo real mediante enlaces de invitación.",
};

export default function Home() {
  return <LumoStudio />;
}
