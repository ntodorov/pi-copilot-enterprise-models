# pi-copilot-enterprise-models

Discover enterprise-allowed GitHub Copilot models in [Pi](https://pi.dev), including models missing from Pi's bundled catalog.

This extension fetches your credential-specific `/models` catalog and exposes picker-enabled models compatible with Pi's coding workflow. Explicit disabled, unconfigured, or unrecognized policy states are excluded. An omitted policy state is accepted only when the model is picker-enabled. It does not enable models or change enterprise policies.

## Requirements

- Pi 1.3.0 or later with the native `github-copilot` provider. Tested against 1.3.0.
- Node.js 22.19 or later.
- A GitHub Copilot subscription, organization permission to use it with your client, and a Pi Copilot OAuth login.

The extension works with the account signed into **Pi**, not whichever account is active in `gh` or npm. Enterprise plans hosted on github.com normally use the ordinary github.com login. Only enter an enterprise domain when your GitHub deployment requires it.

## Install

Until the first release is published, use a local checkout:

```sh
npm ci --ignore-scripts
pi -e ./src/index.ts
```

After publication, install the same tagged version on each machine:

```sh
pi install npm:@niktv/pi-copilot-enterprise-models@0.1.0
```

Or install from a GitHub release tag after it exists:

```sh
pi install git:github.com/ntodorov/pi-copilot-enterprise-models@v0.1.0
```

Authenticate separately on each machine. Do not sync `auth.json` through this repository.

## Use

1. Start Pi with the extension loaded.
2. Run `/login github-copilot` if not already signed in.
3. Run `/copilot-enterprise-refresh` after login or an account change.
4. Use `/model` to select a discovered model.

Pi 1.3.0 refreshes catalogs in the background after interactive startup, after login, and in RPC mode. The extension does not block session startup. A refresh is skipped for 60 seconds after success unless forced by `/copilot-enterprise-refresh`.

Pi chooses the startup model before network discovery. A matching local catalog cache restores previously discovered models for saved defaults, resumed sessions, `--model`, and `--list-models`. On a first install, Pi's bundled models and native account-availability filter remain available until live discovery succeeds. New models become selectable after that first refresh. Print mode and `--list-models` do not initiate discovery in Pi 1.3.0, so use an interactive refresh once before selecting a new model from those modes.

Dynamic discovery requires Pi OAuth. Users of `COPILOT_GITHUB_TOKEN` or stored API-key credentials get Pi's bundled catalog and native account filter without dynamic discovery. This extension replaces Pi's pi.dev catalog overlay, so these fallback models and known-model metadata do not receive pi.dev updates until Pi itself is updated.

| Command | Purpose |
| --- | --- |
| `/copilot-enterprise-refresh` | Fetch the current catalog without changing model policies |
| `/copilot-enterprise-status` | Show discovery counts, timestamp, and up to 25 exclusion reasons |

Pi owns authentication, credential storage, token refresh, enterprise endpoint resolution, tool handling, cancellation, and model streaming. The extension changes the catalog, not the inference protocol.

**Login caveat:** Pi 1.3.0's built-in Copilot login may enable some known, unconfigured model policies. This extension leaves that login flow unchanged. Its own discovery traffic is GET-only and never calls a policy endpoint. It cannot promise that the host's login is read-only.

## Availability rules

After live discovery, a catalog entry must have:

- `model_picker_enabled: true`, with `policy.state: "enabled"` or omitted policy metadata;
- chat capability, no explicit streaming denial, and tool support. Unknown models must explicitly advertise tool calling;
- a supported API and usable context/output token limits.

Disabled, unconfigured, malformed, and unrecognized explicit policy states are excluded. GitHub may omit the policy field or its state on picker-enabled models; omission alone is not a denial, and those models still must pass the picker and capability checks. There is no automatic opt-in or policy-enablement command. If every picker flag is false, the extension does not fall back to policy-only availability, including on Individual plans. This is deliberately stricter than some Copilot clients.

Known models retain Pi's compatibility flags, reasoning configuration, pricing, and input metadata when their API is unchanged. Live vision flags and token limits override known metadata. Unknown models need advertised endpoints and limits. Endpoint selection uses `/v1/messages`, `/responses`, or `/chat/completions`, not model-name guesses. WebSocket-only and unknown protocols are excluded. Unknown Anthropic and Chat Completions models do not get speculative reasoning settings. Responses models get only advertised reasoning levels.

An enabled catalog entry is **not proof that an inference request will succeed**. Enterprise policy, subscription status, premium-request limits, or service restrictions may still reject a request. This extension is a model-discovery aid, not a security boundary or an enterprise policy bypass. Models added manually through `models.json` are filtered out of the available list after discovery unless their IDs are in the verified catalog. A restored session or explicit model lookup can still refer to a model outside that available list.

## Failure handling and privacy

- Requests time out after 10 seconds, honor cancellation, require HTTPS, and reject redirects.
- Server error bodies and raw network errors are not printed by this extension.
- Client identity headers come from Pi's bundled model metadata. The catalog API version is pinned to `2026-06-01`, matching Pi 1.3.0.
- Normalized model definitions are cached in Pi's `~/.pi/agent/models-store.json` so startup selection works across restarts. **The cache can contain private model names and IDs.** Keep it private and do not commit or sync it through a public repository. Resolved tokens, authentication headers, raw catalog payloads, and exclusion lists are not persisted by the extension.
- A separate `copilotEnterpriseOwner` metadata field stores a domain-separated, token-keyed HMAC owner fingerprint. HTTP validator fields `etag` and `lastModified` are left unset. Native Pi ignores this ownership field, so it is not sent as an HTTP validator when the extension is disabled. Only a matching owner's cache is restored by the extension. Pi still stores its credentials and session history normally.
- A failed refresh preserves the last successful catalog for the same credential. The status timestamp makes its age visible. An empty successful catalog removes all previously discovered models, including across restarts.
- Logout and missing credentials hide the in-memory catalog but leave the disk cache intact, because Pi also reports a failed credential read as a missing credential. A different authenticated OAuth owner discards the old cache. If no matching cache exists, startup uses bundled Pi availability until live discovery succeeds. Regenerating a refresh credential also invalidates its old cache. To remove private model metadata after logout, remove the `github-copilot` entry from `models-store.json` while Pi is closed.
- `--offline` / `PI_OFFLINE` follows Pi's network policy. A matching cached catalog can be used offline; otherwise the extension falls back to native Pi availability.
- `/copilot-enterprise-refresh` has a 15-second overall budget, including OAuth resolution. Pi's own background refresh supplies its own cancellation budget. A refresh racing RPC startup waits up to one second for composed authentication to bind before sending discovery traffic.

The `github-copilot` cache entry is shared with native Pi. Running without this extension can replace it with the pi.dev catalog, so a tenant-only saved default may not resolve until you run live discovery again. Keep the extension enabled consistently when using tenant-only models.

Use only one extension that replaces the `github-copilot` provider. In particular, do not load this alongside `@milespossing/pi-copilot-discovery`. Provider registration order would decide which extension is active.

## Costs

Pi's dollar estimates are not Copilot billing. Known models retain Pi's catalog prices. Unknown models use zero as an unavailable-price placeholder, **not a promise of free usage**. Check GitHub for premium-request multipliers, allowances, and actual billing.

## Develop

```sh
npm ci --ignore-scripts
npm run check
npm test
npm pack --dry-run
```

TypeScript loads directly in Pi. Runtime host packages are peer dependencies, not bundled dependencies. Development dependencies provide types and a test runner. CI tests Node.js 22 and 24. Tests use synthetic catalogs and fake tokens, with no GitHub credentials or model inference.

For a manual smoke test, load the checkout, refresh, inspect exclusions, and select a model missing from Pi's bundled catalog. A real prompt consumes your Copilot allowance. Do not publish fixtures captured from an enterprise tenant.

## Release

Publishing is manual. After review and owner approval, run the checks, inspect `npm pack --dry-run`, publish with `npm publish --access public`, and push the matching `v0.1.0` tag. There is no automatic publishing workflow.

## Related work

[`@milespossing/pi-copilot-discovery`](https://github.com/milespossing/pi-copilot-discovery) demonstrates live Copilot catalog discovery. This is a separate implementation focused on explicit policy filtering, no additional policy enablement, capability-based API selection, and synthetic regression tests.

## License

MIT. See [LICENSE](LICENSE).
