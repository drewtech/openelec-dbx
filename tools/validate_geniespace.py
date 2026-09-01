"""Local pre-deploy validator for a Genie Agent `.geniespace.json` file.

Checks the rules documented in `docs/genie-spec.md`'s "Authoring model" section — real
documented rejections from the Genie Agent API, cheap to catch before a `bundle deploy`
round-trip. Not a schema validator for the whole surface, just the sharp edges that bite.

Usage: python tools/validate_geniespace.py [path/to/file.geniespace.json]
Defaults to resources/openelec.geniespace.json.
"""

import json
import re
import sys
from pathlib import Path

HEX32 = re.compile(r"^[0-9a-f]{32}$")


class ValidationError(Exception):
    pass


def _err(msg: str, errors: list[str]) -> None:
    errors.append(msg)


def _require_string_array(value, path: str, errors: list[str]) -> None:
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        _err(f"{path} must be an array of strings, got {value!r}", errors)


def validate(space: dict) -> list[str]:
    errors: list[str] = []

    # version == 2
    if space.get("version") != 2:
        _err(f"version must be 2, got {space.get('version')!r}", errors)

    # Collect every id across sample_questions, example_question_sqls,
    # text_instructions, and benchmarks.questions — must be 32-char lowercase hex,
    # unique across all four lists combined.
    sample_questions = space.get("config", {}).get("sample_questions", [])
    example_sqls = space.get("instructions", {}).get("example_question_sqls", [])
    text_instructions = space.get("instructions", {}).get("text_instructions", [])
    benchmark_questions = space.get("benchmarks", {}).get("questions", [])

    all_ids: dict[str, list[str]] = {}  # id -> list of source list names, to catch dupes
    for list_name, items in (
        ("config.sample_questions", sample_questions),
        ("instructions.example_question_sqls", example_sqls),
        ("instructions.text_instructions", text_instructions),
        ("benchmarks.questions", benchmark_questions),
    ):
        for i, item in enumerate(items):
            item_id = item.get("id")
            if not isinstance(item_id, str) or not HEX32.match(item_id):
                _err(
                    f"{list_name}[{i}].id must be 32-char lowercase hex, got {item_id!r}",
                    errors,
                )
            else:
                all_ids.setdefault(item_id, []).append(list_name)

    for item_id, sources in all_ids.items():
        if len(sources) > 1:
            _err(
                f"id {item_id!r} is not unique across sample_questions/example_question_sqls/"
                f"text_instructions/benchmarks — used in {sources}",
                errors,
            )

    # question/sql/content must be arrays of strings, never bare strings
    for i, item in enumerate(sample_questions):
        _require_string_array(item.get("question"), f"config.sample_questions[{i}].question", errors)

    for i, item in enumerate(example_sqls):
        _require_string_array(item.get("question"), f"instructions.example_question_sqls[{i}].question", errors)
        _require_string_array(item.get("sql"), f"instructions.example_question_sqls[{i}].sql", errors)

    for i, item in enumerate(text_instructions):
        _require_string_array(item.get("content"), f"instructions.text_instructions[{i}].content", errors)

    for i, item in enumerate(benchmark_questions):
        _require_string_array(item.get("question"), f"benchmarks.questions[{i}].question", errors)
        for j, ans in enumerate(item.get("answer", [])):
            if ans.get("format") == "SQL":
                _require_string_array(
                    ans.get("content"), f"benchmarks.questions[{i}].answer[{j}].content", errors
                )

    # data_sources.tables sorted by identifier; each table's column_configs sorted
    # by column_name
    tables = space.get("data_sources", {}).get("tables", [])
    identifiers = [t.get("identifier") for t in tables]
    if identifiers != sorted(identifiers):
        _err(
            f"data_sources.tables must be sorted by identifier — got {identifiers}, "
            f"expected {sorted(identifiers)}",
            errors,
        )
    for t in tables:
        cols = t.get("column_configs", [])
        names = [c.get("column_name") for c in cols]
        if names != sorted(names):
            _err(
                f"data_sources.tables[{t.get('identifier')}].column_configs must be sorted "
                f"by column_name — got {names}",
                errors,
            )
        for c in cols:
            if "synonyms" in c:
                # Confirmed shape via deploy trial-and-error (undocumented in the
                # skill): a flat array of alternate terms for the column, NOT a
                # value->synonyms map. `{"value": ..., "synonyms": [...]}` is
                # rejected ("Expected Scalar value for String field 'synonyms'").
                _require_string_array(
                    c.get("synonyms"),
                    f"data_sources.tables[{t.get('identifier')}].column_configs"
                    f"[{c.get('column_name')}].synonyms",
                    errors,
                )

    # example_question_sqls and text_instructions sorted by id
    for list_name, items in (
        ("instructions.example_question_sqls", example_sqls),
        ("instructions.text_instructions", text_instructions),
    ):
        ids = [item.get("id") for item in items]
        if ids != sorted(ids):
            _err(f"{list_name} must be sorted by id — got {ids}", errors)

    # len(text_instructions) <= 1
    if len(text_instructions) > 1:
        _err(
            f"text_instructions must contain at most one item, got {len(text_instructions)} — "
            "merge into a single entry",
            errors,
        )

    # len(data_sources.tables) <= 30
    if len(tables) > 30:
        _err(f"data_sources.tables must have at most 30 entries, got {len(tables)}", errors)

    return errors


def main() -> int:
    path = Path(sys.argv[1] if len(sys.argv) > 1 else "resources/openelec.geniespace.json")
    if not path.exists():
        print(f"error: {path} does not exist", file=sys.stderr)
        return 2

    space = json.loads(path.read_text())
    errors = validate(space)

    if errors:
        print(f"{path}: {len(errors)} error(s):")
        for e in errors:
            print(f"  - {e}")
        return 1

    n_tables = len(space.get("data_sources", {}).get("tables", []))
    n_benchmarks = len(space.get("benchmarks", {}).get("questions", []))
    n_examples = len(space.get("instructions", {}).get("example_question_sqls", []))
    n_text = len(space.get("instructions", {}).get("text_instructions", []))
    print(
        f"{path}: OK — {n_tables} tables, {n_benchmarks} benchmarks, "
        f"{n_examples} example SQLs, {n_text} text instructions"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
