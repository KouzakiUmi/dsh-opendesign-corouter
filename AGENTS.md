# OpenDesign CoRouter plugin

## Purpose and acceptance

This package connects OpenDesign CoRouter to DSH with separate Design Plan and paid-model providers. Its settings page is an operational configuration surface, not a static catalog.

Required behavior:
- Settings controls show pending values immediately and roll back rejected saves. Serialize configuration writes, track every pending field, and distinguish namespace readiness from transport writability. Load local status independently of quota reads; background quota refresh must not hold a saved control disabled.
- Configuration schemas must survive JSON serialization and fresh-browser rehydration. Transform callbacks must be self-contained; validate the shipped schema in the offline browser fixture as well as the Host. Configuration and Remote field limits must agree.
- Settings prioritize actionable connection status and controls; model parameters and explanatory details are progressively disclosed. Disabled controls explain loading, unavailable, or read-only state. Model capacity edits validate output against the effective context budget before saving.
- Quota displays Design Plan windows, subscription credits, recharge credits, and total balance as distinct amounts. Window resets, subscription period end, and the next local refresh are different timestamps. Missing values remain unknown.
- Desktop authentication is tried first when enabled. A complete saved console session may replace a partial desktop result as one whole snapshot; account data is never combined across identities.
- Independent login uses bounded device authorization. The Host may show the approval page in one short-lived Chrome window it launches itself through `playwright-core`; it never creates, drives or reads the user's own browser profile, and the ordinary official link stays available as the manual path. Only waiting-state public code/link/expiry reach the UI, and the opener reports a fixed code, never a URL or browser handle. Store both issued keys atomically; preserve commit/cancel ordering and read compatibility for legacy Cookie grants.
- Explicit credential references and manually saved API keys outrank device runtime tokens. Device tokens are bound to the prepared request’s official origin, not mutable current configuration. Device quota never uses desktop CLI data; only explicitly personal workspaces may read account billing summaries.
- Each model can be enabled or disabled and given explicit generation defaults. Disabling affects both advertised models and direct invocation. Settings are persisted through the host configuration service.
- Inference supports Chat Completions, Responses, and Messages. Model discovery always uses the OpenAI-compatible `GET /models` endpoint, independently of inference protocol selection.
- The Design Plan empty-turn guard remains a separate setting and does not silently apply to paid models. Model request retries belong to the host retry extension; do not add a second adapter replay loop.
- Manual quota refresh bypasses cached data but shares an in-flight operation. Automatic failed reads back off from 5 to 60 seconds and stop after six consecutive failures; manual refresh or a relevant configuration change starts a new sequence.
- Unreadable image bytes fall back to a named placeholder; cancellation still terminates the request.

## Implementation ownership

- `src/config.ts`: validated, volatile configuration; `src/model-settings.ts`: per-model validation and capacity overrides.
- `src/index.ts`: host service, credential references, quota/model refresh lifetimes, and provider registration.
- `src/remote.ts`: explicit JSON allowlists for the browser interface. Update them whenever a visible field is added.
- `src/quota.ts`, `src/desktop-quota.ts`: quota request/normalization; keep source and unit semantics explicit.
- `src/login.ts`, `src/device-auth.ts`: device authorization lifecycle, strict public-link validation, bounded requests and polling.
- `src/browser-open.ts`: the one temporary activation window. Single instance, bounded launch steps, closed on failure and on plugin disposal. Never touches an existing browser profile.
- `src/model-discovery.ts`: bounded OpenAI model discovery; no inference-protocol branching.
- `src/adapter.ts`, `src/protocols/`: snapshot a call's configuration, translate requests and streams, and enforce model enablement.
- `src/client.ts`: settings interactions and DSH semantic-theme styling. Form values must drive real host behavior.
- `scripts/generate-remote.mjs`: generate the restricted Remote table from annotated host methods. Generated files are rebuilt, not edited by hand.

## Design and maintenance

See [usage](docs/usage.md), [quota evidence](docs/quota-evidence.md), and [UI design](docs/ui-design.md). The dependency and Core compatibility baseline is declared in `package.json`; consult its installed types instead of an unrelated DSH checkout.

Keep API keys and console credentials in the host credential service or environment references. Browser state and ordinary settings contain no credential values. The opened page is untrusted input: the plugin never types into it, clicks in it, or reads from it. All network readers need cancellation, size/time bounds, and safe errors. Model capabilities come from evidence or explicit user overrides, not guesses from vendor names.

Preserve MIT notices in `LICENSE` and `THIRD_PARTY_NOTICES.md`. Source changes do not automatically install, publish, or restart a host.

## Verification

Run the relevant focused tests while developing, then `npm run check` and `npm run test:ui` for changes to these surfaces. The browser fixture is offline and must exercise persistence, model enablement/parameters, protocol selection, quota timing, light/dark themes, and disposal. Loader tests verify the built package and generated Remote registrations. Test assertions must follow the intended behavior above; passing static or mocked checks alone is not evidence of live account integration.
