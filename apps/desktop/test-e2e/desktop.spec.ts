import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron, expect, test } from "@playwright/test";

const startupScript = join(import.meta.dirname, "startup.cjs");

test("production desktop shell boots with its bridge and CSP", async () => {
  const testInfo = test.info();
  const profile = await mkdtemp(join(tmpdir(), "oni-desktop-smoke-"));
  const errorsFile = join(profile, "startup-errors.jsonl");
  const environment = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  delete environment.ELECTRON_RENDERER_URL;
  environment.DESKTOP_SMOKE_PROFILE = profile;
  environment.DESKTOP_SMOKE_ERRORS = errorsFile;
  const electron = await _electron.launch({
    cwd: join(import.meta.dirname, ".."),
    args: ["--require", startupScript, "--disable-gpu", "dist/main/index.js"],
    env: environment,
  });
  const rendererErrors: string[] = [];
  electron.on("console", (message) => {
    if (message.type() === "error") rendererErrors.push(message.text());
  });
  try {
    const page = await electron.firstWindow({ timeout: 15_000 });
    page.on("pageerror", (error) => rendererErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") rendererErrors.push(message.text());
    });
    await expect(page).toHaveTitle("Oni Desktop");
    const root = page.locator('[data-ui="Console.Content"]');
    await expect(root).toBeVisible();
    const bounds = await root.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds?.width).toBeGreaterThan(0);
    expect(bounds?.height).toBeGreaterThan(0);
    const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content");
    expect(csp).toContain("connect-src");
    expect(csp).toContain("font-src");
    const requireType = await page.evaluate("typeof require");
    const bridge = await page.evaluate(() => ({
      keys: Object.keys(window.desktop).sort(),
      versions: window.desktop.versions,
      gateway: typeof window.desktop.gateway,
    }));
    expect(bridge.keys).toEqual(["closeWindow", "gateway", "onShellCommand", "versions"]);
    expect(bridge.gateway).toBe("function");
    expect(bridge.versions.electron).toBeTruthy();
    expect(requireType).toBe("undefined");
    expect(rendererErrors).toEqual([]);
    await page.screenshot({ path: join(testInfo.outputDir, "desktop-shell.png") });
  } finally {
    await electron.close();
    const startupErrors = await readFile(errorsFile, "utf8").catch(() => "");
    expect(startupErrors).toBe("");
    await rm(profile, { recursive: true, force: true });
  }
});
