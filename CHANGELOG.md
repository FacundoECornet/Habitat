# Changelog

Todas las novedades de Habitat se registran acá, siguiendo
[Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y
[Versionado Semántico](https://semver.org/lang/es/).

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

- `docs/EVIDENCE-LINUX.md`: evidencia fechada de una instalación real sobre un clone nuevo
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

[0.1.1]: https://github.com/FacundoECornet/Habitat/releases/tag/v0.1.1
[0.1.0]: https://github.com/FacundoECornet/Habitat/releases/tag/v0.1.0
