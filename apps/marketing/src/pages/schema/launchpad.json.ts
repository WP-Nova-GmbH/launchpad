import type { APIRoute } from "astro";

import { buildT3ProjectFileJsonSchema } from "@t3tools/shared/t3ProjectFile";

// Keep the old endpoint working while consumers move to the new URL.
export const GET: APIRoute = () =>
  new Response(
    `${JSON.stringify({ ...buildT3ProjectFileJsonSchema(), $id: "https://t3.codes/schema/launchpad.json" }, null, 2)}\n`,
    {
      headers: { "Content-Type": "application/json" },
    },
  );
