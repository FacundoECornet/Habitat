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

| Plataforma | Node | Resultado | Suite |
|---|---|---|---|
| Ubuntu (Linux/WSL) | 22.22.2 · 24 · 26 | 3/3 en verde | 65 tests, 0 fail |
| macOS | 24 | en verde | 65 tests, 0 fail |
| Windows (PowerShell) | 24 | en verde | 65 tests, 47 pass, 18 skip, 0 fail |

Los 18 `skip` en Windows son las suites de la herramienta Bash (`capture.sh` y el scanner de
rutas): necesitan `rsync`, que no existe ahí. La captura en Windows se hace desde WSL.

El job semanal del catálogo de modelos corre una vez por semana sobre el CLI de OpenCode y
abre un issue con la lista exacta de agentes y perfiles afectados cuando un ID público se
retira del catálogo.

## Nota

Los `skip` son esperables sin credenciales. Con `opencode auth login` conectado, el check
`jev-mcp` pasa a ser una comprobación real y `model-ids` valida el catálogo completo.
