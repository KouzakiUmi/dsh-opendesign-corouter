# OpenDesign CoRouter plugin

## Purpose and acceptance

This package connects OpenDesign CoRouter to DSH with separate Design Plan and paid-model providers. Its settings page is an operational configuration surface, not a static catalog.

Required behavior:
- Settings controls show pending values immediately and roll back rejected saves. Serialize configuration writes, track every pending field, and distinguish namespace readiness from transport writability. Load local status independently of quota reads; background quota refresh must not hold a saved control disabled.
- Configuration schemas must survive JSON serialization and fresh-browser rehydration. Transform callbacks must be self-contained; validate the shipped schema in the offline browser fixture as well as the Host. Configuration and Remote field limits must agree.
- Settings prioritize actionable connection status and controls; model parameters and explanatory details are progressively disclosed. Disabled controls explain loading, unavailable, or read-only state. Model capacity edits validate output against the effective context budget before saving.
- Quota displays Design Plan windows, subscription credits, recharge credits, and total balance as distinct amounts. Each window is a separate section: remaining percentage and remaining-capacity bar, labelled used/limit/remaining values, then its own recovery row. Window start/reset mode stay in collapsed details; source and update time are separate labelled rows. Avoid concatenated metadata sentences. Window resets, subscription period end, and the next local refresh are different timestamps. Missing values remain unknown.
- Desktop authentication is tried first when enabled. A complete saved console session may replace a partial desktop result as one whole snapshot; account data is never combined across identities.
- Independent login uses bounded device authorization. A login started from settings automatically requests the approval window once after entering the waiting state; failed opens remain visible and can be retried manually without polling reopening windows. The Host may show the approval page in one short-lived Chrome window it launches itself through `playwright-core`; it never creates, drives or reads the user's own browser profile, and the ordinary official link stays available as the manual path. Activation links accept only the official page with a legacy code or the public `deviceId`/`userCode` pair; the Host binds both pair values to the authorization response, rejects extra or duplicate fields, and never exposes the polling secret. Only waiting-state public code/link/expiry reach the UI, and the opener reports a fixed code, never a URL or browser handle. An explicit pending poll with only null or absent token fields remains waiting and does not close the approval window; partial keys, unknown states and failures remain errors. Store both issued keys atomically; preserve commit/cancel ordering and read compatibility for legacy Cookie grants.
- Login/cancel/API-key action responses update the Client immediately and supersede older reads. The approval panel has a clipboard action plus a selectable-link fallback; copy feedback is scoped to its job. Quota cache invalidation produces an unread snapshot, while `need-login` is reserved for an observed missing/expired session.
- `Status.apiKeySource` optionally reports `reference`, `stored`, or `device` without credential values. Settings show the effective source and explain when an ambient reference outranks a newly saved Key. Explicit credential references and manually saved API keys outrank device runtime tokens. Device tokens are bound to the prepared request’s official origin, not mutable current configuration. Device quota never uses desktop CLI data; only explicitly personal workspaces may read account billing summaries.
- Catalog group semantics: official Core / Design Plan means included models; official Plan means paid plan models. Preserve the historical `opendesign-corouter-plan` Provider ID for the included channel and `opendesign-corouter-paid` for the paid channel. The catalog has 38 entries (13 included-channel, 25 paid-channel): the public Core list contains 12, and per-model service preflight also confirmed MiniMax M3.1 Flash coverage in the observed workspace. Treat this as scoped evidence, not a universal entitlement guarantee. See [model evidence](docs/client-evidence.md) and the maintenance procedure below.
- A fetched model catalog is published to the selector as one update; selector notification failure restores the prior catalog and reports that stage separately, allowing a later refresh to recover.
- Each model can be enabled or disabled and given explicit generation defaults. Disabling affects both advertised models and direct invocation. Settings are persisted through the host configuration service.
- Inference supports Chat Completions, Responses, and Messages. Model discovery always uses the configured gateway's OpenAI-compatible `GET /models` endpoint, independently of inference protocol selection. User-facing refresh/source messages say “刷新模型目录” / “当前网关”; protocol compatibility must not imply the models come from OpenAI's own service.
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

## Model catalog maintenance: evidence lookup

1. Check the [official model directory](https://corouter.open-design.ai/models/), [pricing cards](https://corouter.open-design.ai/zh/), and actual model detail pages. Core / Design Plan is the included pool; Plan / 套餐模型 is the paid pool. A missing detail route can return the homepage with HTTP 200: verify the page content, not just status. Keep media-only models out of the chat catalog.
2. For new IDs, query the official OpenAI-compatible `GET https://amr-link.open-design.ai/v1/models` with an authorized runtime/API credential, or use the desktop-bundled CLI below. A listing proves the service advertises an ID, not successful inference or subscription coverage. `metadata.cost` (`low` / `high`) and `capability` are hints, not entitlement or context/output-limit evidence. Do not classify by model size/name alone.
3. Locate the installed Open Design application and its own `resources/open-design/bin/vela.exe` (Windows layout observed in 0.26.1); verify the current executable and `--help` before reuse. Do not assume an unrelated PATH CLI or hard-code a maintainer's installation path. Run only read-only queries using the existing authorized login:

   ```text
   vela model list --all --format json
   vela team-projects list
   vela billing preflight --workspace-id <verified-workspace-id> --model <exact-model-id> --format json
   ```

   Obtain the intended workspace ID from the structured workspace result, keep it local, and use the same workspace for all comparisons. Probe one known Core model as a control, then each candidate. Do not infer a default team workspace from an unscoped catalog. Bound subprocess duration/output; parse locally and output only model IDs and necessary classification fields, not raw account/project data or credentials.
4. Inspect `codingPlan.eligible`, `modelCovered`, and `funding` together. A covered, eligible model reporting `funding: coding_plan` is positive evidence for the included channel in that workspace. `modelCovered: false` with `funding: wallet` supports paid routing there. Wallet funding alone can reflect exhausted/unavailable quota; it does not independently establish that a model is never covered. Missing/failed preflight means unknown. Record observation date and scope, never an account/workspace identifier; preflight is advisory and does not reserve quota or guarantee a run.
5. Check [official OpenDesign source](https://github.com/nexu-io/open-design) when interpreting results. Relevant paths: `apps/daemon/src/runtimes/amr-model-cache.ts` (remote catalog vs preset), `apps/daemon/src/runtimes/models.ts` (model resolution), `apps/web/src/runtime/amr-unlimited-models.ts` (tier labels are not coverage), and `specs/current/coding-plan-client-billing.md` (per-model preflight authority). Resolve the current revision and cite the inspected commit in [model evidence](docs/client-evidence.md). Static presets do not establish current entitlement.
6. Update [catalog](src/catalog.ts), [model evidence](docs/client-evidence.md), and focused catalog/discovery/provider/loader tests together. Keep unverified capability fields absent; do not copy a neighboring model's limits or infer support from a vendor name. Preserve Provider IDs and saved model settings. Run the verification below, including offline UI, and report live catalog/preflight checks separately from inference or installed-host verification.

## Verification

Run the relevant focused tests while developing, then `npm run check` and `npm run test:ui` for changes to these surfaces. The browser fixture is offline and must exercise persistence, model enablement/parameters, protocol selection, quota timing, light/dark themes, and disposal. Loader tests verify the built package and generated Remote registrations. Test assertions must follow the intended behavior above; passing static or mocked checks alone is not evidence of live account integration.
