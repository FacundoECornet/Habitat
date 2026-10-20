# Seguridad

## Reportar una vulnerabilidad

No abras una issue pública ni un PR con el detalle. Usá el canal privado de GitHub:

**Security Advisory** → https://github.com/FacundoECornet/Habitat/security/advisories/new

Incluí: qué se puede hacer, pasos para reproducir, versiones afectadas (Node, OpenCode, OS) y
el impacto que estimás. Te respondo en el plazo de 7 días.

Si no podés usar el canal privado, abrí una issue pública **sin el detalle** ("reporte de
seguridad por canal privado") y te paso un canal alternativo.

## Qué SÍ y qué NO es una credencial en este repo

Este repo contiene un **snapshot declarativo** de una configuración de OpenCode. Para que
funcione, necesita *describir* rutas y herramientas, nunca *contener* secretos.

| Nunca debería estar en el repo | Por qué |
|---|---|
| `~/.local/share/opencode/auth.json` | Credenciales de OpenCode (incluye OpenCode Zen). |
| `OPENCODE_API_KEY`, `JEV_API_KEY`, `TYPESAFE_API_KEY` | Tokens de servicios. |
| `~/.git-credentials`, `~/.netrc`, `~/.ssh/` | Credenciales de git y SSH. |
| `jev.env` | Variables de entorno con claves. |
| `node_modules/` | Dependencias instalables, se regeneran con `npm ci`. |
| Archivos de tu home fuera del `MANIFEST.json` | Config personal que no pertenece al snapshot. |

En el repo solo hay **plantillas** (`*.example`) para lo que necesita un valor real.

## El gate de secretos

`lib/secret-scan.sh` define cinco firmas de credencial y se usa en dos lugares:

- `scripts/capture.sh`, antes de dejar nada en el payload.
- `.githooks/pre-commit`, sobre los blobs del índice.

Los patrones se arman por fragmentos para que el propio detector no se auto-dispare. El hook
reporta **regla, ruta y línea**, nunca el valor detectado.

**Importante:** este gate es una red de seguridad del flujo de trabajo, **no** una frontera de
seguridad. `git commit --no-verify` lo desactiva, y un valor disfrazado puede pasar. La
responsabilidad de no filtrar secretos es de quien commitea.

## Protecciones del lado de GitHub

Además del hook local, el repo tiene esta capa activa en GitHub:

| Protección | Qué hace |
|---|---|
| **Secret scanning** | Analiza cada push contra los patrones de credencial que GitHub conoce y avisa. |
| **Push protection** | Si un patrón conocido llega a un push, el push se rechaza antes de llegar al repo. |
| **Dependabot security updates** | Abre PRs automáticos con las actualizaciones de seguridad de las dependencias declaradas. |
| **Ruleset de ramas** (todas) | Ninguna rama se puede borrar ni reescribir por force-push; la historia es lineal. |
| **Ruleset de tags** | Los tags publicados no se pueden borrar ni reescribir: cada release apunta a un commit inmutable. |
| **Protección de `master`** | Un push a `master` exige que el check `CI` esté verde; no hay force-push ni borrado de rama. |
| **Merges squash + sign-off** | Cada PR entra como un commit, con el mensaje firmado. |
| **CI pineado** | Las actions del workflow están fijadas por SHA y el pipeline corre `npm audit` sobre los dos lockfiles. |
| **Run semanal** | El pipeline también corre por cron: detecta roturas de upstream (una release nueva de GSD, un modelo que sale del catálogo) sin esperar un push. |

Dos cosas que GitHub no habilita en este repo (y no están bajo control del proyecto):
los **patrones de secret scanning propios** (requieren un plan que este repo no tiene; el
archivo `.github/secret-scanning.yml` queda por si se habilita) y la regla de **restringir
rutas de archivo sensibles** en los rulesets.

## Alcance

- Habitat escribe **solo** bajo tu home (`%USERPROFILE%` en Windows) y nunca toca red, proxy,
  firewall ni configuración del sistema.
- El restore hace backup de lo que va a pisar (`~/.habitat/backups/<timestamp>/`) antes de
  escribir.
- Las operaciones de red son las de `npm` y `git` durante la instalación; no se envía tu
  configuración a ningún servicio.
