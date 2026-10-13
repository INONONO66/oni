import ts from "typescript";
import { runScriptMain } from "./main-runner";

type SideEffectRuleId = "processor-projected-sink";

interface SideEffectViolation {
  readonly ruleId: SideEffectRuleId;
  readonly filePath: string;
  readonly line: number;
  readonly message: string;
}

const hotFiles = ["packages/llm/src/processor/index.ts"];

export async function main(): Promise<void> {
  const violations: SideEffectViolation[] = [];

  await verifyPinnedFilesExist(hotFiles, (filePath) => `Missing hot file: ${filePath}`);
  for (const filePath of hotFiles) {
    const source = await Bun.file(filePath).text();
    violations.push(...validateSideEffectRules(filePath, source));
  }

  if (violations.length === 0) {
    process.stdout.write(`OK: side-effect lint scanned ${hotFiles.length} hot files\n`);
    return;
  }

  for (const violation of violations) {
    process.stderr.write(
      `VIOLATION: ${violation.filePath}:${violation.line} [${violation.ruleId}] — ${violation.message}\n`,
    );
  }

  process.exit(1);
}

export async function verifyPinnedFilesExist(
  files: readonly string[],
  errorMessage: (filePath: string) => string,
): Promise<void> {
  for (const filePath of files) {
    if (!(await Bun.file(filePath).exists())) {
      throw new Error(errorMessage(filePath));
    }
  }
}

export function validateSideEffectRules(filePath: string, source: string): SideEffectViolation[] {
  if (!hotFiles.includes(filePath)) return [];
  const file = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
  const options: ts.CompilerOptions = { noResolve: true, noLib: true };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (name) => (name === filePath ? file : undefined);
  const checker = ts.createProgram([filePath], options, host).getTypeChecker();
  const violations: SideEffectViolation[] = [];
  let emissions = 0;
  function violation(offset: number, message: string): void {
    violations.push({
      ruleId: "processor-projected-sink",
      filePath,
      line: file.getLineAndCharacterOfPosition(offset).line + 1,
      message,
    });
  }
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const { expression: receiver, name } = node.expression;
      if (
        ts.isIdentifier(receiver) &&
        receiver.text === "sink" &&
        /^on(Message|ToolCall|ToolResult|Snapshot)$/.test(name.text)
      ) {
        emissions += 1;
        const declaration = checker.getSymbolAtLocation(receiver)?.valueDeclaration;
        if (!declaration || !isProjectedBinding(declaration, node.getStart(file))) {
          violation(
            node.getStart(file),
            "processor sink side effects must flow through createProjectedSink",
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  if (emissions === 0)
    violation(0, "side-effect call pattern not found for processor-projected-sink");
  return violations;
}

function isProjectedBinding(declaration: ts.Declaration, emissionStart: number): boolean {
  // The projector itself forwards to its raw sink parameter; no other function does.
  if (ts.isParameter(declaration)) {
    const owner = declaration.parent;
    return ts.isFunctionDeclaration(owner) && owner.name?.text === "createProjectedSink";
  }
  if (!ts.isVariableDeclaration(declaration) || declaration.end > emissionStart) return false;
  const initializer = declaration.initializer;
  return (
    ts.isVariableDeclarationList(declaration.parent) &&
    (declaration.parent.flags & ts.NodeFlags.Const) !== 0 &&
    initializer !== undefined &&
    ts.isCallExpression(initializer) &&
    ts.isIdentifier(initializer.expression) &&
    initializer.expression.text === "createProjectedSink"
  );
}

if (import.meta.main) await runScriptMain(main);
