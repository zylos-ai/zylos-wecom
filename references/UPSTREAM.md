# Bundled WeCom Office Skills

This component bundles two MIT-licensed upstream snapshots:

- `references/wecom-cli/`: `WecomTeam/wecom-cli` at
  `1d9e74026455a85d8d10a917b4d453ed4b9a829e` (`@wecom/cli` 1.1.0)
- `references/wecom-unified/`: `WecomTeam/wecom-unified` at
  `2620033fdb2721fb192ac06a6a0510987035d203`

The modular `wecom-cli` skills are authoritative wherever the snapshots
overlap. The Unified snapshot supplies aggregate intent routing and
cross-domain orchestration guidance. Each snapshot retains its upstream MIT
license file.

## Integration-policy override

The snapshots are preserved for provenance and are not the component lifecycle
authority. Generic upstream instructions to run
`npm install -g @wecom/cli` or blocking `wecom-cli auth init` must not be
executed by this component. The root `SKILL.md` overrides those two steps: the
component install/upgrade hook owns the pinned binary, and the managed owner-DM
authorization helper owns QR authorization. Domain commands, parameters,
safety checks, and output rules continue to come from the vendored modular
Skills.

The component-specific policy is declared as a known override in
`wecom-vendor-manifest.json`. Override paths must remain outside both vendored
roots, so an override cannot hide an upstream file change.

## Drift detection

Run the offline, read-only integrity check after changing a pin or any vendored
file:

```bash
npm run check:wecom-vendor
```

The manifest records every expected path and SHA-256 digest for both pinned
snapshots. The check fails on a package pin mismatch, a modified or missing
file, an unexpected file, an invalid override, or a missing override policy
file. Install and upgrade hooks run the same verification before accepting the
bundled Skills. The check never downloads or rewrites upstream content; an
intentional snapshot refresh requires an explicit pin and manifest update.
