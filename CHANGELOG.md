# Changelog

Todas las novedades de Habitat se registran acá, siguiendo
[Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y
[Versionado Semántico](https://semver.org/lang/es/).

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

Este repositorio fue **recreado** para eliminar material interno del historial. Los clones
previos ya no son válidos: hay que volver a clonarlo.

```bash
git clone https://github.com/FacundoECornet/Habitat.git ~/code/habitat
```

[0.1.2]: https://github.com/FacundoECornet/Habitat/releases/tag/v0.1.2
[0.1.1]: https://github.com/FacundoECornet/Habitat/releases/tag/v0.1.1
[0.1.0]: https://github.com/FacundoECornet/Habitat/releases/tag/v0.1.0
