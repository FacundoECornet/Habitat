#!/usr/bin/env bash
set -euo pipefail

PROFILE="${1:-}"

if [[ "$PROFILE" != "easy" && "$PROFILE" != "medium" && "$PROFILE" != "hard" ]]; then
  echo "Uso: gsd-route {easy|medium|hard}"
  exit 1
fi

PROJECT_ROOT="$(pwd)"
CONFIG="$PROJECT_ROOT/.planning/config.json"
PROFILE_FILE="$HOME/.config/opencode/gsd-router/${PROFILE}.json"
GLOBAL_ROUTER="$HOME/.gsd/router.json"

if [[ ! -f "$CONFIG" ]]; then
  echo "Error: no existe $CONFIG"
  echo "Ejecutá gsd-route desde un proyecto GSD."
  exit 1
fi

# JEv-selected profile may come from env (gsd-jevs-route sets JEV_PROFILE_SOURCE)
JEV_SOURCE="${JEV_PROFILE_SOURCE:-manual}"
JEV_CONF="${JEV_CONFIDENCE:-}"

python3 - "$PROFILE_FILE" "$CONFIG" "$GLOBAL_ROUTER" <<'PY'
import json
import sys
import os
from pathlib import Path

profile_file = Path(sys.argv[1])
config_file = Path(sys.argv[2])
router_file = Path(sys.argv[3])

profile = json.loads(profile_file.read_text())
config = json.loads(config_file.read_text())

config["model_overrides"] = profile["model_overrides"]
# Reproducible: record selected difficulty profile + provenance.
config["difficulty_profile"] = profile["name"]
config["difficulty_source"] = os.environ.get("JEV_PROFILE_SOURCE", "manual")
if os.environ.get("JEV_CONFIDENCE"):
    try:
        config["difficulty_confidence"] = float(os.environ["JEV_CONFIDENCE"])
    except ValueError:
        config["difficulty_confidence"] = os.environ["JEV_CONFIDENCE"]

config_file.write_text(
    json.dumps(config, indent=2) + "\n"
)

# Precedence fix (core.cjs loadConfig merges ~/.gsd/router.json OVER
# project config): sync global router to same profile so project is
# never accidentally overridden. Reversible: router.json has backup.
try:
    router = json.loads(router_file.read_text()) if router_file.exists() else {}
    router["model_overrides"] = profile["model_overrides"]
    router_file.write_text(json.dumps(router, indent=2) + "\n")
except Exception as e:
    print(f"warn: no se pudo sincronizar router global: {e}", file=sys.stderr)

print(f"Ruta GSD activa: {profile['name']}")
for agent, model in profile["model_overrides"].items():
    print(f"  {agent}: {model}")
PY
