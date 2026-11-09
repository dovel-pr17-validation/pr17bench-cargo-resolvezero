import { createFileRoute } from "@tanstack/react-router";

const HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ResolveZero API</title>
    <style>
      body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; background: #faf9f7; }
      .rz-docs-bar { display: flex; align-items: center; justify-content: space-between; gap: 16px;
        padding: 14px 20px; background: #0b0b0a; color: #f2efe6; font-size: 12px; }
      .rz-docs-bar a { color: #ff4d00; text-decoration: none; font-weight: 600; }
      .rz-docs-bar span { letter-spacing: 0.16em; text-transform: uppercase; font-size: 9px; opacity: 0.75; }
    </style>
  </head>
  <body>
    <div class="rz-docs-bar">
      <div><strong>ResolveZero API</strong> <span>OpenAPI</span></div>
      <a href="/openapi.json">openapi.json</a>
    </div>
    <script id="api-reference" data-url="/openapi.json"></script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
  </body>
</html>`;

export const Route = createFileRoute("/docs")({
  server: {
    handlers: {
      GET: () =>
        new Response(HTML, {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    },
  },
});
