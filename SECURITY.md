# Seguridad

## Reportar un problema

No publiques tokens de invitación ni datos privados en un issue. Para una vulnerabilidad, usa el canal privado de *Security advisories* del repositorio: <https://github.com/cristianux2025-afk/lumo-studio/security/advisories/new>.

## Controles incluidos

- Los enlaces de invitación usan tokens aleatorios de 128 bits y la API no los devuelve al leer un proyecto.
- Los cuerpos JSON y BLOB se leen con límites de bytes antes de procesarse.
- Los assets son inmutables, se comparan byte a byte al reutilizarlos, tienen cuotas atómicas y referencias verificadas. Se retienen durante la vida del proyecto para eliminar carreras de borrado con snapshots concurrentes y se sirven como descarga con `nosniff`, CSP `sandbox` y CORP same-origin.
- Los snapshots usan comparación de versión; los conflictos devuelven la base remota y el cliente hace rebase de tres vías. Los cursores y versiones estructurales se acotan contra valores válidos del servidor.
- Los eventos validan su forma antes de entrar al registro. El cliente puede recuperar un snapshot y aislar una operación que Blockly no consiga reconstruir.
- La creación anónima y las mutaciones colaborativas se limitan por proyecto y una huella de red fija antes de aplicar la cuota por identidad; rotar un `clientId` no permite saltar el límite ni crear filas sin tope.
- En comentarios y presencia, el nombre de una sesión autenticada se deriva del perfil en el servidor y nunca cae al correo de la cuenta. Los autores anónimos se marcan como invitados.
- La API sólo devuelve el identificador efímero propio; los identificadores de otros colaboradores se sustituyen por alias opacos para evitar que se reutilicen al actualizar presencia.

El token del enlace concede edición completa. No existe todavía revocación, propiedad por cuenta ni permisos de solo lectura.

## Dependencias

`npm audit --omit=dev` mantiene una alerta heredada de `hull.js@0.2.10`, transitiva desde Scratch Renderer ([GHSA-q849-wxrc-vqrp](https://github.com/advisories/GHSA-q849-wxrc-vqrp)). No hay una versión corregida publicada que el árbol de Scratch pueda instalar. Scratch Renderer llama `hull(points, Infinity)` sin el parámetro dinámico `format` asociado a la ruta vulnerable; por eso esa entrada no recibe datos controlados por proyectos en Lumo. La excepción debe revisarse cuando Scratch o `hull.js` publiquen una corrección.

El servidor de desarrollo debe mantenerse en `localhost`; no es un servidor de producción.
