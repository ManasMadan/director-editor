// Serves the static Storybook build (storybook-static/) for the screenshot tests, with no
// dependencies, so it runs in the Playwright image as is.
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

const root = join(import.meta.dirname, "..", "storybook-static");
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
};

createServer((request, response) => {
  const path = normalize(join(root, decodeURIComponent(new URL(request.url, "http://x").pathname)));
  const file = path.startsWith(root) && existsSync(path) && statSync(path).isFile() ? path : null;
  if (!file) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(response);
}).listen(Number(process.env.PORT ?? 6007));
