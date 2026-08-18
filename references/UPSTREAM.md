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
