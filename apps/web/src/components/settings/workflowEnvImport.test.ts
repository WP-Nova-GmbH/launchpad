import { describe, expect, it } from "vite-plus/test";
import { parseWorkflowEnvImport, suggestedWorkflowEnvKind } from "./workflowEnvImport";

describe("workflow .env import", () => {
  it("reads common dotenv values literally without resolving references", () => {
    expect(
      parseWorkflowEnvImport(
        [
          "# comment",
          "export MODE=production # note",
          "EMPTY=",
          'CONNECTION="a=b#fragment"',
          "EXPANSION=${MODE}",
          "MULTILINE='first",
          "second'",
          'ESCAPED="one\\ntwo\\"quoted\\""',
        ].join("\r\n"),
      ),
    ).toEqual({
      entries: [
        { name: "MODE", value: "production" },
        { name: "EMPTY", value: "" },
        { name: "CONNECTION", value: "a=b#fragment" },
        { name: "EXPANSION", value: "${MODE}" },
        { name: "MULTILINE", value: "first\nsecond" },
        { name: "ESCAPED", value: 'one\ntwo"quoted"' },
      ],
    });
  });

  it("reads backtick quotes literally, including fragments and multiline text", () => {
    expect(
      parseWorkflowEnvImport(
        [
          "CALLBACK_URL=`https://example.test/#done` # comment",
          "MULTILINE=`first\\n literal",
          "#second `",
          "NEXT=visible",
        ].join("\r\n"),
      ),
    ).toEqual({
      entries: [
        { name: "CALLBACK_URL", value: "https://example.test/#done" },
        { name: "MULTILINE", value: "first\\n literal\n#second " },
        { name: "NEXT", value: "visible" },
      ],
    });
  });

  it.each([
    ["A=1\nA=2", /Line 2.*line 1/],
    ["A=1\nnot an assignment", /Line 2.*NAME=value/],
    ['A=1\nBROKEN="PRIVATE_VALUE', /Line 2.*quotes/],
    ["A=1\nBROKEN=`PRIVATE_VALUE", /Line 2.*quotes/],
    ["A=1\nBROKEN=`PRIVATE_VALUE` trailing", /Line 2.*quotes/],
    ["PATH=PRIVATE_VALUE", /Line 1.*not allowed/],
    ["LARGE=" + "é".repeat(2049), /Line 1.*4 KiB/],
  ])("reports the line of an invalid import", (input, error) => {
    const result = parseWorkflowEnvImport(input);
    expect(result.error).toMatch(error);
    expect(result.error).not.toContain("PRIVATE_VALUE");
    expect(result.entries).toBeUndefined();
  });

  it("suggests Secret using whole words in the name", () => {
    for (const name of ["deploy_token", "CLIENT_SECRET", "DATABASE_PASSWORD", "API_KEY"]) {
      expect(suggestedWorkflowEnvKind(name)).toBe("secret");
    }
    for (const name of ["API_BASE_URL", "KEYBOARD_LAYOUT", "TOKENIZER"]) {
      expect(suggestedWorkflowEnvKind(name)).toBe("variable");
    }
  });
});
