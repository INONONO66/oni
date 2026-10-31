import { Machine } from "@oni/protocol";
import type { MachineInputCapture } from "./host";

const windowKey = (target: Machine.WindowTarget) => `${target.pid}:${target.windowId}`;

export class ComputerWindows {
  readonly windows = new Map<string, Machine.ComputerWindow>();
  private readonly captures = new Map<string, string>();
  private readonly observations = new Map<string, string>();

  list(result: Machine.ScreenListResult): void {
    if (result.status !== "ok") return;
    const live = new Set<string>();
    for (const window of result.windows) {
      if (window.pid === undefined || window.app === undefined) continue;
      const target = Machine.WindowTarget.safeParse({ pid: window.pid, windowId: Number(window.windowId) });
      if (!target.success) continue;
      const key = windowKey(target.data);
      live.add(key);
      const epoch = this.windows.get(key)?.epoch;
      this.windows.set(key, { ...target.data, app: window.app, ...(epoch === undefined ? {} : { epoch }) });
    }
    if (!result.truncated)
      for (const key of this.windows.keys()) if (!live.has(key)) this.windows.delete(key);
  }

  observe(result: Machine.ScreenObserveResult): void {
    if (result.status !== "ok") return;
    const key = windowKey(result.target);
    this.windows.set(key, { ...result.target, app: result.window.app });
    this.observations.set(result.observationId, key);
    if ("screenshot" in result && result.screenshot !== undefined) this.captures.set(result.screenshot.captureId, key);
  }

  launch(request: Machine.AppLaunchRequest, result: Machine.AppLaunchResult): void {
    if (result.status !== "ok") return;
    const app = "bundleId" in request.app
      ? { bundleId: request.app.bundleId }
      : { bundleId: null, path: request.app.path };
    for (const target of result.windows) this.windows.set(windowKey(target), { ...target, app });
  }

  capture(request: Machine.ScreenCaptureRequest, captureId: string): void {
    this.captures.clear();
    if (request.target.kind !== "window") return;
    const windowId = request.target.windowId;
    const window = [...this.windows.values()].find((entry) => String(entry.windowId) === windowId);
    if (window !== undefined) this.captures.set(captureId, windowKey(window));
  }

  resolve(params: MachineInputCapture["params"]): Machine.ComputerWindow | undefined {
    if ("target" in params && params.target !== undefined &&
      !("delivery" in params && params.delivery === "foreground")) return this.windows.get(windowKey(params.target));
    if ("pid" in params) return [...this.windows.values()].find((entry) => entry.pid === params.pid);
    const at = "at" in params ? params.at : params;
    const key = "observationId" in at ? this.observations.get(at.observationId)
      : "captureId" in at ? this.captures.get(at.captureId) : undefined;
    const window = key === undefined ? undefined : this.windows.get(key);
    if (window !== undefined && "target" in params && params.target !== undefined &&
      windowKey(window) !== windowKey(params.target)) return undefined;
    return window;
  }
}
