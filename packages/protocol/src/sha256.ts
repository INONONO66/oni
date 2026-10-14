/**
 * ONE sha256 owner for the package. The builtin is resolved at call time
 * through `process.getBuiltinModule` (Node >= 22.3, Bun, Electron's Node)
 * rather than a static `node:crypto` import, so the package stays loadable
 * where that builtin does not exist: the desktop renderer imports the barrel
 * for schemas and the wire parser and never digests. A static import throws
 * at module load there and leaves the console window empty.
 */
export function sha256Hex(input: string | Uint8Array): string {
  return process.getBuiltinModule("node:crypto").createHash("sha256").update(input).digest("hex");
}
