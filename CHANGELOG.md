# Changelog

Todas las novedades de Habitat se registran acá, siguiendo
[Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y
[Versionado Semántico](https://semver.org/lang/es/).

## [Unreleased]

### Agregado

- **El instalador activa el gate de secretos** en el repo desde el que se instala
  (`core.hooksPath=.githooks`): hasta ahora habia que activarlo a mano en cada clon. Es
  configuracion local del repo (la global de Git no se toca) y un `core.hooksPath` propio del
  usuario no se pisa.

### Documentacion

- Toda la documentacion esta al dia con el estado actual: los nueve checks de `verify`, la
  regla del catalogo completo, las tres plataformas en CI, el veredicto de drift de la captura,
  el alcance del gate de secretos, el secreto del job de catalogo y la auditoria de exposicion
  (0 coincidencias de claves, rutas personales o identidades en todo lo publicado).

## [0.2.1] - 2026-10-20

### Agregado

- **Workflow de release con disparo manual** (Actions → *Release* → *Run workflow*): publica
  una versión verificando antes que la versión tenga la forma correcta, que el tag no exista
  ya (los tags son inmutables), que el CHANGELOG tenga la sección de esa versión y que la CI
  de `master` esté en verde sobre ese commit. Las notas salen del CHANGELOG. Nunca se
  publica solo.

### Corregido

- El check `cli-tools` decía "responden (no instalados: gsd-sdk, graphify)", que se
  contradecía: ahora dice "ok, pero no instaladas: ...".
- Los workflows de Actions quedan pineados a LF: sin eso, un checkout en Windows los deja
  con CRLF y el test que verifica sus garantías falla.

### Documentación

- La evidencia de macOS ahora detalla qué corre la CI (un macOS real de Apple Silicon, con
  las herramientas BSD de verdad) y, con honestidad, qué no cubre: la corrida es automática,
  con home temporal y sin credenciales; la evidencia humana sigue siendo de Linux/WSL y
  Windows nativo.
- `CONTRIBUTING.md` documenta cómo publicar una versión.

## [0.2.0] - 2026-10-20

Cierre de la etapa 1: el motor y la captura quedan cubiertos por pruebas, las tres plataformas
de CI quedan probadas de verdad y se arregla un fallo que rompía la instalación de todos los
usuarios sin credencial de OpenCode Zen.

### Corregido

- **La instalación fallaba para quien no tiene credencial de OpenCode Zen.** El check
  `model-ids` daba por completo un catálogo con 20 o más modelos, y el catálogo público ya
  tiene 45: sin credencial, los IDs `opencode-go/*` se marcaban como inválidos y la
  verificación (y con ella la instalación) salía en rojo. Ahora el catálogo solo se considera
  completo cuando trae el namespace autenticado, que solo existe con credencial; sin ella, la
  lista es un subconjunto que todavía anuncia modelos que OpenCode ya retiró, así que un ID
  ausente no prueba nada y el check queda como no verificado.
- **La home ajena no se detectaba en su forma de Windows.** El check `portable-paths` solo
  buscaba `/home/<login>`, así que en Windows no veía una home de otra máquina. Ahora
  detecta las tres formas que el payload puede traer: POSIX, Windows nativo (`C:/Users/...`)
  y el montaje de WSL (el prefijo `/mnt/<drive>/Users/...`). Un placeholder documentado
  (`C:/Users/...`) no se confunde con una home real.
- **El tooling Bash no funcionaba en macOS.** `declare -A` (bash 4) en el scanner de rutas,
  `stat -c` (GNU) y `sort -z` (GNU) en el resto del tooling: con el bash 3.2 y las
  herramientas BSD de macOS, el scanner no arrancaba y el dry-run de la captura fallaba. Ahora
  la deduplicación no usa arrays asociativos, el tamaño de archivo se toma con `wc -c` y la
  deduplicación NUL-safe la hace Node, con el mismo resultado byte a byte.
- **El preview de la captura daba "drift" siempre en macOS.** El veredicto se leía del
  listado de rsync, y el rsync de macOS (2.6.9) itemiza una diferencia de mtime sobre un
  árbol convergente. Ahora el veredicto lo decide la accounting del propio motor (checksum de
  contenido más bit ejecutable) y el listado de rsync queda solo para mostrar.
- **La captura contaba como drift lo que el manifiesto excluye.** Los excludes se aplicaban
  solo al origen, así que el `node_modules/` de un checkout de desarrollo se reportaba como
  6967 archivos a borrar, cuando no es payload y la captura no lo publicaría. Ahora se
  aplican a los dos lados del comparativo.
- **Los backups del router de GSD se publicaban.** La raíz de GSD guarda copias con
  timestamp (`backup-<sello>/`) que no son payload; ahora quedan excluidas, igual que ya
  pasaban en `.config/opencode`.

### Agregado

- **Suite de pruebas del motor de restore** (13 casos): no tenía ninguna. Cubre el backup con
  timestamp antes de sobrescribir, los excludes, la idempotencia, que los archivos `*.local`
  no se pisen, que el dry-run no escriba nada, el preflight fail-closed, la expansión del
  placeholder del home, la conservación de huérfanos, el gate de post-steps, el log de la
  corrida y que los symlinks del payload no se sigan.
- **Suite de pruebas de `capture.sh`** (9 casos): la otra mitad del producto, tampoco tenía
  ninguna. Cubre que el dry-run no escriba, que la copia sea exactamente la del manifiesto,
  el rechazo fail-closed por origen ausente o ilegible, la idempotencia, el bloqueo de la
  promoción ante un secreto y ante una ruta de máquina, y que la captura no stagee ni
  commitee.
- **Suite de pruebas del scanner de rutas** (8 casos) y **del check de IDs de modelo**
  (7 casos), con el CLI de OpenCode sustituido por un stub.
- **Suite del contrato del manifiesto** (4 casos) que mantiene los dos validadores en sync:
  hasta ahora el de Bash exigía `*.backup-*` y el de Node no, así que un manifiesto podía ser
  válido para el restore y no para la captura.
- **`tools/check-model-ids.mjs`**: contrasta los IDs del payload (perfiles de GSD, configuración
  y definiciones de agente) contra el catálogo. Con catálogo completo y un ID público
  retirado sale con código 1 y lista dónde aparece cada ID; con el catálogo truncado o sin
  red sale con 0: nunca un rojo falso.
- **CI en Windows y macOS.** Los dos jobs instalan dependencias, corren los tests y los
  gates, y hacen un smoke de install + verify sobre un home temporal fuera del repositorio.
  macOS deja de ser una promesa del README: el tooling Bash se prueba con las herramientas
  BSD de verdad.
- **Job semanal del catálogo de modelos**: revisa el catálogo una vez por semana y abre (o
  actualiza) un issue con la lista exacta de agentes y perfiles afectados. Necesita el secreto
  `OPENCODE_AUTH` del repositorio para ver el catálogo completo.

## [0.1.6] - 2026-10-20

### Cambiado

- Se eliminó el aviso de "hay que re-clonar": el repositorio se publica por primera vez, así
  que no hay clones previos que migrar.

## [0.1.5] - 2026-10-20

### Cambiado

- **Los recibos de evidencia se consolidan en un solo documento** (`docs/EVIDENCE.md`): una
  corrida por plataforma — Linux/WSL y Windows nativo — con comandos, salidas y códigos de
  salida. Los dos archivos por plataforma se eliminaron.

## [0.1.4] - 2026-10-20

### Cambiado

- **El payload ya no incluye `home/AGENTS.md` ni `home/.bashrc`.** Un snapshot del shell y de
  las convenciones del hogar es personal y está atado a una máquina. El manifiesto queda con
  cuatro roots y los dos validadores se ajustan en el mismo cambio.
- **El instalador pone `~/bin` en el PATH** (bloque guardado en `~/.bashrc` en POSIX, PATH de
  usuario en Windows), que es lo único que aportaba el `.bashrc` del payload. Es idempotente.

### Corregido

- **`portable-paths` ya no falla por copias del vendor.** El instalador de GSD guarda una copia
  prístina de los archivos de upstream, y esos archivos traen rutas de ejemplo de su autor.
  No son payload de Habitat: el check las ignora y el manifiesto las excluye del snapshot.

## [0.1.3] - 2026-10-20

### Corregido

- **Modelos descontinuados en el payload.** El repo declaraba dos IDs que OpenCode ya no
  sirve: `opencode/space-bunny-free` (cuatro agentes en los tres perfiles) y
  `opencode/muse-spark-1.3-contributor-free` (doce definiciones de agente y el router de GSD).
  Con credenciales, `verify` fallaba el check `model-ids` y la instalación salía con error:
  le pasaba a **todo** usuario nuevo.
- **Comentarios y mensajes sin IDs internos de planificación.**

### Agregado

- Reelegir modelos por agente con `gsd-model-pick` (interactivo, por rol, o por perfil y
  agente puntual).

## [0.1.2] - 2026-10-20

Correcciones encontradas al probar el flujo **Windows nativo** (PowerShell + Node + Git) sobre
un clone nuevo del repo público.

### Corregido

- **`verify`aba una CLI opcional ausente.** En Windows la sonda de CLIs pasa por `cmd.exe`, así
  que un binario no instalado devolvía exit 1 en lugar de ENOENT: `gsd-sdk` o `graphify`
  ausentes se reportaban como ROTOS y `bootstrap.ps1` fallaba su propia verificación. Ahora
  se resuelven en PATH (`lib/exec-path.mjs`) y "no instalado" se informa en verde, con el
  hint de `install.mjs --with-deps`.
- **El check `cli-tools-installed` eliminaba.** Repetía la misma condición como falla, así que
  instalar sin `--with-deps` era imposible. Ahora hay un único check, en verde, con la lista
  de CLIs ausentes.
- **`~/bin/restore` instalado estaba roto.** Solo se copiaban tres módulos de `lib/`; ahora
  viaja **todo** `lib/` junto a los binarios, así que ningún comando instalado muere con
  `ERR_MODULE_NOT_FOUND`.
- **`bootstrap.ps1` compara la versión de Node completa** (22.22.2+, 24.15+ o 26+) y avisa
  cuando el minor queda por debajo del mínimo documentado.

### Agregado

- Evidencia fechada del flujo Windows nativo completo (hoy en `docs/EVIDENCE.md`)
  (`bootstrap.ps1 -WithDeps -WithGsd`, verify, `npm.cmd test`) sobre un clone nuevo.
- Tests nuevos: resolución de ejecutables por plataforma, check `cli-tools` sin CLIs opcionales
  y binarios instalados autocontenidos.

## [0.1.1] - 2026-10-20

Ajustes sobre la publicación inicial.

### Cambiado

- Skill **Archify actualizado a v3.2.0** en el payload; los dos diagramas se regeneraron con
  esa versión y ahora tienen la interfaz en español.
- `docs/jev-profiles.html`: el flujo de selección de perfil por dificultad pasa a estar
  publicado (antes era un artefacto local).
- Dependabot: se declara la dependencia del payload en el lockfile raíz para que GitHub
  pueda armar el grafo de dependencias; vulnerability alerts y actualizaciones de seguridad
  quedan activos.

### Corregido

- `npm test` fallaba en un clone recién clonado porque el paquete MCP vive en el lockfile del
  payload. Ahora esos dos tests se **omiten** (skip) con un hint accionable y vuelven a
  ejecutarse cuando la dependencia está instalada.

### Agregado

- Evidencia fechada de una instalación real sobre un clone nuevo (hoy en `docs/EVIDENCE.md`)
  del repo público, desde un home vacío y sin credencial de OpenCode Zen (install exit 0,
  verify con todos los checks en verde o `skip`, `npm test` verde).

## [0.1.0] - 2026-10-20

Primer lanzamiento público de Habitat.

### Agregado

- Restore multiplataforma en Node (`tools/restore.mjs`): backup con timestamp, copia del
  payload, `npm ci` como post-step y ejecución idempotente.
- Verificación en seis checks (`tools/verify.mjs`), cada uno con hint accionable y soporte de
  `skip` cuando no se puede evaluar en la máquina.
- Captura declarativa (`scripts/capture.sh`) con `--dry-run`, lectura del manifiesto y barrido
  de secretos.
- JEV como **opt-in**: sin credencial de OpenCode Zen la instalación termina igual, el MCP
  `jev` no se registra en la config y el check queda en `skip`.
- Documentación pública en español: `README.md`, `docs/ARCHITECTURE.md`, `docs/CAPTURE.md` y
  un diagrama interactivo de arquitectura (`docs/architecture.html`).
- CI en GitHub Actions con Node 22, 24 y 26.

### Aviso importante

El repositorio se publicó **reconstruido desde cero**, con el historial revisado y sin material
interno.

```bash
git clone https://github.com/FacundoECornet/Habitat.git ~/code/habitat
```

[0.2.1]: https://github.com/FacundoECornet/Habitat/releases/tag/v0.2.1
[0.2.0]: https://github.com/FacundoECornet/Habitat/releases/tag/v0.2.0
[0.1.6]: https://github.com/FacundoECornet/Habitat/releases/tag/v0.1.6
[0.1.5]: https://github.com/FacundoECornet/Habitat/releases/tag/v0.1.5
[0.1.4]: https://github.com/FacundoECornet/Habitat/releases/tag/v0.1.4
[0.1.3]: https://github.com/FacundoECornet/Habitat/releases/tag/v0.1.3
[0.1.2]: https://github.com/FacundoECornet/Habitat/releases/tag/v0.1.2
[0.1.1]: https://github.com/FacundoECornet/Habitat/releases/tag/v0.1.1
[0.1.0]: https://github.com/FacundoECornet/Habitat/releases/tag/v0.1.0
