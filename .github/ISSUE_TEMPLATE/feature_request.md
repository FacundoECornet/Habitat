---
name: Proponer una funcionalidad
about: Una idea o mejora para Habitat
title: "[feat] "
labels: [enhancement]
body:
  - type: textarea
    id: problem
    attributes:
      label: Problema
      description: Qué querés resolver y por qué el flujo actual no alcanza.
    validations:
      required: true

  - type: textarea
    id: proposal
    attributes:
      label: Propuesta
      description: Cómo lo resolverías. Si ya existe una alternativa, mencionala.
    validations:
      required: true

  - type: textarea
    id: alternatives
    attributes:
      label: Alternativas consideradas
    validations:
      required: false

  - type: checkboxes
    id: scope
    attributes:
      label: Alcance
      options:
        - label: "No toca el `MANIFEST.json`"
        - label: "No introduce credenciales ni configuración personal"
        - label: "Incluye tests en `tests/`"
        - label: "Actualiza `CHANGELOG.md`"
