import ts from "typescript";
import type { NativeLines } from "./quality-native-lcov";

export type TypescriptMetricContract = {
  readonly algorithm: "oni-typescript-function-metrics-v1";
  readonly tool: "typescript";
  readonly version: "5.9.2";
  readonly coverage: "lcov-da-line-fraction-v1";
  readonly cyclomaticExclusiveMax: number;
  readonly halsteadDifficultyExclusiveMax: number;
  readonly crapExclusiveMax: number;
};

export type FunctionMetrics = {
  readonly path: string;
  readonly symbol: string;
  readonly line: number;
  readonly endLine: number;
  readonly cyclomatic: number;
  readonly halsteadDifficulty: number;
  readonly coverage: number;
  readonly crap: number;
};

type FunctionWithBody = (
  | ts.FunctionDeclaration
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
) & { readonly body: ts.ConciseBody };

function functionWithBody(node: ts.Node): node is FunctionWithBody {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node)
  ) && node.body !== undefined;
}

const OPERATOR_TOKENS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.AsteriskAsteriskToken,
  ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.PercentToken,
  ts.SyntaxKind.PlusPlusToken,
  ts.SyntaxKind.MinusMinusToken,
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.AmpersandToken,
  ts.SyntaxKind.BarToken,
  ts.SyntaxKind.CaretToken,
  ts.SyntaxKind.ExclamationToken,
  ts.SyntaxKind.TildeToken,
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.QuestionToken,
  ts.SyntaxKind.ColonToken,
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.LessThanLessThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
  ts.SyntaxKind.InKeyword,
  ts.SyntaxKind.InstanceOfKeyword,
  ts.SyntaxKind.NewKeyword,
  ts.SyntaxKind.DeleteKeyword,
  ts.SyntaxKind.TypeOfKeyword,
  ts.SyntaxKind.VoidKeyword,
  ts.SyntaxKind.AwaitKeyword,
  ts.SyntaxKind.YieldKeyword,
  ts.SyntaxKind.ReturnKeyword,
  ts.SyntaxKind.ThrowKeyword,
]);

const OPERAND_TOKENS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.Identifier,
  ts.SyntaxKind.PrivateIdentifier,
  ts.SyntaxKind.NumericLiteral,
  ts.SyntaxKind.BigIntLiteral,
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
  ts.SyntaxKind.RegularExpressionLiteral,
  ts.SyntaxKind.TrueKeyword,
  ts.SyntaxKind.FalseKeyword,
  ts.SyntaxKind.NullKeyword,
  ts.SyntaxKind.ThisKeyword,
  ts.SyntaxKind.SuperKeyword,
]);

function functionName(node: FunctionWithBody, source: ts.SourceFile, line: number): string {
  if (node.name) return node.name.getText(source);
  if (ts.isConstructorDeclaration(node)) return "constructor";
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) || ts.isPropertyDeclaration(parent))
    return parent.name.getText(source);
  if (ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent))
    return parent.name.getText(source);
  return `<function@${line}>`;
}

function cyclomatic(body: ts.ConciseBody): number {
  let value = 1;
  const visit = (node: ts.Node): void => {
    if (node !== body && ts.isFunctionLike(node)) return;
    if (
      ts.isIfStatement(node) ||
      ts.isForStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isWhileStatement(node) ||
      ts.isDoStatement(node) ||
      ts.isCatchClause(node) ||
      ts.isCaseClause(node) ||
      ts.isConditionalExpression(node) ||
      (ts.isBinaryExpression(node) &&
        [
          ts.SyntaxKind.AmpersandAmpersandToken,
          ts.SyntaxKind.BarBarToken,
          ts.SyntaxKind.QuestionQuestionToken,
        ].includes(node.operatorToken.kind))
    )
      value++;
    ts.forEachChild(node, visit);
  };
  visit(body);
  return value;
}

function halsteadDifficulty(body: ts.ConciseBody, source: ts.SourceFile): number {
  const operators = new Map<string, number>();
  const operands = new Map<string, number>();
  const visit = (node: ts.Node): void => {
    if (node !== body && functionWithBody(node)) return;
    const children = node.getChildren(source);
    if (children.length) {
      for (const child of children) visit(child);
      return;
    }
    const target = OPERATOR_TOKENS.has(node.kind)
      ? operators
      : OPERAND_TOKENS.has(node.kind)
        ? operands
        : undefined;
    if (target) {
      const text = node.getText(source);
      target.set(text, (target.get(text) ?? 0) + 1);
    }
  };
  visit(body);
  const distinctOperators = operators.size;
  const distinctOperands = operands.size;
  const totalOperands = [...operands.values()].reduce((sum, count) => sum + count, 0);
  if (distinctOperators === 0 || distinctOperands === 0) return 0;
  return (distinctOperators / 2) * (totalOperands / distinctOperands);
}

function lineCoverage(lines: NativeLines["lines"], start: number, end: number): number {
  const executable = lines.filter((row) => row.line >= start && row.line <= end);
  if (executable.length === 0) return 0;
  return executable.filter((row) => row.hits > 0).length / executable.length;
}

export function measureTypescriptFunctions(
  path: string,
  text: string,
  coverage: NativeLines["lines"],
): FunctionMetrics[] {
  const source = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") || path.endsWith(".jsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const metrics: FunctionMetrics[] = [];
  const visit = (node: ts.Node): void => {
    if (functionWithBody(node)) {
      const start = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      const end = source.getLineAndCharacterOfPosition(node.end).line + 1;
      const complexity = cyclomatic(node.body);
      const covered = lineCoverage(coverage, start, end);
      metrics.push({
        path,
        symbol: functionName(node, source, start),
        line: start,
        endLine: end,
        cyclomatic: complexity,
        halsteadDifficulty: halsteadDifficulty(node.body, source),
        coverage: covered,
        crap: complexity ** 2 * (1 - covered) ** 3 + complexity,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return metrics;
}
