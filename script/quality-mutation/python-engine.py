"""Frozen d945-python-mutation@1 AST worker; stdout is one JSON receipt."""
import argparse
import ast
import copy
import hashlib
import json
import pathlib
import sys
from collections.abc import Callable, Iterable
from typing import Literal, NotRequired, TypeGuard, TypedDict, override


class Site(TypedDict):
    start: int
    end: int
    mode: Literal['python-statement', 'python-expression']


class Candidate(TypedDict):
    operator: str
    startOffset: int
    endOffset: int
    replacement: str
    site: Site


class Receipt(TypedDict):
    valid: bool
    version: str
    astNodes: int
    candidates: NotRequired[list[Candidate]]
    source: NotRequired[str]


class Operator(TypedDict):
    id: str
    replacements: dict[str, list[str]]


def object_list(value: object) -> TypeGuard[list[object]]:
    return isinstance(value, list)


def ast_fields(iterator: Iterable[tuple[str, object]]) -> Iterable[tuple[str, object]]:
    return iterator


def span(source: str, node: ast.expr | ast.stmt | ast.pattern) -> tuple[int, int]:
    lines = source.splitlines(keepends=True)
    def offset(line: int, column: int) -> int:
        prefix = ''.join(lines[:line - 1]) + lines[line - 1].encode()[:column].decode()
        return len(prefix.encode('utf-16-le')) // 2
    end_line, end_column = node.end_lineno, node.end_col_offset
    if end_line is None or end_column is None:
        raise ValueError('AST node has no end position')
    return offset(node.lineno, node.col_offset), offset(end_line, end_column)


