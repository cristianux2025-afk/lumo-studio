# Lumo Studio

Lumo Studio es un estudio libre de programación visual compatible con proyectos Scratch 3, con edición colaborativa mediante enlaces de invitación.

- Sitio: <https://lumo-studio.onovapremium2.chatgpt.site>
- Código: <https://github.com/cristianux2025-afk/lumo-studio>

## Qué funciona

- Scratch Blocks con 9 categorías base y categorías adicionales al instalar extensiones.
- Scratch VM, Renderer WebGL, Audio, Storage y adaptador SVG/bitmap conectados al editor.
- Bandera verde, detener, teclado, ratón, vista previa y pantalla completa.
- Ejecución de Scratch VM a 60 TPS. El lienzo se presenta con `requestAnimationFrame`; los FPS visibles dependen del navegador y del equipo.
- Cada proyecto nuevo empieza con un escenario blanco y sin sprites, imágenes ni bloques de relleno.
- Apartados independientes para sprites y fondos, además de posición, tamaño y dirección.
- Editor gráfico para disfraces y fondos con pincel, borrador, línea, rectángulo, elipse, relleno, cuentagotas, zoom y deshacer/rehacer.
- Disfraces y fondos SVG/PNG/JPG y sonidos WAV/MP3, con recursos sincronizados entre colaboradores.
- Importación y exportación de proyectos `.sb3`.
- Extensiones integradas de Lápiz, Música, Texto a voz y Traducir.
- Inicio de sesión con ChatGPT y perfil persistente de Lumo.
- Invitación editable por enlace, presencia, cursores, actividad y comentarios.

## Colaboración

El token incluido en el enlace concede permiso de edición: cualquier persona que tenga el enlace puede modificar el proyecto.

- Los eventos Blockly se guardan en orden en D1 y se consultan cada 350 ms.
- Los cambios estructurales —personajes, propiedades, recursos e importaciones— usan snapshots versionados con control optimista y rebase de tres vías para conservar ediciones disjuntas tras un conflicto.
- Cada personaje lleva un identificador persistente dentro del snapshot. Un renombre concurrente se fusiona con las propiedades del mismo personaje y los nombres duplicados se desambiguan sin descartar objetos.
- Presencia, cursores, comentarios y comprobación de snapshots se actualizan cada 2,5 s.
- La comprobación periódica omite el estado completo cuando la versión no cambió; el snapshot sólo se descarga cuando hace falta.
- Los disfraces y sonidos se almacenan como BLOB inmutables, con un máximo de 1,75 MB por recurso para respetar el límite de fila de D1. Antes de guardar, el servidor verifica contenido, metadatos y referencias. Cada carga recibe una ventana de seguridad renovable; después de confirmar el snapshot, sólo se eliminan recursos antiguos que ya no estén referenciados.
- Cada proyecto compartido admite hasta 100 recursos y 50 MB de recursos sincronizados; ambas cuotas se aplican atómicamente. Se conservan los 200 comentarios más recientes.
- Cada pestaña usa una identidad efímera distinta para evitar que dos pestañas del mismo navegador ignoren sus cambios.
- Las mutaciones tienen límites de frecuencia fijos por proyecto y red, además de límites por identidad, de modo que cambiar el ID del cliente no amplía la cuota. Los nombres autenticados se derivan del perfil guardado y nunca usan el correo como nombre público; las personas sin sesión aparecen explícitamente como invitadas.

Esta versión usa colaboración de baja latencia sobre HTTP y D1. Todavía no incluye WebSocket, un CRDT completo, roles, revocación de enlaces, historial restaurable ni edición offline. Las ediciones disjuntas se combinan; cuando dos personas cambian exactamente el mismo valor, prevalece la edición local del cliente que resuelve el conflicto.

## Desarrollo local

Requiere Node.js 22.13 o superior.

```bash
npm install
npm run dev
```

Vinext abre la aplicación normalmente en `http://localhost:3000`. La base D1 local se crea dentro del proyecto mediante Wrangler.

Para ejecutar las pruebas CDP usadas por este repositorio, inicia Lumo en el puerto 4173 y Chrome con depuración remota en el 9223:

```bash
npm run dev -- --host localhost --port 4173
npm run test:browser
```

En Windows, Chrome puede iniciarse para esas pruebas con una carpeta de perfil temporal dentro del repositorio:

```powershell
& "$env:ProgramFiles\Google\Chrome\Application\chrome.exe" --headless=new --remote-debugging-port=9223 --user-data-dir="$PWD\.cdp-test-browser" about:blank
```

## Verificación

```bash
npm run typecheck
npm test
```

`npm test` valida tipos, lint, construye la versión de producción y ejecuta los contratos estáticos. `npm run test:browser` comprueba las APIs, el inicio vacío, el editor gráfico y su rollback, las cuotas atómicas, el VM, los bloques, las extensiones, pantalla completa, sprites, fondos, sonidos WAV, importación/exportación `.sb3`, login, registro y una sesión real de colaboración entre dos pestañas, incluidos conflicto CAS, renombre concurrente, recursos y creación/eliminación ordenada de bloques.

## Cuentas y proyectos

El registro crea un perfil de Lumo asociado a la sesión de ChatGPT. Los proyectos compartidos se persisten en D1 cuando se crea su enlace. Todavía no existe una biblioteca privada de proyectos ni propiedad por cuenta.

## Licencia y créditos

Lumo Studio se distribuye bajo AGPL-3.0-only. Consulta [LICENSE](./LICENSE), [NOTICE.md](./NOTICE.md), [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) y [SECURITY.md](./SECURITY.md). Scratch, Gandi IDE y TurboWarp son proyectos independientes; Lumo Studio no está afiliado, patrocinado ni respaldado por ellos.
