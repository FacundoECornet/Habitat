# Evidencia de instalación

Pruebas de humo del repositorio público: **clone nuevo → install → verify → tests**, desde un
home vacío y **sin credencial de OpenCode Zen**.

Sirve para que un usuario no tenga que creer: el repo se clona, instala y verifica solo.

## Linux / WSL

- **Fecha:** 2026-10-20 · **Node:** v24.18.0 · **npm:** 11.16.0 · **Git:** 2.53.0
- **Origen:** clone nuevo de `https://github.com/FacundoECornet/Habitat.git`
- **Home de prueba:** un directorio temporal vacío

```bash
node tools/install.mjs --home <home-de-prueba> --repo .
```

```text
restore: total added=662 changed=0 skipped=0 backups=0
[jev] JEV desactivado (sin credencial OpenCode Zen) en opencode.jsonc
ok   manifest-dests: 6 destinos presentes
ok   portable-paths: sin placeholders ni rutas /home/<usuario> ajenas
ok   mcp-json: 1 servidores MCP parseables
skip jev-mcp: sin credencial OpenCode Zen — JEV queda desactivado
ok   cli-tools: responden
ok   plugins: 3 plugins declarados (2 locales, 1 npm)
ok   discovery: opencode/skills=8 opencode/agents=36 .claude/skills=67 .agents/skills=3
ok   archify: CLI listo; doctor OK
skip model-ids: catálogo limitado (sin `opencode auth login`)
verify: all checks passed
```

**Exit 0.** `npm test`: 10 pass, 2 skip, 0 fail (los 2 skip necesitan
`npm ci --prefix home/.config/opencode`).

## Windows nativo (PowerShell, sin WSL)

- **Fecha:** 2026-10-20 · **Windows 11** (build 26300) · **PowerShell** 5.1 · **Node** v24.13.1
- **npm** 11.10.1 · **Git** 2.53.0.windows.1 · **Home de prueba:** `C:\Users\<usuario>\code\habitat-win-home`

```powershell
powershell -ExecutionPolicy Bypass -File .\bootstrap.ps1 -WithDeps -WithGsd
```

```text
[deps] npm install -g get-shit-done-cc@1.42.3: ok
[deps] graphifyy graphifyy==0.9.14: ok
[gsd] instalador GSD: 67 comandos, agentes y hooks
[bin] herramientas copiadas a C:\Users\<usuario>\code\habitat-win-home\bin
[path] C:\Users\<usuario>\code\habitat-win-home\bin agregado al PATH de usuario
npm ci: up-to-date (home/.config/opencode)
restore: total added=662 changed=0 skipped=0 backups=0
[jev] JEV desactivado (sin credencial OpenCode Zen) en opencode.jsonc
ok   manifest-dests: 4 destinos presentes
ok   portable-paths: sin placeholders ni rutas /home/<usuario> ajenas
ok   mcp-json: 1 servidores MCP parseables
skip jev-mcp: sin credencial OpenCode Zen — JEV queda desactivado
ok   cli-tools: responden
ok   plugins: 3 plugins declarados (2 locales, 1 npm)
ok   discovery: opencode/skills=8 opencode/agents=66 .claude/skills=67 .agents/skills=3
ok   archify: CLI listo; doctor OK
skip model-ids: no se pudo consultar `opencode models` (red/auth)
verify: all checks passed
```

**Exit 0.** `npm.cmd test`: 18 pass, 2 skip, 0 fail.

## Qué demuestra

- El repo publicado se clona e instala **sin credenciales** y con **exit 0** en las dos
  plataformas.
- El restore copia el payload, ejecuta `npm ci` y deja el home verificable.
- **JEV es opcional de verdad**: sin credencial, la entrada `mcp.jev` no queda en la config y
  el check queda en `skip` en vez de romper la instalación.
- La verificación no falla por causas del entorno (sin catálogo de modelos, sin credencial).
- Los binarios instalados en `~/bin` son autocontenidos: funcionan sin el repo.

## CI: las tres plataformas

Desde `v0.2.0` la CI corre en las tres plataformas, con los tests, los gates del repo
(manifiesto, scan de rutas, symlinks, sintaxis del hook) y un smoke de `install` + `verify`
sobre un home temporal **fuera** del repositorio.

- **Fecha:** 2026-10-20 · **Commit:** `v0.2.0` · **Workflow:** `ci.yml`

