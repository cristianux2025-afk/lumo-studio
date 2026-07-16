"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Activity = { id: string; text: string; at: number };
type ProjectState = {
  blocksXml: string;
  selectedSprite: string;
  stageBackdrop: string;
  activity: Activity[];
};
type Member = {
  clientId: string;
  name: string;
  color: string;
  cursorX: number;
  cursorY: number;
  lastSeen: number;
};
type Comment = { id: string; author: string; color: string; message: string; createdAt: number };

const starterXml = `<xml xmlns="https://developers.google.com/blockly/xml">
  <block type="event_whenflagclicked" x="72" y="52">
    <next><block type="motion_movesteps"><value name="STEPS"><shadow type="math_number"><field name="NUM">24</field></shadow></value>
      <next><block type="looks_sayforsecs"><value name="MESSAGE"><shadow type="text"><field name="TEXT">¡Hola, equipo!</field></shadow></value><value name="SECS"><shadow type="math_number"><field name="NUM">2</field></shadow></value></block></next>
    </block></next>
  </block>
</xml>`;

const toolbox = `<xml>
  <category name="Movimiento" colour="#4C73FF"><block type="motion_movesteps"/><block type="motion_turnright"/><block type="motion_gotoxy"/><block type="motion_glidesecstoxy"/></category>
  <category name="Apariencia" colour="#9966FF"><block type="looks_sayforsecs"/><block type="looks_say"/><block type="looks_switchcostumeto"/><block type="looks_changesizeby"/></category>
  <category name="Sonido" colour="#CF63CF"><block type="sound_playuntildone"/><block type="sound_changevolumeby"/></category>
  <category name="Eventos" colour="#FFBF00"><block type="event_whenflagclicked"/><block type="event_whenkeypressed"/><block type="event_broadcast"/></category>
  <category name="Control" colour="#FFAB19"><block type="control_wait"/><block type="control_repeat"/><block type="control_forever"/><block type="control_if"/></category>
  <category name="Sensores" colour="#5CB1D6"><block type="sensing_touchingobject"/><block type="sensing_askandwait"/><block type="sensing_timer"/></category>
  <category name="Operadores" colour="#59C059"><block type="operator_add"/><block type="operator_equals"/><block type="operator_join"/><block type="operator_random"/></category>
</xml>`;

const colors = ["#6756E8", "#E34884", "#159A80", "#E87817", "#2878D0"];
const guestNames = ["Luna", "Pixel", "Nova", "Milo", "Sol"];

function readIdentity() {
  if (typeof window === "undefined") return { clientId: "server", name: "Creador", color: colors[0] };
  let clientId = sessionStorage.getItem("lumo-client-id");
  if (!clientId) {
    clientId = crypto.randomUUID();
    sessionStorage.setItem("lumo-client-id", clientId);
  }
  const seed = [...clientId].reduce((sum, letter) => sum + letter.charCodeAt(0), 0);
  return {
    clientId,
    name: `${guestNames[seed % guestNames.length]} ${String(seed).slice(-2)}`,
    color: colors[seed % colors.length],
  };
}