def enumerate_nodes(source: str, tree: ast.Module, operators: list[Operator]) -> list[Candidate]:
    rows: list[Candidate] = []
    seen: set[tuple[int, int, str]] = set()
    mappings = {row['id']: row['replacements'] for row in operators}
    symbols: dict[type[ast.operator] | type[ast.boolop] | type[ast.cmpop], str] = {
        ast.Eq: '==', ast.NotEq: '!=', ast.Is: 'is', ast.IsNot: 'is not',
        ast.In: 'in', ast.NotIn: 'not in', ast.Lt: '<', ast.LtE: '<=',
        ast.Gt: '>', ast.GtE: '>=', ast.Add: '+', ast.Sub: '-', ast.Mult: '*',
        ast.Div: '/', ast.FloorDiv: '//', ast.Mod: '%', ast.Pow: '**',
        ast.And: 'and', ast.Or: 'or',
    }
    comparisons = {symbol: kind for kind, symbol in symbols.items() if issubclass(kind, ast.cmpop)}
    arithmetic = {symbol: kind for kind, symbol in symbols.items() if issubclass(kind, ast.operator)}
    logical = {symbol: kind for kind, symbol in symbols.items() if issubclass(kind, ast.boolop)}
    pattern_nodes = {child for node in ast.walk(tree) if isinstance(node, ast.pattern)
                     for child in ast.walk(node)}

    def add(family: str, node: ast.expr | ast.stmt | ast.pattern, replacement: ast.AST,
            site: ast.expr | ast.stmt | None = None) -> None:
        start, end = span(source, node)
        rendered = ast.unparse(replacement)
        # Detached expressions need grouping when spliced into their parent.
        # Patterns have a separate literal grammar: parentheses there can be
        # illegal (notably signed/complex values), so retain literal syntax.
        if isinstance(replacement, ast.expr) and node not in pattern_nodes:
            rendered = f'({rendered})'
        # Exclude semantic AST no-ops, not merely formatting differences.
        if ast.dump(node, include_attributes=False) == ast.dump(replacement, include_attributes=False):
            return
        key = (start, end, rendered)
        if key in seen:
            return
        seen.add(key)
        point = site if site is not None else node
        site_start, site_end = span(source, point)
        rows.append({'operator': family, 'startOffset': start, 'endOffset': end,
                     'replacement': rendered,
                     'site': {'start': site_start, 'end': site_end,
                              'mode': 'python-statement' if isinstance(point, ast.stmt) else 'python-expression'}})

    def literals(node: ast.AST) -> None:
        if isinstance(node, ast.Constant):
            value = node.value
            if isinstance(value, bool):
                add('py-boolean', node, ast.Constant(not value))
            elif isinstance(value, (int, float, complex)):
                add('py-number', node, ast.Constant(1 if value == 0 else 0))
            elif isinstance(value, (str, bytes)):
                value_type = type(value)
                add('py-string', node, ast.Constant(value_type() if value else (b'__d945_mutant__' if value_type is bytes else '__d945_mutant__')))
        if isinstance(node, ast.JoinedStr):
            add('py-string', node, ast.Constant(''))
        if isinstance(node, ast.MatchSingleton) and isinstance(node.value, bool):
            add('py-boolean', node, ast.MatchSingleton(not node.value))

    def replace_operation(node: ast.BinOp | ast.BoolOp | ast.Compare,
                          index: int, replacement: str) -> ast.expr:
        changed = copy.deepcopy(node)
        if isinstance(changed, ast.Compare):
            changed.ops[index] = comparisons[replacement]()
        elif isinstance(changed, ast.BinOp):
            changed.op = arithmetic[replacement]()
        else:
            changed.op = logical[replacement]()
        return changed

    def operations(node: ast.AST) -> None:
        if not isinstance(node, (ast.BinOp, ast.BoolOp, ast.Compare)):
            return
        operations = node.ops if isinstance(node, ast.Compare) else [node.op]
        for index, operation in enumerate(operations):
            symbol = symbols.get(type(operation))
            if symbol is None:
                continue
            site = node.comparators[index] if isinstance(node, ast.Compare) else node
            for family in ('py-equality', 'py-relational', 'py-arithmetic', 'py-logical'):
                for replacement in mappings[family].get(symbol, []):
                    add(family, node, replace_operation(node, index, replacement), site)

    def unary_and_conditions(node: ast.AST) -> None:
        if isinstance(node, ast.UnaryOp):
            if isinstance(node.op, (ast.Not, ast.Invert)):
                changed = node.operand
            elif isinstance(node.op, ast.UAdd):
                changed = ast.UnaryOp(ast.USub(), node.operand)
            else:
                changed = ast.UnaryOp(ast.UAdd(), node.operand)
            add('py-unary', node, changed)
        if isinstance(node, (ast.If, ast.While, ast.IfExp)):
            for value in (True, False):
                add('py-condition', node.test, ast.Constant(value))
        if isinstance(node, ast.comprehension):
            for condition in node.ifs:
                for value in (True, False):
                    add('py-condition', condition, ast.Constant(value))

    def statements(node: ast.AST) -> None:
        if isinstance(node, ast.Expr):
            add('py-expression-delete', node, ast.Pass())
        if isinstance(node, ast.Return) and node.value is not None:
            add('py-return', node.value, ast.Constant(None))
        if isinstance(node, ast.Raise) and node.exc is not None:
            add('py-raise', node, ast.Pass())
        if isinstance(node, ast.Assert):
            add('py-assert', node, ast.Pass())
        if isinstance(node, ast.Await):
            add('py-await', node, node.value)

    def containers(node: ast.AST) -> None:
        if isinstance(node, (ast.List, ast.Tuple, ast.Set, ast.Dict)):
            contents = node.keys if isinstance(node, ast.Dict) else node.elts
            if contents and (isinstance(node, (ast.Dict, ast.Set)) or isinstance(node.ctx, ast.Load)):
                changed = copy.deepcopy(node)
                if isinstance(changed, ast.Dict):
                    changed.keys, changed.values = [], []
                else:
                    changed.elts = []
                add('py-container', node, changed)

    def is_docstring(node: ast.AST, field: str, index: int, child: ast.AST) -> bool:
        return (field == 'body' and index == 0 and
                isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)) and
                isinstance(child, ast.Expr) and isinstance(child.value, ast.Constant) and
                isinstance(child.value.value, str))

    def children(node: ast.AST) -> None:
        for field, value in ast_fields(ast.iter_fields(node)):
            if field in ('annotation', 'returns', 'type_params'):
                continue
            values = value if object_list(value) else [value]
            for index, child in enumerate(values):
                if not isinstance(child, ast.AST):
                    continue
                is_doc = is_docstring(node, field, index, child)
                if isinstance(node, ast.JoinedStr) and isinstance(child, ast.Constant):
                    continue
                visit(child, is_doc)

    def visit(node: ast.AST, docstring: bool = False) -> None:
        if docstring or isinstance(node, ast.TypeAlias):
            return
        literals(node)
        operations(node)
        unary_and_conditions(node)
        statements(node)
        containers(node)
        children(node)

    visit(tree)
    return rows


def instrument(source: str, tree: ast.Module, start: int, end: int, marker: str) -> str:
    patterns = [node for node in ast.walk(tree) if isinstance(node, (ast.MatchValue, ast.MatchSingleton, ast.MatchMapping))]
    for index, pattern in enumerate(patterns):
        values = pattern.keys if isinstance(pattern, ast.MatchMapping) else [pattern]
        if any(isinstance(node, (ast.expr, ast.pattern)) and span(source, node) == (start, end)
               for value in values for node in ast.walk(value)):
            # Observe the real matching instruction, not an expression injected
            # into literal grammar. No comparison, subject or guard is repeated.
            return pattern_probe(tree, index, marker)
    probe = ast.parse(f"__import__('pathlib').Path({marker!r}).write_text('1')", mode='eval').body
    matches: list[ast.AST] = []
    class Probe(ast.NodeTransformer):
        @override
        def visit(self, node: ast.AST) -> ast.AST | list[ast.AST]:
            if isinstance(node, (ast.expr, ast.stmt)) and span(source, node) == (start, end):
                matches.append(node)
                if isinstance(node, ast.stmt):
                    return [ast.Expr(copy.deepcopy(probe)), node]
                return ast.Subscript(ast.Tuple([copy.deepcopy(probe), node], ast.Load()), ast.Constant(1), ast.Load())
            return super().generic_visit(node)
    _ = Probe().generic_visit(tree)
    if len(matches) != 1:
        raise ValueError(f'expected one probe site, got {len(matches)}')
    result = ast.fix_missing_locations(tree)
    _ = compile(result, '<mutation-probe>', 'exec')
    return ast.unparse(result)


