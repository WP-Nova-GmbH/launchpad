import {
  isAllowedWorkflowEnvironmentName,
  RELAY_WORKFLOW_ENV_VALUE_MAX_BYTES,
  RELAY_WORKFLOW_ENV_MAX_ENTRIES,
} from "@t3tools/contracts/relay";

export const WORKFLOW_ENV_IMPORT_TEXT_LIMIT = 128 * 1024;
const encoder = new TextEncoder();
type ParseResult =
  | { entries: ReadonlyArray<{ name: string; value: string }>; error?: never }
  | { error: string; entries?: never };

function readValue(lines: ReadonlyArray<string>, index: number, raw: string) {
  const quote = raw[0];
  if (quote !== '"' && quote !== "'" && quote !== "`") {
    return { value: raw.split("#", 1)[0]!.trimEnd(), lastLine: index };
  }

  let value = "";
  let line = raw.slice(1);
  for (let lastLine = index; lastLine < lines.length; lastLine++) {
    for (let offset = 0; offset < line.length; offset++) {
      const character = line.charAt(offset);
      if (character === quote) {
        const rest = line.slice(offset + 1).trimStart();
        return !rest || rest.startsWith("#") ? { value, lastLine } : null;
      }
      if (quote === '"' && character === "\\" && offset + 1 < line.length) {
        const escape = line.charAt(offset + 1);
        switch (escape) {
          case "n":
            value += "\n";
            break;
          case "r":
            value += "\r";
            break;
          case "t":
            value += "\t";
            break;
          case '"':
          case "\\":
            value += escape;
            break;
          default:
            value += "\\" + escape;
        }
        offset++;
      } else {
        value += character;
      }
    }
    value += "\n";
    line = lines[lastLine + 1] ?? "";
  }
  return null;
}

export function parseWorkflowEnvImport(input: string): ParseResult {
  if (
    input.length > WORKFLOW_ENV_IMPORT_TEXT_LIMIT ||
    encoder.encode(input).byteLength > WORKFLOW_ENV_IMPORT_TEXT_LIMIT
  ) {
    return { error: "Paste no more than 128 KiB of .env text." } as const;
  }

  const lines = input.split(/\r\n|\n|\r/u);
  const firstLine = new Map<string, number>();
  const entries: Array<{ name: string; value: string }> = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.trimStart();
    if (!line || line.startsWith("#")) continue;

    const assignment = /^(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*([\s\S]*)$/u.exec(
      line,
    );
    if (!assignment) {
      return { error: `Line ${index + 1}: expected NAME=value.` } as const;
    }
    const [, name, raw] = assignment;
    if (!name || raw === undefined || !isAllowedWorkflowEnvironmentName(name)) {
      return { error: `Line ${index + 1}: this environment name is not allowed.` } as const;
    }
    const duplicate = firstLine.get(name);
    if (duplicate !== undefined) {
      return { error: `Line ${index + 1}: duplicates the name on line ${duplicate}.` } as const;
    }
    if (entries.length === RELAY_WORKFLOW_ENV_MAX_ENTRIES) {
      return {
        error: `Line ${index + 1}: the .env import can contain at most ${RELAY_WORKFLOW_ENV_MAX_ENTRIES} entries.`,
      };
    }
    const parsed = readValue(lines, index, raw);
    if (!parsed) {
      return { error: `Line ${index + 1}: check the value's quotes.` } as const;
    }
    if (
      /[\uD800-\uDFFF]/u.test(parsed.value) ||
      parsed.value.includes("\0") ||
      encoder.encode(parsed.value).byteLength > RELAY_WORKFLOW_ENV_VALUE_MAX_BYTES
    ) {
      return {
        error: `Line ${index + 1}: the value must be valid text and at most 4 KiB.`,
      } as const;
    }
    firstLine.set(name, index + 1);
    entries.push({ name, value: parsed.value });
    index = parsed.lastLine;
  }
  return entries.length ? { entries } : { error: "Paste at least one NAME=value entry." };
}

export function suggestedWorkflowEnvKind(name: string): "variable" | "secret" {
  return /(?:^|_)(?:SECRET|TOKEN|PASSWORD|PASSWD|KEY|CREDENTIALS?)(?:_|$)/iu.test(name)
    ? "secret"
    : "variable";
}
