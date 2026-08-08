import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompanySkillTestRunCreateRequest } from "@paperclipai/shared";
import { ApiError } from "./client";
import { companySkillsApi } from "./companySkills";

describe("companySkillsApi test runs", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the explicit canonical execution mode when creating a run", async () => {
    const payload: CompanySkillTestRunCreateRequest = {
      agentId: "agent-1",
      content: "Pinned input",
      executionMode: "response_only",
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ id: "run-1", executionMode: "response_only" }),
      { status: 201, headers: { "Content-Type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);

    await companySkillsApi.createTestRun("company-1", "skill-1", payload);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/companies/company-1/skills/skill-1/test-runs");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual(payload);
  });

  it("preserves deterministic unsupported-adapter capability metadata", async () => {
    const errorBody = {
      error: "Adapter process does not support response-only Skill Studio execution.",
      code: "skill_test_response_only_unsupported_adapter",
      details: {
        code: "skill_test_response_only_unsupported_adapter",
        adapterType: "process",
        requestedExecutionMode: "response_only",
        requiredCapability: "skill_test_response_only",
        supportedExecutionProfiles: [],
      },
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify(errorBody),
      { status: 422, headers: { "Content-Type": "application/json" } },
    )));

    const request = companySkillsApi.createTestRun("company-1", "skill-1", {
      agentId: "agent-1",
      content: "Pinned input",
      executionMode: "response_only",
    });

    await expect(request).rejects.toMatchObject({
      status: 422,
      message: errorBody.error,
      body: errorBody,
    } satisfies Partial<ApiError>);
  });
});