def pattern_probe(tree: ast.Module, index: int, marker: str) -> str:
    payload = ast.Constant('')
    setup = ast.Expr(ast.Call(ast.Name('exec', ast.Load()), [payload, ast.Dict([], [])], []))
    insertion = 0
    for statement in tree.body:
        if (isinstance(statement, ast.ImportFrom) and statement.module == '__future__' or
                insertion == 0 and isinstance(statement, ast.Expr) and
                isinstance(statement.value, ast.Constant) and isinstance(statement.value.value, str)):
            insertion += 1
        else:
            break
    tree.body.insert(insertion, setup)
    rendered = ast.unparse(ast.fix_missing_locations(tree))
    patterns = [node for node in ast.walk(ast.parse(rendered))
                if isinstance(node, (ast.MatchValue, ast.MatchSingleton, ast.MatchMapping))]
    pattern = patterns[index]
    position = (pattern.lineno, pattern.end_lineno, pattern.col_offset, pattern.end_col_offset)
    opcode = 'MATCH_KEYS' if isinstance(pattern, ast.MatchMapping) else 'LOAD_CONST'
    bootstrap = f'''import atexit, dis, pathlib, sys, types
monitor = sys.monitoring
tool = next((item for item in range(6) if monitor.get_tool(item) is None), None)
if tool is None:
    raise RuntimeError('No monitoring slot for mutation pattern probe')
sites = {{}}
def collect(code):
    offsets = {{instruction.offset for instruction in dis.get_instructions(code)
               if instruction.opname == {opcode!r} and tuple(instruction.positions) == {position!r}}}
    if offsets:
        sites[code] = offsets
    for constant in code.co_consts:
        if isinstance(constant, types.CodeType):
            collect(constant)
collect(sys._getframe(1).f_code)
if not sites:
    raise RuntimeError('Unmapped mutation pattern instruction')
def hit(code, offset):
    if offset in sites[code]:
        pathlib.Path({marker!r}).write_text('1')
        return monitor.DISABLE
monitor.use_tool_id(tool, 'd945-pattern')
monitor.register_callback(tool, monitor.events.INSTRUCTION, hit)
for code in sites:
    monitor.set_local_events(tool, code, monitor.events.INSTRUCTION)
def cleanup():
    for code in sites:
        monitor.set_local_events(tool, code, 0)
    monitor.register_callback(tool, monitor.events.INSTRUCTION, None)
    monitor.free_tool_id(tool)
atexit.register(cleanup)
'''
    payload.value = bootstrap
    return ast.unparse(tree)


class Arguments(argparse.Namespace):
    source: str = ''
    decision: str = ''
    mode: str = ''
    start: int = 0
    end: int = 0
    marker: str = ''


def mutation_contract(decoder: Callable[[str], dict[str, dict[str, dict[str, dict[str, object]]]]], text: str) -> dict[str, object]:
    return decoder(text)['contract']['pythonSource']['mutation']


def operator_contract(decoder: Callable[[str], list[Operator]], text: str) -> list[Operator]:
    return decoder(text)


def main() -> int:
    parser = argparse.ArgumentParser()
    _ = parser.add_argument('--source', required=True)
    _ = parser.add_argument('--decision', required=True)
    _ = parser.add_argument('--mode', choices=['enumerate', 'compile', 'probe'], required=True)
    _ = parser.add_argument('--start', type=int)
    _ = parser.add_argument('--end', type=int)
    _ = parser.add_argument('--marker')
    args = parser.parse_args(namespace=Arguments())
    if sys.version_info[:3] != (3, 12, 12):
        raise ValueError('Requires CPython 3.12.12')
    source = pathlib.Path(args.source).read_bytes().decode('utf-8')
    mutation = mutation_contract(json.loads, pathlib.Path(args.decision).read_text())
    digest = hashlib.sha256(json.dumps(mutation, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
    if digest != 'ecf981eba68b4a907c13f909c850538609829042fd682f90c2c58d0aa01f7eaa':
        raise ValueError('Frozen Python operator contract changed')
    try:
        tree = ast.parse(source)
        _ = compile(tree, args.source, 'exec')
    except (SyntaxError, ValueError) as error:
        print(json.dumps({'valid': False, 'diagnostic': str(error), 'candidates': []}))
        return 1
    result: Receipt = {'valid': True, 'version': sys.version.split()[0], 'astNodes': sum(1 for _ in ast.walk(tree))}
    if args.mode == 'enumerate':
        operators = operator_contract(json.loads, json.dumps(mutation['operators']))
        result['candidates'] = enumerate_nodes(source, tree, operators)
    elif args.mode == 'probe':
        result['source'] = instrument(source, tree, args.start, args.end, args.marker)
    print(json.dumps(result))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(json.dumps({'valid': False, 'error': str(error)}))
        sys.exit(2)
