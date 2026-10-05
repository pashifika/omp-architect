import { expect, test } from "bun:test";
import { buildJevRequest, parseJevResponse } from "../src/auto/decision.ts";
import evidence from "./fixtures/jev-routing-live.json";

test("recorded legacy routing connector smoke: exact requests and strict response replay", () => {
  // Offline replay of previously captured live calls; this test never calls Jev.
  expect(evidence.cases).toHaveLength(6);
  for (const item of evidence.cases) {
    expect(
      buildJevRequest(item.request.state, { model: "jev-latest", maxEvidenceChars: 12000 }),
    ).toEqual(item.request as ReturnType<typeof buildJevRequest>);
    const parsed = parseJevResponse(item.response, item.request.questions.next.criteria);
    expect(String(parsed.choice)).toBe(item.expected);
    expect(parsed.confidence).toBeGreaterThanOrEqual(0.8);
  }
});
