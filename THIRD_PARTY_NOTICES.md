# BetterDesk third-party notices

This file is the release index for third-party material distributed with
BetterDesk. It complements, but does not replace, the license text and notices
required by each dependency.

## Source manifests

The authoritative dependency manifests for a release are:

- `betterdesk-server/go.mod` and `betterdesk-server/go.sum`
- `betterdesk-agent/go.mod` and `betterdesk-agent/go.sum`
- `betterdesk-support-agent/go.mod` and `betterdesk-support-agent/go.sum`
- `web-nodejs/package.json` and `web-nodejs/package-lock.json`
- `rdclient-desktop/package.json`, Cargo manifests, and
  `rdclient-desktop/vendor/wry/LICENSE.spdx`

The build/release process must archive resolved dependency lists from those
manifests with the matching source revision as an SBOM.

## Support Agent distribution

The Support Agent is built with Go and Fyne. Its code declares the dependency
licenses in [LICENSE](LICENSE); a release must also include the notices supplied
by Fyne and all resolved Go modules when they are distributed in a form that
requires them.

External system tools such as FFmpeg, GStreamer, PipeWire, xdg-desktop-portal,
xdotool, and ydotool are not silently relicensed by BetterDesk. A package may
only bundle one of them after its license, redistributability, provenance, and
security-update path are recorded in the release SBOM.

## Compatibility components

Any desktop-client compatibility adapter is subject to
[support-agent-provenance.md](docs/important/support-agent-provenance.md).
Before distribution, its release record must include:

1. the compatibility specification revision;
2. a source-provenance review result;
3. generated-schema hashes;
4. third-party notices for its direct and transitive dependencies; and
5. a signed artifact checksum.

## Maintainer checklist

- Do not remove vendor license files from release inputs.
- Do not declare a dependency's license from memory; use its resolved package
  metadata and shipped notices.
- Do not add external source, generated protocol artifacts, or binary blobs
  without an entry in the SBOM and provenance review.
- Update this index when a release begins bundling a new runtime component.

