---
name: Reportar un bug
about: Algo no funciona como debería
title: "[bug] "
labels: [bug]
body:
  - type: markdown
    attributes:
      value: |
        Gracias por reportarlo. Cuanta más info, más rápido lo reproducimos.

  - type: textarea
    id: what-happened
    attributes:
      label: Qué pasó
      description: Qué esperabas y qué obtuviste.
    validations:
      required: true

  - type: textarea
    id: reproduce
    attributes:
      label: Pasos para reproducir
      description: Comandos exactos, en orden.
    validations:
      required: true

  - type: textarea
    id: logs
    attributes:
      label: Salida
      description: Salida de consola relevante (sin credenciales).
    render: shell

  - type: input
    id: node
    attributes:
      label: Versión de Node
      placeholder: "22.22.2"
    validations:
      required: true

  - type: input
    id: opencode
    attributes:
      label: Versión de OpenCode
      placeholder: "1.2.3"
    validations:
      required: true

  - type: dropdown
    id: os
    attributes:
      label: Sistema operativo
      options:
        - Windows
        - Linux
        - macOS
        - WSL 2
    validations:
      required: true

  - type: input
    id: habitat
    attributes:
      label: Versión de Habitat
      description: Commit o etiqueta desde la que instalaste.
      placeholder: "v0.1.0"
