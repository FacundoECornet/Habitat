# Model Profile Resolution

Resolve the model profile once at the start of orchestration, then use it for all Task spawns.

There is one source of truth for which models a session uses: the **difficulty profile**
(`easy` | `medium` | `hard`) recorded in `.planning/config.json` by the JEV router.
Model aliases (`sonnet`, `haiku`, `opus`) and `model_profile: balanced|adaptive|inherit`
from older GSD versions are **not** used by this install: every routed agent gets a
concrete `provider/model-id` from the profile file.

## Resolution order (deterministic)

1. `.planning/config.json` → `difficulty_profile` (`easy` | `medium` | `hard`).
2. `.planning/config.json` → `model_overrides[<agent>]` — written by the router, wins.
3. `~/.config/opencode/opencode.jsonc` → `agent.<name>.model` — static default for
   agents that no profile routes.
4. Missing everywhere → the agent inherits the session model.

To (re)apply a profile explicitly:

```bash
JEV_PROFILE_SOURCE=manual gsd-route <easy|medium|hard>
```

To let JEV classify the project and apply the profile automatically:

```bash
gsd-jevs-route "<resumen del proyecto>"
```

See `get-shit-done/workflows/new-project.md` §5.5 for the full contract: JEV decides,
`tools/route.mjs` writes, low confidence never changes anything.

## Profile files

| File | Contents |
|------|----------|
| `~/.config/opencode/gsd-router/easy.json` | `model_overrides` for low-risk work |
| `~/.config/opencode/gsd-router/medium.json` | `model_overrides` for bounded features |
| `~/.config/opencode/gsd-router/hard.json` | `model_overrides` for architecture work |
| `~/.config/opencode/gsd-router/jev-catalog.json` | closed class catalog + thresholds |
| `~/.config/opencode/gsd-router/jev.json` | JEV provider order (zen_free → typesafe → user) |

## Lookup for a Task spawn

Read `model_overrides` from `.planning/config.json` and pass the model per agent:

```
Task(
  prompt="...",
  subagent_type="gsd-planner",
  model="{model_overrides[\"gsd-planner\"]}"   # e.g. "opencode-go/gpt-6-luna"
)
```

If the agent is absent from `model_overrides`, use the `agent.<name>.model` default in
`opencode.jsonc`. Never invent a model id: an id that `opencode models` does not list
fails at spawn time (`tools/verify.mjs` validates every id in the three profiles).

## Global router (`~/.gsd/router.json`)

`core.cjs` `loadConfig` merges `~/.gsd/router.json` **over** the project config, so the
global router must never disagree with the project. `tools/route.mjs` syncs it only when
the project does not declare `difficulty_profile`; a project that declares its own
profile is left authoritative and the global router is not touched.

## References

- `tools/gsd-jevs-route.mjs` — JEV classification + provider fallback (exit 2 = no change)
- `tools/route.mjs` — atomic config writer
- `tests/router-flow.mjs` — mocked end-to-end flow
