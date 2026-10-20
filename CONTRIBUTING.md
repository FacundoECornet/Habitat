# Cómo contribuir

Gracias por querer mejorar Habitat. Este repo restaura tu entorno de OpenCode, así que la
regla número uno es simple: **nada de tu configuración personal entra al repo**.

## Antes de empezar

- Node.js **22.22.2+**, **24.15+** o **26+**.
- [Git](https://git-scm.com/downloads).
- Para mantener tu propio snapshot: Bash y `rsync` (en Windows, usá WSL).

## Correr los tests

```bash
npm install        # el repo no tiene dependencias de runtime; npm test alcanza
npm test
```

La suite corre en Node puro: `tests/` se ejecuta con `node --test` y no necesita red.
Dos checks necesitan el paquete MCP del payload (`home/.config/opencode`): hasta que corras
`npm ci --prefix home/.config/opencode`, esos tests se **omiten** (skip) en vez de fallar.

```bash
npm ci --prefix home/.config/opencode   # instala el MCP del payload
```

Para verificar una instalación real sin tocar tu home, usá un sandbox:

```bash
node tools/verify.mjs --home /tmp/habitat-sandbox --repo "$PWD" --no-models --no-cli
```

## El hook de secretos

El hook de pre-commit escanea el índice (no el working tree) en busca de credenciales y bloquea
el commit si encuentra una. Se activa por repo:

```bash
git config --local core.hooksPath=.githooks
```

El hook es una **red de seguridad del flujo de trabajo**, no una frontera de seguridad:
`git commit --no-verify` lo salta. Nunca commitees una credencial aunque el hook no la detecte.

## Reglas del repo

- No se commitea configuración personal, credenciales, `node_modules/` ni artefactos
  regenerables.
- El contenido que se versiona está declarado en `MANIFEST.json` (allowlist, no denylist).
- Si editás un archivo de `home/.config/opencode/get-shit-done/`, revisá las anclas
  `<!-- anchor:checksum ... -->`: `tools/install.mjs` las verifica y recalcula el checksum
  si el contenido cambió.
- Los cambios de comportamiento van con un test en `tests/`.
- Actualizá `CHANGELOG.md` en el mismo PR.

## Capturar tu propio entorno

`scripts/capture.sh` relee tu configuración y actualiza el payload versionado. Antes de
correrlo, revisá `MANIFEST.json` y el `.gitignore`:

```bash
scripts/capture.sh --dry-run
```

Ver [`docs/CAPTURE.md`](docs/CAPTURE.md).

## Publicar una version

Las releases se publican con un workflow de **disparo manual** (Actions → *Release* → *Run
workflow* → `version`), nunca solas. El workflow se niega a publicar si algo no cuadra:

- la versión tiene que tener la forma `vX.Y.Z`;
- el tag no puede existir ya (los tags son inmutables: mover uno exige desactivar el ruleset,
  borrarlo y re-tagear);
- el CHANGELOG tiene que tener la sección `## [X.Y.Z] - AAAA-MM-DD` de esa versión;
- la CI de `master` tiene que estar en verde **sobre ese commit**.

Las notas de la release salen de esa misma sección del CHANGELOG. Para preparar una versión:

1. Renombrá la sección de cambios pendientes del CHANGELOG a `## [X.Y.Z] - AAAA-MM-DD`.
2. Esperá a que la CI de `master` termine en verde.
3. Dispará el workflow con esa versión.

## Pull requests

1. Abrí una issue describiendo el problema o la mejora (si es un bug, incluí versión de Node,
   de OpenCode y de sistema operativo).
2. Creá una rama desde `master`.
3. Commiteá en commits atómicos con mensajes descriptivos.
4. Corré `npm test` y `bash scripts/check-path-leaks.sh` antes de abrir el PR.
5. En el PR describí **qué** cambia y **por qué**.

Las issues y los templates están en `.github/ISSUE_TEMPLATE/`.

## Reportar problemas de seguridad

No abras una issue pública: seguí el canal indicado en [`SECURITY.md`](SECURITY.md).
