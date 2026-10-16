# Opencode Habitat 🌿
### Framework para trasplantar tu ecosistema opencode a cualquier PC con un comando

`habitat capture` → versiona ecosistema. `habitat restore` → reconstruye hábitat. `habitat verify` → prueba que vive.

![status](https://img.shields.io/badge/status-fase_1_en_curso-yellow) ![target](https://img.shields.io/badge/target-WSL_Ubuntu-blue) ![tech](https://img.shields.io/badge/tech-bash_%2B_git-green)

> Origen real: `~/.config/opencode/`, `~/.claude/skills/`, `~/.agents/skills/`, `~/.gsd/`, `~/.opencode/`, `AGENTS.md`, dotfiles mínimos. Destino: WSL fresh con opencode ya instalado y keys conectadas.

## Por qué existe

Backup manual es tedioso y driftea: `opencode-backup-*.tar.gz`, `gsd-agents-backup-*`, `agents.bak-*` sueltos, `node_modules/` de 100M+ versionado por error, secretos (`jev.env`, `.git-credentials`) a un `git add -A` de filtrarse.

Habitat lo resuelve con 3 ideas:

1. **MANIFEST como única verdad** — cada path declara origen, destino, modo `copy`, excludes, post-steps `npm ci`.
2. **Copias, no symlinks** — determinista en WSL, inmune a `/mnt/c` y watchers.
3. **Seguridad fail-closed** — allowlist + `.gitignore` + scanner + hook pre-commit bloquean secretos antes del primer push.

```mermaid
flowchart LR
    subgraph ORIGEN[PC actual]
        ECO[Ecosistema vivo<br/>~/.config/opencode<br/>skills, agents, MCPs, plugins]
    end
    subgraph HABITAT[code/opencode-habitat]
        MAN[MANIFEST]
        CAP[capture.sh]
        RST[restore.sh]
        VER[verify]
    end
    subgraph DESTINO[PC nueva WSL]
        ECO2[Ecosistema restaurado<br/>+ backup timestamped<br/>+ npm ci]
    end
    ECO -->|capture --dry-run / capture| MAN
    MAN --> CAP --> RST --> VER --> ECO2
```

## 2 flujos

### 1. Capturar / pushear (PC actual)

```bash
./scripts/capture.sh --dry-run   # ver drift repo-vs-máquina, read-only
./scripts/capture.sh             # rsync + denylist al home/ espejo
git status                       # cero secretos, cero junk
git push
```

### 2. Restaurar (PC nueva)

```bash
# prereqs: opencode instalado + autenticado, keys conectadas a mano
git clone <privado-habitat> ~/code/opencode-habitat
cd ~/code/opencode-habitat
./scripts/restore.sh            # backup-before-overwrite + copias + npm ci + verify
```

### 3. (Recomendado) Instalador completo en PC nueva

`restore.sh` reconstruye el payload. `tools/install.mjs` además instala las herramientas
del hábitat y verifica:

```bash
node tools/install.mjs --home "$HOME" --repo "$PWD"           # copia tools/ → ~/bin, crea jev.env, restore + verify
node tools/install.mjs --with-deps                            # + get-shit-done-cc, context-mode, graphifyy
node tools/install.mjs --with-gsd                             # + reinstala GSD y re-aplica los parches (checksum-verificado)
node tools/verify.mjs                                         # VER-01/02 read-only, --json para máquinas
```

Router de dificultad JEV (perfil easy/medium/hard por proyecto):

```bash
gsd-jevs-route "<resumen de 3-6 frases del proyecto>"   # clasifica y aplica el perfil; exit 2 = no toca nada
JEV_PROFILE_SOURCE=manual gsd-route medium              # aplicación manual
gsd-sdk query resolve-model gsd-planner                 # verificación post-router
```

Ver detalle visual: [docs/OVERVIEW.md](docs/OVERVIEW.md)

## Comandos

| Comando | Qué hace | Idempotente |
|---|---|---|
| `habitat capture` (`scripts/capture.sh`) | Snapshot re-ejecutable al `home/` espejo | sí |
| `habitat restore` (`scripts/restore.sh`) | Reconstruye todo, respalda `<file>.backup-<ts>` | sí, 2da corrida = no-op exit 0 |
| `habitat restore --verify` | Restore + verificación al final | sí |
| `habitat verify` (`tools/verify.mjs`) | Read-only: dests existen, `opencode` responde, MCP JSON válido, skills/plugins descubribles, 54 model IDs de los 3 perfiles contra `opencode models` | sí |

## Troubleshooting

- **`verify` falla en `model-ids`**: sin credenciales de opencode, `opencode models` solo
  lista los modelos públicos, así que los IDs de proveedores privados se reportan como
  desconocidos. Autenticá (`opencode auth`) y volvé a correr (`--no-models` para saltear).
- **Drift repo-vs-máquina**: `capture.sh --dry-run` / `restore.sh --dry-run` (read-only,
  exit 1 = acción necesaria). Esta PC de origen queda a propósito detrás del payload hasta
  que se corra el instalador.
- **Colisiones**: todo destino existente se respalda como `<file>.backup-<YYYYMMDD-HHMMSS>`
  antes de escribirse; los huérfanos en destino se preservan.
- **Re-run**: captura, restore y verify son idempotentes; `install.mjs` es idempotente y
  refresca los checksums de los parches que re-aplica.
- **`gsd-jevs-route` sale con código 2**: JEV no dio veredicto automático (sin key,
  timeout, `manual_review`, baja confianza). No se escribió nada: preguntá el perfil y
  aplicalo con `JEV_PROFILE_SOURCE=manual gsd-route <easy|medium|hard>`.
- **Secretos**: nunca se versionan. `install.mjs` crea `.config/opencode/jev.env` desde
  `jev.env.example` (0600) solo si falta, y nunca escribe valores.

## Seguridad

- Cero secretos en git: `jev.env` con valores, `.git-credentials`, `.claude.json` jamás versionados. Solo plantillas `.example`.
- Tres capas: exclusión estructural en MANIFEST → `.gitignore` backstop → scanner `grep -rEn` fail-closed + hook pre-commit.
- `*.local` y untracked machine-local nunca pisados por restore ni commiteados.
- Arranca **privado**. Abrir a público solo tras auditoría Fase 4 + restore test fechado en WSL limpio.

## Layout

```text
code/opencode-habitat/
├── README.md            # este archivo
├── docs/OVERVIEW.md     # arquitectura + flujos con diagramas
├── home/                # espejo de $HOME (solo paths del MANIFEST)
├── scripts/
│   ├── capture.sh       # Fase 2
│   ├── restore.sh       # Fase 3
│   └── verify.sh        # Fase 4
├── .planning/           # GSD: PROJECT, ROADMAP, STATE, phases/
└── .gitignore           # denylist secretos + junk
```

## Roadmap

- [ ] Fase 1: Inventory + Exclusions + Manifest (en curso)
- [ ] Fase 2: Capture Script
- [ ] Fase 3: Restore Script
- [ ] Fase 4: Verify + README + Fresh-WSL Test (release gate)

Ver [.planning/ROADMAP.md](.planning/ROADMAP.md)

## Contribuir / abrir a público

1. Mantener repo privado hasta `verify.sh` verde + test WSL limpio fechado.
2. Escrubear paths absolutos (`$HOME`, `$WINDOWS_USERS_ROOT`) y hostnames.
3. Exportar diagramas archify a `docs/*.html` + PNG para README.
4. Recién entonces hacer público.
