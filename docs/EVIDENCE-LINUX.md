# Evidencia de instalación

Prueba de humo ejecutada sobre un **clone nuevo del repositorio público**, desde un home
vacío y **sin credencial de OpenCode Zen**. Es la evidencia de que el repo publicado instala
y verifica solo.

- **Fecha:** 2026-10-20
- **Origen:** `git clone https://github.com/FacundoECornet/Habitat.git` (commit `ba69038`)
- **Sistema:** Linux (WSL 2, x64)
- **Node.js:** v24.18.0 · **npm:** 11.16.0 · **Git:** 2.53.0
- **Home de prueba:** `/tmp/opencode/fresh-home` (home vacío, sin configuración previa)
- **Credenciales:** ninguna (sin `opencode auth login`)

## 1. Instalación

```bash
git clone https://github.com/FacundoECornet/Habitat.git
cd fresh-clone
HOME=/tmp/opencode/fresh-home node tools/install.mjs --home /tmp/opencode/fresh-home --repo "$PWD"
```

Salida (recortada):

```text
[detect] wsl (x64) — dists WSL detectada
[plugins] context-mode ya resoluble (local o global)
npm ci: installed (home/.config/opencode)
restore: total added=662 changed=0 skipped=0 backups=0
[jev] JEV desactivado (sin credencial OpenCode Zen) en opencode.jsonc
[jev] para activarlo: `opencode auth login` → conectá OpenCode Zen → volvé a correr `node tools/install.mjs`
```

**Exit code: 0.**

Herramientas instaladas en `~/bin`: `gsd-route`, `gsd-jevs-route`, `gsd-model-pick`,
`gsd-graphify-sync`, `gsd-grafiphy`, `habitat-jev-mcp`, `install`, `restore`, `verify`.

## 2. Verificación

```bash
HOME=/tmp/opencode/fresh-home node tools/verify.mjs --home /tmp/opencode/fresh-home --repo "$PWD"
```

```text
ok   manifest-dests: 6 destinos presentes
ok   portable-paths: sin placeholders ni rutas /home/<usuario> ajenas
ok   mcp-json: 1 servidores MCP parseables
skip jev-mcp: sin credencial OpenCode Zen — JEV queda desactivado
ok   cli-tools: responden
ok   plugins: 3 plugins declarados (2 locales, 1 npm)
ok   discovery: opencode/skills=8 opencode/agents=36 .claude/skills=67 .agents/skills=3
ok   archify: CLI listo; doctor OK
skip model-ids: 4/99 ids válidos; 95 sin verificar (catálogo limitado)
verify: all checks passed
```

**Exit code: 0.** Los dos `skip` son esperables sin credenciales: JEV queda desactivado y el
catálogo de modelos no se puede validar sin `opencode auth login`.

## 3. Tests

```bash
npm test
```

```text
ℹ tests 12
ℹ pass 10
ℹ fail 0
ℹ skipped 2
```

Los 2 omitidos son los que necesitan el paquete MCP del payload
(`npm ci --prefix home/.config/opencode`); en CI se instalan y se ejecutan.

## 4. Qué demuestra

- El repo publicado se clona e instala **sin credenciales** y con **exit 0**.
- El motor de restore copia 662 archivos, ejecuta `npm ci` y deja el home verificable.
- JEV es realmente opcional: sin credencial, la entrada `mcp.jev` no queda en la config y el
  check queda en `skip` en vez de romper la instalación.
- La verificación no falla por causas ambientales (sin catálogo de modelos, sin credencial).

## 5. Pendiente

La misma corrida en **Windows nativo (PowerShell)** desde un clone nuevo queda como evidencia
de la variante Windows:

```powershell
git clone https://github.com/FacundoECornet/Habitat.git $HOME\code\habitat
Set-Location $HOME\code\habitat
opencode.cmd auth list
powershell -ExecutionPolicy Bypass -File .\bootstrap.ps1 -WithDeps -WithGsd
node tools/verify.mjs
npm.cmd test
```

Salida fechada + exit codes de ese entorno.
