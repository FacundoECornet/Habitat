# Evidencia de instalación — Windows nativo

Prueba de humo del flujo **Windows puro** (PowerShell + Node + Git, sin WSL) sobre un clone
nuevo del repositorio público, desde un home vacío y **sin credencial de OpenCode Zen**.

- **Fecha:** 2026-10-20
- **Origen:** `git clone https://github.com/FacundoECornet/Habitat.git` (clone nuevo)
- **Sistema:** Windows 11 (build 26300) · **PowerShell:** 5.1.26100.9711
- **Node.js:** v24.13.1 · **npm:** 11.10.1 · **Git:** 2.53.0.windows.1
- **Home de prueba:** `C:\Users\<usuario>\code\habitat-win-home` (home nuevo, fuera del repo)
- **Credenciales:** ninguna (sin `opencode auth login`)

> La corrida usó un home de prueba propio con `-TargetHome` para no tocar el perfil real del
> usuario. El instalador de GSD upstream ignora esa opción y escribe en
> `%USERPROFILE%\.config\opencode`, que en esta máquina estaba vacío.

## 1. Bootstrap completo (con deps y GSD)

```powershell
git clone https://github.com/FacundoECornet/Habitat.git $HOME\code\habitat-win-test
Set-Location $HOME\code\habitat-win-test
powershell -ExecutionPolicy Bypass -File .\bootstrap.ps1 `
  -Repo "$HOME\code\habitat-win-test" `
  -TargetHome "$HOME\code\habitat-win-home" `
  -WithDeps -WithGsd
```

Salida (recortada):

```text
bootstrap: repo C:\Users\<usuario>\code\habitat-win-test - home C:\Users\<usuario>\code\habitat-win-home
bootstrap: node 24.13.1
[detect] windows-native (x64) — sin WSL: usar rutas %USERPROFILE%
[models] sin TTY ni overlay; se mantienen perfiles del repo
[deps] instalando dependencias globales declaradas
[run] npm install -g get-shit-done-cc@1.42.3: ok
[run] graphifyy graphifyy==0.9.14: ok
[gsd] ejecutando instalador GSD (puede tardar)
  Get Shit Done v1.42.3 — Installing for OpenCode to ~\.config\opencode
[bin] 18 herramientas copiadas a C:\Users\<usuario>\code\habitat-win-home\bin
[plugins] context-mode ya resoluble (local o global)
npm ci: up-to-date (home/.config/opencode)
restore: total added=0 changed=1 skipped=661 backups=1
restore: complete
[jev] JEV desactivado (sin credencial OpenCode Zen) en opencode.jsonc
```

**Exit code: 0.**

CLIs resultantes, resolubles desde Windows:

```text
C:\Users\<usuario>\AppData\Roaming\npm\gsd-sdk.cmd
C:\Users\<usuario>\.local\bin\graphify.exe
```

## 2. Verificación

```powershell
node tools\verify.mjs --home C:\Users\<usuario>\code\habitat-win-home --repo .
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
skip model-ids: no se pudo consultar `opencode models` (red/auth)
verify: all checks passed
```

**Exit code: 0.** Los dos `skip` son esperables sin credenciales.

## 3. Tests

```powershell
npm.cmd test
```

```text
ℹ tests 20
ℹ pass 18
ℹ fail 0
ℹ skipped 2
```

Los 2 omitidos son los que necesitan el paquete MCP del payload
(`npm ci --prefix home\.config\opencode`); en CI se instalan y se ejecutan.

## 4. Binarios instalados autocontenidos

```text
C:\Users\<usuario>\code\habitat-win-home\bin\verify.cmd --help   → usage correcto
C:\Users\<usuario>\code\habitat-win-home\bin\restore.cmd --help  → usage correcto
C:\Users\<usuario>\code\habitat-win-home\lib\                    → 6 módulos de soporte
```

## 5. Defectos que esta corrida encontró y ya están corregidos

1. **`verify` reportaba FAIL en vez de "no instalado"** cuando faltaba una CLI opcional: en
   Windows la sonda pasa por `cmd.exe`, así que un binario ausente devolvía exit 1 en lugar
   de ENOENT. Consecuencia: `bootstrap.ps1` fallaba su propia verificación.
2. **Un segundo check (`cli-tools-installed`) volvía a fallar** por la misma condición, así
   que instalar sin `--with-deps` era imposible.
3. **`~/bin/restore` instalado estaba roto**: solo se copiaban tres módulos de `lib/`, y
   `restore.mjs` necesita `lib/manifest.mjs` y `lib/home-placeholder.mjs`
   (`ERR_MODULE_NOT_FOUND`).

Los tres están corregidos y cubiertos con tests (`lib/exec-path.mjs`,
`tests/exec-path.test.mjs`, `tests/cli-tools.test.mjs`, `tests/install-bins.test.mjs`).

## 6. Nota de entorno

- Node 24.13.1 quedó por debajo del mínimo documentado (24.15+) y todo funcionó igual;
  `bootstrap.ps1` ahora compara la versión completa y avisa cuando corresponde.
- El instalador de GSD upstream escribe siempre en `%USERPROFILE%\.config\opencode`; con un
  `-TargetHome` de prueba, el restore va al home de prueba y GSD, al home real.