export default function LumoStudio() {
  const blocklyHost = useRef<HTMLDivElement>(null);
  const workspaceRef = useRef<any>(null);
  const scratchRef = useRef<any>(null);
  const applyingRemote = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cursor = useRef({ x: 50, y: 50 });
  const identity = useMemo(readIdentity, []);
  const [projectId, setProjectId] = useState("");
  const [token, setToken] = useState("");
  const [projectName, setProjectName] = useState("Aventura en el bosque lunar");
  const [version, setVersion] = useState(0);
  const versionRef = useRef(0);
  const [state, setState] = useState<ProjectState>({
    blocksXml: starterXml,
    selectedSprite: "Lumi",
    stageBackdrop: "Bosque lunar",
    activity: [{ id: "local", text: "Lienzo listo para crear", at: Date.now() }],
  });
  const stateRef = useRef(state);
  const [members, setMembers] = useState<Member[]>([]);
  const [comments, setComments] = useState<Comment[]>([]);
  const [running, setRunning] = useState(false);
  const [syncStatus, setSyncStatus] = useState("Listo");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(true);
  const [commentText, setCommentText] = useState("");
  const [toast, setToast] = useState("");
  const [loadError, setLoadError] = useState("");

  useEffect(() => { stateRef.current = state; }, [state]);
  useEffect(() => { versionRef.current = version; }, [version]);

  const updateState = useCallback((next: ProjectState, save = true) => {
    stateRef.current = next;
    setState(next);
    if (!save || !projectId || !token) return;
    setSyncStatus("Guardando…");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      const response = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, clientId: identity.clientId, name: projectName, state: stateRef.current }),
      }).catch(() => null);
      if (response?.ok) {
        const result = await response.json() as { version: number };
        setVersion(result.version);
        setSyncStatus("Sincronizado");
      } else setSyncStatus("Sin conexión");
    }, 420);
  }, [identity.clientId, projectId, projectName, token]);

  const applyWorkspaceXml = useCallback((xml: string) => {
    if (!workspaceRef.current || !scratchRef.current || !xml) return;
    try {
      applyingRemote.current = true;
      const ScratchBlocks = scratchRef.current;
      const dom = ScratchBlocks.Xml.textToDom(xml);
      workspaceRef.current.clear();
      ScratchBlocks.Xml.domToWorkspace(dom, workspaceRef.current);
    } finally {
      setTimeout(() => { applyingRemote.current = false; }, 80);
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    Promise.all([import("scratch-blocks"), import("@scratch/scratch-vm")]).then(([blocksModule, vmModule]) => {
      if (disposed || !blocklyHost.current) return;
      const ScratchBlocks = (blocksModule as any).default ?? blocksModule;
      const VirtualMachine = (vmModule as any).default ?? vmModule;
      scratchRef.current = ScratchBlocks;
      try {
        const vm = new VirtualMachine();
        vm.setTurboMode?.(true);
      } catch { /* The visual editor remains usable if WebAudio is unavailable. */ }
      const workspace = ScratchBlocks.inject(blocklyHost.current, {
        toolbox,
        media: "https://cdn.jsdelivr.net/npm/scratch-blocks@2.1.19/media/",
        trashcan: true,
        zoom: { controls: true, wheel: true, startScale: 0.86, maxScale: 1.35, minScale: 0.45 },
        grid: { spacing: 28, length: 2, colour: "#d7ddeb", snap: false },
        renderer: "geras",
      });
      workspaceRef.current = workspace;
      applyWorkspaceXml(stateRef.current.blocksXml || starterXml);
      workspace.addChangeListener((event: any) => {
        if (disposed || applyingRemote.current || event?.isUiEvent) return;
        const dom = ScratchBlocks.Xml.workspaceToDom(workspace);
        const blocksXml = ScratchBlocks.Xml.domToText(dom);
        const previous = stateRef.current;
        if (blocksXml === previous.blocksXml) return;
        updateState({
          ...previous,
          blocksXml,
          activity: [...previous.activity, { id: crypto.randomUUID(), text: `${identity.name} editó los bloques`, at: Date.now() }].slice(-20),
        });
      });
      window.dispatchEvent(new Event("resize"));
    });
    return () => {
      disposed = true;
      workspaceRef.current?.dispose?.();
    };
  }, [applyWorkspaceXml, identity.name, updateState]);

  const loadProject = useCallback(async (id: string, inviteToken: string) => {
    const response = await fetch(`/api/projects/${id}?token=${encodeURIComponent(inviteToken)}`, { cache: "no-store" }).catch(() => null);
    if (!response?.ok) {
      setLoadError("Este enlace de invitación no es válido o ya no está disponible.");
      return;
    }
    const data = await response.json() as {
      name: string; state: ProjectState; version: number; members: Member[]; comments: Comment[]; updatedBy: string;
    };
    setProjectName(data.name);
    setMembers(data.members ?? []);
    setComments(data.comments ?? []);
    if (data.version > versionRef.current) {
      const previousXml = stateRef.current.blocksXml;
      setVersion(data.version);
      updateState(data.state, false);
      if (data.state.blocksXml && data.state.blocksXml !== previousXml) applyWorkspaceXml(data.state.blocksXml);
    }
    setSyncStatus("En vivo");
  }, [applyWorkspaceXml, updateState]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get("project") ?? "";
    const invite = params.get("invite") ?? "";
    if (id && invite) {
      setProjectId(id);
      setToken(invite);
      void loadProject(id, invite);
    }
  }, [loadProject]);

  useEffect(() => {
    if (!projectId || !token) return;
    const heartbeat = async () => {
      await fetch(`/api/projects/${projectId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "presence", token, clientId: identity.clientId, name: identity.name,
          color: identity.color, cursorX: cursor.current.x, cursorY: cursor.current.y,
        }),
      }).catch(() => null);
    };
    void heartbeat();
    const presenceTimer = setInterval(heartbeat, 2600);
    const syncTimer = setInterval(() => void loadProject(projectId, token), 1400);
    return () => { clearInterval(presenceTimer); clearInterval(syncTimer); };
  }, [identity, loadProject, projectId, token]);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      cursor.current = { x: Math.round((event.clientX / window.innerWidth) * 100), y: Math.round((event.clientY / window.innerHeight) * 100) };
    };
    window.addEventListener("pointermove", move, { passive: true });
    return () => window.removeEventListener("pointermove", move);
  }, []);

  const ensureProject = async () => {
    if (projectId && token) return { id: projectId, inviteToken: token };
    setSyncStatus("Creando proyecto…");
    const response = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: projectName, clientId: identity.clientId }),
    });
    if (!response.ok) throw new Error("No se pudo crear el proyecto");
    const data = await response.json() as { id: string; inviteToken: string; version: number };
    setProjectId(data.id);
    setToken(data.inviteToken);
    setVersion(data.version);
    const url = new URL(window.location.href);
    url.searchParams.set("project", data.id);
    url.searchParams.set("invite", data.inviteToken);
    window.history.replaceState({}, "", url);
    await fetch(`/api/projects/${data.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: data.inviteToken, clientId: identity.clientId, name: projectName, state: stateRef.current }),
    });
    return data;
  };

  const shareProject = async () => {
    try {
      const data = await ensureProject();
      const url = new URL(window.location.href);
      url.searchParams.set("project", data.id);
      url.searchParams.set("invite", data.inviteToken);
      await navigator.clipboard?.writeText(url.toString());
      setInviteOpen(true);
      setToast("Enlace de invitación copiado");
      setTimeout(() => setToast(""), 2400);
    } catch {
      setToast("No pudimos crear la invitación");
    }
  };

  const addComment = async () => {
    if (!commentText.trim()) return;
    const data = await ensureProject();
    await fetch(`/api/projects/${data.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "comment", token: data.inviteToken, name: identity.name, color: identity.color, message: commentText }),
    });
    setCommentText("");
    await loadProject(data.id, data.inviteToken);
  };

  const selectSprite = (sprite: string) => {
    const next = { ...stateRef.current, selectedSprite: sprite, activity: [...stateRef.current.activity, { id: crypto.randomUUID(), text: `${identity.name} seleccionó ${sprite}`, at: Date.now() }].slice(-20) };
    updateState(next);
  };

  const inviteUrl = typeof window === "undefined" || !projectId ? "" : `${window.location.origin}/?project=${projectId}&invite=${token}`;
  const remoteMembers = members.filter((member) => member.clientId !== identity.clientId);

  return (
    <main className="studio-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Inicio de Lumo Studio"><span className="brand-mark">L</span><span>Lumo <b>Studio</b></span></a>
        <div className="project-title-wrap">
          <span className="project-label">PROYECTO</span>
          <input aria-label="Nombre del proyecto" value={projectName} onChange={(event) => setProjectName(event.target.value.slice(0, 70))} onBlur={() => updateState(stateRef.current)} />
        </div>
        <div className="sync-pill"><span className={syncStatus === "Sin conexión" ? "sync-dot offline" : "sync-dot"} />{syncStatus}</div>
        <div className="top-actions">
          <button className="icon-button" aria-label="Deshacer" onClick={() => workspaceRef.current?.undo?.(false)}>↶</button>
          <button className="icon-button" aria-label="Rehacer" onClick={() => workspaceRef.current?.undo?.(true)}>↷</button>
          <div className="avatar-stack" aria-label={`${members.length || 1} personas conectadas`}>
            {(members.length ? members : [{ clientId: identity.clientId, name: identity.name, color: identity.color } as Member]).slice(0, 4).map((member) => (
              <span key={member.clientId} className="mini-avatar" style={{ background: member.color }} title={member.name}>{member.name.charAt(0)}</span>
            ))}
          </div>
          <button className="invite-button" onClick={shareProject}><span>＋</span> Invitar</button>
        </div>
      </header>

      {loadError && <div className="error-banner">{loadError} <button onClick={() => { setLoadError(""); window.history.replaceState({}, "", "/"); }}>Crear uno nuevo</button></div>}

      <section className="editor-grid">
        <aside className="left-panel">
          <div className="editor-tabs"><button className="active">Código</button><button>Disfraces</button><button>Sonidos</button></div>
          <div className="engine-note"><span>●</span> Motor Scratch + Gandi</div>
          <div className="tool-hint"><strong>Arrastra bloques</strong><span>Combínalos para dar vida a {state.selectedSprite}.</span></div>
          <div className="quick-actions">
            <button onClick={() => workspaceRef.current?.cleanUp?.()}>Ordenar bloques</button>
            <button onClick={() => workspaceRef.current?.zoomToFit?.()}>Ver todo</button>
          </div>
          <div className="lesson-card"><span className="lesson-badge">RETO DEL DÍA</span><strong>Haz que Lumi salude y avance 24 pasos</strong><div><span>2 de 3 bloques</span><span>67%</span></div><i><b /></i></div>
          <button className="extensions-button">▦ Añadir extensión</button>
        </aside>

        <section className="workspace-panel">
          <div className="workspace-toolbar"><div><button className="active">Lógica</button><button>Datos</button></div><span>Edición compartida activa</span></div>
          <div className="blockly-wrap">
            <div ref={blocklyHost} className="blockly-host" aria-label="Editor visual de bloques" />
            {remoteMembers.map((member) => (
              <div key={member.clientId} className="remote-cursor" style={{ left: `${member.cursorX}%`, top: `${member.cursorY}%`, color: member.color }}><span>➤</span><b style={{ background: member.color }}>{member.name}</b></div>
            ))}
          </div>
        </section>

        <aside className="stage-panel">
          <div className="stage-toolbar"><div><button className="run-button" onClick={() => setRunning(true)} aria-label="Ejecutar">▶</button><button className="stop-button" onClick={() => setRunning(false)} aria-label="Detener">■</button></div><span>{state.stageBackdrop}</span><button aria-label="Pantalla completa">⛶</button></div>
          <div className="stage">
            <div className="moon" /><div className="hill one" /><div className="hill two" /><div className="stars">✦　·　✧<br />　·　　✦</div>
            <div className={`lumi-character ${running ? "running" : ""}`} aria-label="Personaje Lumi"><span className="ear left"/><span className="ear right"/><span className="face">• ᴗ •</span><i /></div>
            {running && <div className="speech">¡Hola, equipo!</div>}
          </div>
          <div className="sprite-heading"><strong>Personajes</strong><span>x 0　y 0　tamaño 100</span></div>
          <div className="sprite-list">
            {[{ name: "Lumi", icon: "✦" }, { name: "Brisa", icon: "☁" }, { name: "Rocío", icon: "❋" }].map((sprite) => (
              <button key={sprite.name} className={state.selectedSprite === sprite.name ? "sprite-card selected" : "sprite-card"} onClick={() => selectSprite(sprite.name)}><span>{sprite.icon}</span><b>{sprite.name}</b></button>
            ))}
            <button className="add-sprite" aria-label="Añadir personaje">＋</button>
          </div>
          <div className="team-panel">
            <div className="team-tabs"><button className={!activityOpen ? "active" : ""} onClick={() => setActivityOpen(false)}>Comentarios <span>{comments.length}</span></button><button className={activityOpen ? "active" : ""} onClick={() => setActivityOpen(true)}>Actividad</button></div>
            {activityOpen ? (
              <div className="activity-list">
                {(state.activity.length ? [...state.activity].reverse() : [{ id: "start", text: "Proyecto listo", at: Date.now() }]).slice(0, 4).map((item) => <div key={item.id}><span className="activity-icon">✓</span><p>{item.text}<small>{new Date(item.at).toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" })}</small></p></div>)}
              </div>
            ) : (
              <div className="comments-list">
                {comments.slice(0, 3).map((comment) => <div key={comment.id}><span className="comment-avatar" style={{ background: comment.color }}>{comment.author.charAt(0)}</span><p><b>{comment.author}</b>{comment.message}</p></div>)}
                {!comments.length && <p className="empty-comments">Comenta una idea para tu equipo.</p>}
                <div className="comment-compose"><input value={commentText} onChange={(event) => setCommentText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void addComment(); }} placeholder="Escribe un comentario…" aria-label="Nuevo comentario"/><button onClick={addComment}>↑</button></div>
              </div>
            )}
          </div>
        </aside>
      </section>

      {inviteOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setInviteOpen(false); }}><section className="invite-modal" role="dialog" aria-modal="true" aria-labelledby="invite-title"><button className="modal-close" onClick={() => setInviteOpen(false)}>×</button><span className="modal-icon">↗</span><h2 id="invite-title">Crea en equipo</h2><p>Cualquier persona con este enlace podrá entrar y editar el proyecto contigo en tiempo real.</p><label>Enlace de invitación</label><div className="invite-link"><input readOnly value={inviteUrl}/><button onClick={() => { void navigator.clipboard?.writeText(inviteUrl); setToast("Enlace copiado otra vez"); }}>Copiar</button></div><div className="live-proof"><div className="avatar-stack">{[identity, ...remoteMembers].slice(0,3).map((member) => <span key={member.clientId} className="mini-avatar" style={{ background: member.color }}>{member.name.charAt(0)}</span>)}</div><span><b>{Math.max(1, members.length)} en línea</b> · cambios sincronizados</span></div><small>Consejo: abre el enlace en otra ventana para probar la colaboración.</small></section></div>}
      {toast && <div className="toast" role="status">✓ {toast}</div>}
    </main>
  );
}
