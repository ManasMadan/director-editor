import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkWebRenderOnly } from "./check-web-render-only";
import { captureOutput } from "./stand-ins";

afterEach(() => mock.restore());

function web(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "web-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

describe("the web app's render-only check", () => {
  it("allows pages, components, the health probe and the app association files", () => {
    const printed = captureOutput();
    const dir = web({
      "app/page.tsx": "export default function Page() {}\n",
      "app/healthz/route.ts": "export function GET() {}\n",
      "app/.well-known/apple-app-site-association/route.ts": "export function GET() {}\n",
      "app/.well-known/assetlinks.json/route.ts": "export function GET() {}\n",
      "lib/format.ts": "// A comment about 'use server' is fine.\n",
    });
    expect(checkWebRenderOnly(dir)).toBe(0);
    expect(printed()).toContain("web app is render-only");
  });

  it("refuses route handlers, server actions and Pages Router API routes", () => {
    const printed = captureOutput();
    const dir = web({
      "app/api/users/route.ts": "export function POST() {}\n",
      "app/.well-known/anything/route.ts": "export function GET() {}\n",
      "app/actions.ts": '"use server";\nexport async function save() {}\n',
      "pages/api/hello.js": "export default () => {};\n",
    });
    expect(checkWebRenderOnly(dir)).toBe(1);
    const output = printed();
    expect(output).toContain("apps/web/src/app/api/users/route.ts: route handlers are not allowed");
    expect(output).toContain("apps/web/src/app/.well-known/anything/route.ts: route handlers");
    expect(output).toContain('apps/web/src/app/actions.ts: server actions ("use server")');
    expect(output).toContain("apps/web/src/pages/api/hello.js: Pages Router API routes");
  });

  it("passes the real web app", () => {
    captureOutput();
    expect(checkWebRenderOnly()).toBe(0);
  });
});
