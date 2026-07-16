# Lumo Studio

Lumo Studio es un estudio abierto de programación visual para crear historias y juegos en equipo. Combina el editor de bloques y la máquina virtual de Scratch con una capa propia de colaboración mediante enlaces de invitación.

## Funciones actuales

- Editor real basado en `scratch-blocks`.
- Integración inicial con `@scratch/scratch-vm` en modo turbo.
- Proyectos persistentes en Cloudflare D1.
- Invitaciones editables mediante un enlace único.
- Sincronización continua de bloques y personajes entre navegadores.
- Presencia, nombres, cursores y actividad del equipo.
- Comentarios compartidos dentro de cada proyecto.
- Escenario, sprites, ejecución de prueba y diseño adaptable.

## Desarrollo local

Requiere Node.js 22.13 o superior.

```bash
npm install
npm run dev
```

La aplicación se abre normalmente en `http://localhost:3000`. La base D1 local es gestionada por Wrangler dentro del proyecto.

## Validación

```bash
npm run build
npm test
npx tsc --noEmit
```

## Arquitectura colaborativa

El botón **Invitar** crea un proyecto con identificador y token aleatorios. El enlace contiene ambos valores. Los navegadores invitados envían presencia y consultan cambios de forma continua; D1 conserva el estado del editor, los comentarios y la última versión.

Esta primera versión usa sincronización rápida con control de versiones y último cambio válido. Para edición simultánea masiva, la siguiente evolución prevista es un registro de operaciones o CRDT sobre WebSocket.

## Licencia y créditos

Lumo Studio se distribuye bajo AGPL-3.0-only. Consulta [LICENSE](./LICENSE) y [NOTICE.md](./NOTICE.md). Scratch y Gandi son proyectos independientes; Lumo Studio no está afiliado ni respaldado por ellos.
