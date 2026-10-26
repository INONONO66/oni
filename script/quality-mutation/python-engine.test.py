"""Independent AST, row-count and effect oracles for the frozen Python worker."""
import ast
import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('mutation_engine', pathlib.Path(__file__).with_name('python-engine.py'))
if SPEC is None or SPEC.loader is None:
    raise RuntimeError('Python mutation engine module is unavailable')
ENGINE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ENGINE)
DECISION = json.loads(pathlib.Path(os.environ['QUALITY_MUTATION_DECISION']).read_text())
OPERATORS = DECISION['contract']['pythonSource']['mutation']['operators']


def rows(source, family):
    return [row for row in ENGINE.enumerate_nodes(source, ast.parse(source), OPERATORS) if row['operator'] == family]


def expressions(candidates):
    return [ast.unparse(ast.parse(row['replacement'], mode='eval')) for row in candidates]

def run_instrumented(source, site, marker):
    probe = ENGINE.instrument(source, ast.parse(source), site['start'], site['end'], str(marker))
    return subprocess.run([sys.executable, '-c', probe], capture_output=True, text=True, timeout=5)


class EngineTests(unittest.TestCase):
    def assert_probe_reached(self, source, site, expected):
        with tempfile.TemporaryDirectory() as directory:
            marker = pathlib.Path(directory) / 'hit'
            result = run_instrumented(source, site, marker)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, expected)
            self.assertEqual(marker.read_text(), '1')

    def test_nested_replacements_preserve_the_parent_ast(self):
        cases = [
            ('print(~(1 + 2) * 0)', 'py-unary', 'print((1 + 2) * 0)'),
            ('print(1 .real)', 'py-number', 'print((0).real)'),
            ('print(2 * (3 + 4))', 'py-arithmetic', 'print(2 / (3 + 4))'),
            ('print(2 * (3 + 4))', 'py-arithmetic', 'print(2 * (3 - 4))'),
            ('print(-(2 ** 3))', 'py-arithmetic', 'print(-(2 * 3))'),
            ('print((not (True and False)) == False)', 'py-unary', 'print((True and False) == False)'),
            ('async def run():\n    return (await (a if flag else b)).value', 'py-await', 'async def run():\n    return (a if flag else b).value'),
        ]
        for source, family, expected in cases:
            with self.subTest(source=source, expected=expected):
                generated = []
                for row in rows(source, family):
                    mutant = source[:row['startOffset']] + row['replacement'] + source[row['endOffset']:]
                    generated.append(ast.dump(ast.parse(mutant), include_attributes=False))
                self.assertIn(ast.dump(ast.parse(expected), include_attributes=False), generated)

    def test_literal_pattern_probe_preserves_grammar_and_lazy_evaluation(self):
        cases = [
            ("1", "1", True), ("0", "1", True),
            ("[0, 2]", "[1, 2]", False), ("[1, 2]", "[1, 2]", True),
            ("1", "1 | 2", False), ("2", "1 | 2", True),
            ("{}", "{'a': 2}", False), ("{'a': 2}", "{'a': 2}", True),
            ("-1", "-1", True), ("1+2j", "1+2j", True),
            ("{1: 'v'}", "{1: x}", True), ("{}", "{1: x}", False),
        ]
        for value, pattern, reached in cases:
            source = f"value = {value}\nmatch value:\n    case {pattern}:\n        print('matched')\nprint('done')\n"
            row = rows(source, 'py-number')[-1]
            with self.subTest(pattern=pattern, value=value), tempfile.TemporaryDirectory() as directory:
                marker = pathlib.Path(directory) / 'hit'
                site = row['site']
                probe = ENGINE.instrument(source, ast.parse(source), site['start'], site['end'], str(marker))
                original = subprocess.run([sys.executable, '-c', source], capture_output=True, text=True, timeout=5)
                result = subprocess.run([sys.executable, '-c', probe], capture_output=True, text=True, timeout=5)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout, original.stdout)
                self.assertEqual(marker.exists(), reached)

    def test_runtime(self):
        self.assertEqual(sys.version_info[:3], (3, 12, 12))

    def test_singleton_pattern_is_a_boolean_candidate(self):
        source = 'match True:\n    case True:\n        print("yes")\n'
        candidates = rows(source, 'py-boolean')
        self.assertEqual(len(candidates), 2)
        self.assertEqual(candidates[-1]['replacement'], 'False')
        self.assertEqual(source[candidates[-1]['startOffset']:candidates[-1]['endOffset']], 'True')

    def test_pattern_probe_preserves_subject_comparisons_guards_and_threads(self):
        source = '''"docstring"
from __future__ import annotations
from threading import Thread
effects = []
class Value:
    def __eq__(self, other):
        effects.append(('eq', other))
        return True
def subject():
    effects.append('subject')
    return Value()
def guard():
    effects.append('guard')
    return True
def run():
    match subject():
        case 7 if guard():
            effects.append('matched')
thread = Thread(target=run)
thread.start()
thread.join()
print(effects)
'''
        row = rows(source, 'py-number')[0]
        self.assert_probe_reached(source, row['site'], "['subject', ('eq', 7), 'guard', 'matched']\n")

    def test_all_comparison_replacements_and_census(self):
        source = '\n'.join(f'value = a {op} b' for op in ('==', '!=', 'is', 'is not', 'in', 'not in', '<', '<=', '>', '>='))
        equality = rows(source, 'py-equality')
        relational = rows(source, 'py-relational')
        self.assertEqual(len(equality), 6)
        self.assertEqual(len(relational), 8)
        self.assertEqual(expressions(equality), ['a != b', 'a == b', 'a is not b', 'a is b', 'a not in b', 'a in b'])
        self.assertEqual(expressions(relational), ['a <= b', 'a >= b', 'a < b', 'a > b', 'a >= b', 'a <= b', 'a > b', 'a < b'])

    def test_arithmetic_and_unary_replacement_census(self):
        arithmetic = rows('\n'.join(f'value = a {op} b' for op in ('+', '-', '*', '/', '//', '%', '**')), 'py-arithmetic')
        self.assertEqual(expressions(arithmetic), ['a - b', 'a + b', 'a / b', 'a * b', 'a / b', 'a * b', 'a * b'])
        unary = rows('a = not x\nb = +x\nc = -x\nd = ~x', 'py-unary')
        self.assertEqual(expressions(unary), ['x', '-x', '+x', 'x'])

    def test_docstrings_annotations_and_joined_strings(self):
        source = '"module doc"\nclass A:\n    "class doc"\n    value: "annotation"\ndef run(x: "type") -> "result":\n    "function doc"\n    return f"hello {x}"\n'
        self.assertEqual(expressions(rows(source, 'py-string')), ["''"])
        self.assertEqual(rows(source, 'py-expression-delete'), [])

    def test_container_string_numeric_census(self):
        self.assertEqual(expressions(rows('a=[1];b=(1,);c={1:2};d={1}', 'py-container')), ['[]', '()', '{}', '{*()}'])
        self.assertEqual(expressions(rows("a='x';b=b'x';c='';d=b''", 'py-string')), ["''", "b''", "'__d945_mutant__'", "b'__d945_mutant__'"])
        self.assertEqual(expressions(rows('a=0;b=1;c=0j;d=1j;e=True', 'py-number')), ['1', '0', '1', '0'])

    def test_comprehension_conditions_and_semantic_dedup(self):
        source = 'a=[x for x in items if x if valid(x)]\nb=1 if True else 2\n'
        all_rows = ENGINE.enumerate_nodes(source, ast.parse(source), OPERATORS)
        conditions = [r for r in all_rows if r['operator'] == 'py-condition']
        self.assertEqual(len(conditions), 5)
        identities = [(r['startOffset'], r['endOffset'], r['replacement']) for r in all_rows]
        self.assertEqual(len(identities), len(set(identities)))

    def test_utf16_source_identity(self):
        source = "prefix = '😀'; value = True\n"
        row = rows(source, 'py-boolean')[0]
        encoded = source.encode('utf-16-le')
        self.assertEqual(encoded[row['startOffset'] * 2:row['endOffset'] * 2].decode('utf-16-le'), 'True')

    def test_chained_comparison_probe_is_lazy(self):
        source = 'effects=[]\ndef right():\n    effects.append(1)\n    return 4\nvalue = 2 < 1 < right()\nprint(value, effects)\n'
        candidates = rows(source, 'py-relational')
        self.assertEqual(len(candidates), 4)
        with tempfile.TemporaryDirectory() as directory:
            marker = pathlib.Path(directory) / 'hit'
            site = candidates[-1]['site']
            result = run_instrumented(source, site, marker)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, 'False []\n')
            self.assertFalse(marker.exists())

    def test_probe_preserves_receiver_and_single_evaluation(self):
        source = 'effects=[]\nclass Value:\n    def run(self):\n        effects.append(1)\n        return True\nprint(Value().run(),effects)\n'
        row = rows(source, 'py-boolean')[0]
        self.assert_probe_reached(source, row['site'], 'True [1]\n')


if __name__ == '__main__':
    unittest.main()
