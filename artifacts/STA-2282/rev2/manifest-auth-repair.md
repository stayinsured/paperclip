# manifest-auth.json truncation repair (evidence-quality defect, QA-flagged)

QA verdict STA-2283 (comment `eb86ded6`, 2026-08-19) flagged: `manifest-auth.json` in this
operator evidence bundle was truncated at exactly 4,000 bytes — invalid JSON tail. CTO triage
(`86fb6127`) and STA-2404 step 5 require the defect fixed; the rev-3 bundle must be untruncated.

## Defect

- Observed file: 4,000 bytes, `json.loads` fails ("Unterminated string", cut mid-way through
  `runtime.containerImage`).
- Root cause: capture-side truncation at a 4,000-byte boundary. The file content is byte-identical
  to the first 4,000 bytes of `json.dumps(machine_manifest, indent=1)`.

## Repair (2026-08-19, operator 9f22f9ed, STA-2404 step 5)

- Authoritative source: `artifacts/STA-2281/trial-authorization-manifest.json` (11,060 B,
  SHA-256 `3a641e147d1362ad9c85f73eb0b4c1e8b1c5c2135ef302359a3d3ab6d626b4a6`, identical to the
  frozen manifest attachment of record `5424b10e-1a8c-4108-8fc5-755192cd4971`).
- Deterministic reconstruction verified: the first 4,000 bytes of
  `json.dumps(manifest, indent=1)` match the truncated file byte-for-byte (precondition asserted
  before any write). Full serialization: 10,643 bytes, valid JSON.
- `manifest-auth.json` now carries the complete serialization (SHA-256
  `3986260353bd5ad11c23908158a00f9b50b9903649181d71a2accb5d1edaba81`).
- The original truncated file is preserved verbatim as
  `manifest-auth.json.truncated-4000B.orig` (SHA-256
  `d7d1bc8766659f36ca77f2e4e212ed6bff77374de69f726fa672780c4106cf17`) so QA's earlier
  24-of-24 checksum verification of this bundle remains auditable against the exact bytes seen.
- `SHA256SUMS.txt` updated to 25 entries (24 original files with the old `manifest-auth.json`
  entry replaced, plus the preserved `.orig`); `sha256sum -c` verifies 25/25 OK.

No semantic content changed: the repaired file is the same manifest object the truncated prefix
already carried, completed. No package value, frozen object, or authorization fact is altered.