| Plataforma | Runner | Node | Resultado | Suite |
|---|---|---|---|---|
| Ubuntu (Linux/WSL) | `ubuntu-latest` | 22.22.2 · 24 · 26 | 3/3 en verde | 72 tests, 0 fail |
| macOS | `macos-26-arm64` | 24 | en verde | 72 tests, 0 fail, 0 skip |
| Windows (PowerShell) | `windows-latest` | 24 | en verde | 72 tests, 47 pass, 18 skip, 0 fail |

Los 18 `skip` en Windows son las suites de la herramienta Bash (`capture.sh` y el scanner de
rutas): necesitan `rsync`, que no existe ahí. La captura en Windows se hace desde WSL.

En la rama `feat/opencode-2x` (la que trae la línea 2.x) la suite subió a **107 tests**:
Linux y macOS con 107/107 en verde, y Windows con 86 pass + 21 skip (los mismos de `rsync`,
más las suites que no corren ahí), 0 fail.

### macOS, en detalle

El job de macOS corre sobre un **macOS real de Apple Silicon** (`macos-26-arm64`), no sobre
un emulador, así que el tooling Bash se prueba con las herramientas BSD de verdad (`rsync`
2.6.9, `stat`, `sort`, `find` de BSD). Eso es lo que destapó los problemas de portabilidad que
se corrigieron en `v0.2.0`.

```text
restore: restoring into /Users/runner/work/_temp/habitat-home
restore: total added=660 changed=0 skipped=0 backups=0
restore: complete
ok   manifest-dests: 4 destinos presentes
ok   portable-paths: sin placeholders ni rutas /home/<usuario> ajenas
ok   mcp-json: 1 servidores MCP parseables
skip jev-mcp: sin credencial OpenCode Zen — JEV queda desactivado
ok   cli-tools: ok, pero no instaladas: gsd-sdk, graphify
ok   plugins: 3 plugins declarados (2 locales, 1 npm)
ok   discovery: opencode/skills=8 opencode/agents=36 .claude/skills=67 .agents/skills=3
ok   archify: CLI listo; doctor OK
skip model-ids: no se pudo consultar `opencode models` (red/auth)
verify: all checks passed
```

**Exit 0**, con los 72 tests en verde (incluidos los de `capture.sh` y los del scanner de
rutas, que en macOS son los que exigen `rsync`).

**Lo que esto no cubre:** la corrida de macOS es automática, con un home temporal y sin
credenciales. Nadie hizo a mano la instalación de Habitat en una Mac propia: la evidencia
humana de arriba es de Linux/WSL y de Windows nativo. Para macOS, la prueba es la de la CI.

El job semanal del catálogo de modelos corre una vez por semana sobre el CLI de OpenCode y
abre un issue con la lista exacta de agentes y perfiles afectados cuando un ID público se
retira del catálogo.

## CI: las dos líneas de OpenCode

OpenCode 2.x no comparte el contrato de plugins con 1.x, así que la CI corre el payload
contra **las dos líneas**. El job instala el CLI, restaura el payload en un home temporal y
comprueba que context-mode quede disponible por la vía que corresponde a esa línea.

- **Fecha:** 2026-10-21 · **Commit:** `0bd9f5c` (`feat/opencode-2x`) · **Workflow:** `ci.yml`

| Línea | Instalación | Qué prueba | Resultado |
|---|---|---|---|
| 1.19.3 | npm | El plugin nativo carga y expone las 11 herramientas `ctx_*` | en verde |
| 2.1.0 | Homebrew (binario `v2.0.25`) | El plugin nativo queda fuera y el servidor MCP de context-mode levanta y conecta | en verde |

Salida del job de la línea 2.x:

```text
OpenCode: opencode v2.0.25
ok: el servidor MCP quedó declarado y el plugin nativo fuera
✓ context-mode  connected
ok: el servidor MCP de context-mode está conectado
```

**Lo que esto no cubre:** en la línea 2.x la prueba es que el servidor MCP levanta y conecta,
no que una sesión real use las herramientas: eso necesita credencial y sesión, y no corresponde
a una corrida pública. Los hooks de routing de context-mode siguen fuera en 2.x hasta que
upstream publique su entrada 2.x.

## Nota

Los `skip` son esperables sin credenciales. Con `opencode auth login` conectado, el check
`jev-mcp` pasa a ser una comprobación real y `model-ids` valida el catálogo completo.
