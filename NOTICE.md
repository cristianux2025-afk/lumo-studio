# Créditos y componentes de terceros

Copyright (C) 2026 Lumo Studio contributors.

Lumo Studio es un proyecto independiente construido sobre software libre de programación creativa.

## Scratch Foundation

| Componente | Versión | Licencia |
| --- | ---: | --- |
| `scratch-blocks` | 2.1.19 | Apache-2.0 |
| `@scratch/scratch-vm` | 14.1.0 | AGPL-3.0-only |
| `@scratch/scratch-render` | 14.1.0 | AGPL-3.0-only |
| `@scratch/scratch-svg-renderer` | 14.1.0 | AGPL-3.0-only |
| `scratch-audio` | 2.0.268 | AGPL-3.0-only |
| `scratch-storage` | 6.2.1 | AGPL-3.0-only |

Los componentes proceden de los repositorios públicos de [Scratch Foundation](https://github.com/scratchfoundation). El puente de menús de `app/connect-scratch-blocks.ts` deriva de la arquitectura de [`scratch-gui/src/lib/blocks.js`](https://github.com/scratchfoundation/scratch-gui/blob/develop/src/lib/blocks.js), distribuida bajo AGPL-3.0-only, y fue adaptado para el workspace independiente de Lumo.

`vendor/start-audio-context/index.cjs` es un reemplazo limpio y compatible de la función de arranque usada por `scratch-audio`: espera un gesto real del usuario en lugar de llamar `AudioContext.resume()` en cada frame.

Scratch, el gato de Scratch y sus marcas pertenecen a Scratch Foundation. Lumo Studio no usa esas marcas como identidad propia.

## Gandi IDE y TurboWarp

[Gandi IDE](https://github.com/Gandi-IDE) y [TurboWarp](https://github.com/TurboWarp) se consultaron como referencias públicas de producto, experiencia de edición y rendimiento. Esta versión no incorpora ni redistribuye código de sus repositorios. Si esto cambia, se documentarán el repositorio, commit, archivos y licencia correspondientes.

Lumo Studio no está afiliado, patrocinado ni respaldado oficialmente por Scratch Foundation, Gandi IDE, Cocrea o TurboWarp.

## Licencias incluidas

- El texto de AGPL-3.0 está en [LICENSE](./LICENSE).
- El texto de Apache-2.0 aplicable a `scratch-blocks` está en [THIRD_PARTY_LICENSES/Apache-2.0.txt](./THIRD_PARTY_LICENSES/Apache-2.0.txt).
- El inventario de dependencias de producción está en [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) y sus textos conservados en [THIRD_PARTY_LICENSES/runtime-packages.txt](./THIRD_PARTY_LICENSES/runtime-packages.txt).
