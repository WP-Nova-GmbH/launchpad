import remarkParse from "remark-parse";
import { unified } from "unified";

const parser = unified().use(remarkParse).freeze();
type Node = ReturnType<typeof parser.parse> | ReturnType<typeof parser.parse>["children"][number];

/** Extract image destinations, including reference images, without following links or HTML. */
export function markdownImageUrls(markdown: string): readonly string[] {
  const tree = parser.parse(markdown);
  const definitions = new Map<string, string>();
  const images: string[] = [];
  const references: string[] = [];
  const visit = (node: Node): void => {
    if (node.type === "definition") definitions.set(node.identifier, node.url);
    if (node.type === "image") images.push(node.url);
    if (node.type === "imageReference") references.push(node.identifier);
    if ("children" in node) for (const child of node.children) visit(child);
  };
  visit(tree);
  for (const reference of references) {
    const url = definitions.get(reference);
    if (url) images.push(url);
  }
  return [...new Set(images)];
}
