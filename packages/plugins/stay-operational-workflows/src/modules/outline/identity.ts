import { createHash } from "node:crypto";

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableJson(entryValue)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function configurationFingerprint(value: unknown): string {
  return `sha256:${sha256(stableJson(value))}`;
}

export function outlineAssessmentKey(companyId: string, issueId: string, policyVersion: string): string {
  return `outline-assessment:${sha256(`${companyId}\u0000${issueId}\u0000${policyVersion}`)}`;
}

export function outlineDocumentKey(companyId: string, canonicalDocumentKey: string): string {
  return `outline-document:${sha256(`${companyId}\u0000${canonicalDocumentKey}`)}`;
}

export function outlineOperationKey(companyId: string, issueId: string, policyVersion: string): string {
  return `outline-publish:${sha256(`${companyId}\u0000${issueId}\u0000${policyVersion}`)}`;
}

export function outlineExceptionKey(companyId: string, issueId: string): string {
  return `outline-exception:${sha256(`${companyId}\u0000${issueId}`)}`;
}

export function deterministicOutlineDocumentId(companyId: string, canonicalDocumentKey: string): string {
  const bytes = Buffer.from(
    sha256(`staydigital-outline-v1\u0000${companyId}\u0000${canonicalDocumentKey}`).slice(0, 32),
    "hex",
  );
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
