# Capturar cambios para Habitat

`scripts/capture.sh` copia configuraciones aprobadas desde `$HOME` al snapshot
`home/`. No hace `git add`, commit ni push. Revisa cada cambio antes de
publicarlo.

## Requisitos

- Bash
- Git
- Node.js
- rsync

En Windows, usa WSL con el repositorio dentro del filesystem Linux (`~/code`),
no bajo `/mnt/c`. En Linux o macOS, usa una terminal Bash. `capture.sh` exige
rsync; el instalador para usuarios no lo necesita. La CI corre la captura en
Linux y en macOS, así que el camino POSIX está probado en las dos.

## Flujo

1. Revisa `MANIFEST.json`: define las raíces permitidas, exclusiones y destinos.
2. Ejecuta `scripts/capture.sh --dry-run` para ver altas, cambios, bajas y bytes
   estimados. Código de salida `1` indica drift; no escribe archivos. El
   veredicto compara **contenido y bit ejecutable**, y los excludes del
   manifiesto se aplican a los dos lados: lo que el manifiesto deja fuera
   (`node_modules/`, `*.bak*`, `*.local`, `*.backup-*`, los backups con
   timestamp del router de GSD) no se cuenta como drift ni se publica.
3. Ejecuta `scripts/capture.sh` para copiar. El script valida el manifiesto,
   preflight de cada origen, excluye datos locales, prepara y escanea el snapshot
   antes de reemplazar `home/`, y vuelve a escanear después.
4. Revisa `git status` y `git diff`. Confirma que cambios pertenecen al snapshot
   previsto y que no incluyen secretos, identidad local ni datos de sesión.
5. Ejecuta `bash scripts/validate-manifest.sh`, los tests y
   `node tools/verify.mjs` antes del commit. Usa `npm test` en Linux/macOS/WSL;
   en PowerShell, usa `npm.cmd test` si ExecutionPolicy bloquea `npm.ps1`.

El escaneo de secretos y rutas es una protección adicional, no una garantía
de que toda credencial posible haya sido detectada. Mantén credenciales fuera del
snapshot y verifica manualmente los cambios capturados.

La captura nunca commitea ni pushea: deja el payload escrito y vos decidís. El
gate de secretos del repo queda activo (lo activa el instalador) y bloquea un
commit que lleve una credencial.
