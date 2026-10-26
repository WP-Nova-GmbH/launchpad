import * as Schema from "effect/Schema";
const decodeImage = Schema.decodeUnknownExit(
  Schema.fromJsonString(Schema.Struct({ attrs: Schema.Struct({ src: Schema.String }) })),
);

/** Signed MCP upload URLs expire after five minutes; references use the stable upload path. */
export function linearUploadUrl(value: string): string | undefined {
  const url = URL.parse(value);
  if (
    !url ||
    url.origin !== "https://uploads.linear.app" ||
    url.username ||
    url.password ||
    value.length > 8192
  )
    return undefined;
  url.search = "";
  url.hash = "";
  return url.href;
}

/** Linear's MCP issue descriptions may embed editor image nodes instead of Markdown images. */
export function normalizeLinearMarkdown(markdown: string): string {
  return markdown.replace(/<linear-image>([\s\S]*?)<\/linear-image>/g, (original, body: string) => {
    const decoded = decodeImage(body);
    if (decoded._tag !== "Success") return original;
    const url = linearUploadUrl(decoded.value.attrs.src);
    return url ? `![image](<${url}>)` : original;
  });
}
