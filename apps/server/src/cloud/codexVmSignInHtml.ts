const messages = {
  received: {
    title: "Sign-in received",
    description: "Return to Launchpad to finish connecting your Codex account.",
  },
  denied: {
    title: "Sign-in was not completed",
    description: "Return to Launchpad to try connecting your Codex account again.",
  },
  invalid: {
    title: "This sign-in link is invalid",
    description: "The link is invalid or has expired. Return to Launchpad to start sign-in again.",
  },
};

/** Self-contained because the temporary callback listener closes after this response. */
export function renderCodexVmSignInHtml(
  outcome: keyof typeof messages,
  returnUrl?: string,
): string {
  const { title, description } = messages[outcome];
  const href = returnUrl
    ?.replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <title>${title} · Launchpad</title>
    <style>
      :root {
        color-scheme: light dark;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
        background: #fcfcfc;
        color: #27272a;
        --muted: #71717b;
        --accent: #1b4ed8;
        --status: #167648;
        --status-background: #edf7f1;
      }
      * { box-sizing: border-box; }
      body { min-height: 100vh; min-height: 100svh; margin: 0; display: grid; place-items: center; }
      main { width: min(100%, 420px); padding: 32px 24px; margin: auto; text-align: center; }
      .status { width: 46px; height: 46px; display: grid; place-items: center; margin: 0 auto 20px; border-radius: 50%; color: var(--status); background: var(--status-background); }
      .status::after { content: ""; width: 18px; height: 10px; border-bottom: 2px solid currentColor; border-left: 2px solid currentColor; transform: translateY(-2px) rotate(-45deg); }
      .status.error { --status: #a04c16; --status-background: #fff3e8; }
      .status.error::after { content: "!"; width: auto; height: auto; border: 0; transform: none; font-size: 24px; font-weight: 500; }
      h1 { margin: 0; font-size: clamp(24px, 5vw, 28px); line-height: 1.2; font-weight: 500; letter-spacing: -0.8px; }
      .description { margin: 13px auto 25px; max-width: 330px; color: var(--muted); font-size: 14px; line-height: 1.65; text-wrap: pretty; }
      .return { display: inline-flex; align-items: center; justify-content: center; gap: 10px; min-height: 44px; padding: 10px 18px; border-radius: 8px; background: var(--accent); color: #fff; text-decoration: none; font-size: 13px; font-weight: 500; }
      .return:hover { filter: brightness(1.08); }
      .return:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; }
      .hint { margin: 15px auto 0; max-width: 320px; color: var(--muted); font-size: 12px; line-height: 1.6; }
      @media (prefers-color-scheme: dark) {
        :root { background: #0a0a0a; color: #f5f5f5; --muted: #969696; --accent: #346bf1; --status: #68c495; --status-background: #15251c; }
        .status.error { --status: #e6a873; --status-background: #2b2017; }
      }
    </style>
  </head>
  <body>
    <main aria-labelledby="title">
      <div class="status${outcome === "received" ? "" : " error"}" aria-hidden="true"></div>
      <h1 id="title">${title}</h1>
      <p class="description">${description}</p>
      ${href ? `<a class="return" href="${href}">Return to Launchpad <span aria-hidden="true">↗</span></a>` : ""}
      <p class="hint">${href ? "If Launchpad doesn’t open, switch back to the app. " : ""}You can close this tab afterward.</p>
    </main>
  </body>
</html>`;
}
