import type { z } from "zod";
import type { shellCommandSchema } from "./validation";

/** IPC contract; imports are type-only so both processes share the channel literals. */

/**
 * The gateway endpoint as the renderer receives it.
 *
 * Structurally identical to the main process's `GatewayEndpoint` and declared
 * separately on purpose: this file is the only module the renderer bundle and
 * the preload bundle share, and it must stay import-free so neither drags the
 * other's dependencies across the context boundary.
 */
export interface GatewayEndpoint {
  readonly url: string;
  readonly token?: string;
}

/**
 * The one IPC channel behind `window.desktop.gateway()`.
 *
 * `ipcMain.handle` and `ipcRenderer.invoke` are compiled into two different
 * bundles running in two different processes, so a mistyped channel is not a
 * type error — it is a promise that never settles. Both sides read the literal
 * from here.
 */
export const GATEWAY_CHANNEL = "oni:gateway";
export const SHELL_COMMAND_CHANNEL = "shell:command";
/**
 * Renderer -> main: close the window that sent it.
 *
 * Cmd+W is a menu accelerator that reaches the renderer as `close-tab`, so the
 * native window-close never fires on its own. When no tab is left, the renderer
 * hands the keystroke back here and main closes the sender's window — the
 * behaviour a user expects from Cmd+W on an empty window.
 */
export const CLOSE_WINDOW_CHANNEL = "shell:close-window";

export type ShellCommand = z.infer<typeof shellCommandSchema>;

export interface DesktopApi {
  readonly onShellCommand: (listener: (command: ShellCommand) => void) => () => void;
  /** Close this window; used when `close-tab` arrives with no tab to close. */
  readonly closeWindow: () => void;
  readonly versions: { readonly electron: string; readonly chrome: string; readonly node: string };
  /**
   * Where the gateway is, or `undefined` when this build has none.
   *
   * `undefined` is a real answer rather than an error: it is how a build with
   * no gateway configured tells the renderer to disable its composer and say
   * so, rather than talk to anything fabricated.
   */
  readonly gateway: () => Promise<GatewayEndpoint | undefined>;
}
