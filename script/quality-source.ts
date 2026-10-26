/** Campaign-owned handwritten source. Configs, generated output and dependencies
 * remain resolver inputs, but never contribute source findings or consumers. */
export function qualitySource(path: string): boolean {
  const parts = path.split("/");
  return (
    /\.(?:tsx?|py)$/.test(path) &&
    !parts.some((part) => ["dist", "node_modules", "coverage", "generated", "__generated__", ".git", ".omo", "__pycache__"].includes(part)) &&
    (path === "clients/machine-client/src/code/driver.py" ||
      parts[0] === "script" ||
      (["packages", "apps"].includes(parts[0] ?? "") &&
        parts.length > 3 && ["src", "test"].includes(parts[2] ?? "")))
  );
}
