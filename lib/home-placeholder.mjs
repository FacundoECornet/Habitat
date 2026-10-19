// lib/home-placeholder.mjs — portable home-path tokens for the managed payload.
//
// The GSD command, agent, workflow and reference files carry absolute `@` and
// shell references to the install root. Storing a real home path in the
// repository would leak one user's account name and break every other machine.
// The payload therefore stores the token PLACEHOLDER instead; tools/restore.mjs
// expands it to the target HOME while copying, and tools/install.mjs does the
// same for anchored blocks it patches in place.
//
// Anchor checksums are computed over the canonical (placeholder) form so that
// a repo block and the same block after expansion on a machine verify equal.

export const PLACEHOLDER = "__HABITAT_HOME__";

// Forward-slash spelling of the home directory (`C:\Users\x` -> `C:/Users/x`).
// Node and opencode accept it on every platform, and it avoids backslash
// escaping inside markdown `@` references.
export function forwardHome(home) {
  return String(home).replace(/\\/g, "/");
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Replace every placeholder token with the concrete home directory.
export function expandHome(text, home) {
  return text.split(PLACEHOLDER).join(forwardHome(home));
}

// Replace the concrete home directory (either slash spelling, any case) with the
// placeholder token. Inverse of expandHome for checksum canonicalization.
export function canonicalHome(text, home) {
  const forms = [...new Set([String(home), forwardHome(home)])]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  let out = text;
  for (const form of forms) {
    out = out.replace(new RegExp(escapeRegExp(form), "gi"), PLACEHOLDER);
  }
  return out;
}

// Byte-level variant used by restore: returns a Buffer whose placeholder tokens
// are expanded. Files without the token are returned unchanged (no re-encode).
export function materialize(buffer, home) {
  if (buffer.indexOf(PLACEHOLDER) === -1) return buffer;
  return Buffer.from(expandHome(buffer.toString("utf8"), home), "utf8");
}
