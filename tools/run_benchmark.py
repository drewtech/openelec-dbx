"""Score a Genie Agent's benchmarks and write the result to JSON.

Eval-API backend (see docs/genie-spec.md's Free Edition gates — confirmed available on this
workspace). Runs every benchmark currently loaded on the space's `serialized_space.benchmarks`
(i.e. whatever was last deployed via `dbx bundle deploy`), polls to completion, then pulls
per-question assessment detail.

A Conversation-API fallback (start-conversation per question -> poll get-message -> pull
generated SQL -> execute gold SQL -> compare result sets locally) was the documented backup if
the eval API turned out to be unavailable. It wasn't needed here — gate passed — so it isn't
implemented. Add it as a second `--backend` if a future workspace lacks the eval API.

Shells out to the `databricks` CLI directly. Run it the same way `dbx` wraps calls to
`databricks` in this repo -- e.g.:

    op run --env-file=/home/drew/.env.1password -- python3 tools/run_benchmark.py \\
        <space_id> benchmarks/baseline.json

Usage: python tools/run_benchmark.py <space_id> <output_path> [--poll-interval SECONDS] [--timeout SECONDS]
"""

import argparse
import json
import subprocess
import sys
import time


def dbx(*args: str) -> dict:
    result = subprocess.run(
        ["databricks", *args, "-o", "json"],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"databricks {' '.join(args)} failed:\n{result.stderr}")
    return json.loads(result.stdout)


def run_benchmark(space_id: str, poll_interval: float, timeout: float) -> dict:
    print(f"Creating eval run for space {space_id}...", file=sys.stderr)
    run = dbx("genie", "genie-create-eval-run", space_id, "--json", "{}")
    eval_run_id = run["eval_run_id"]
    print(f"  eval_run_id: {eval_run_id}", file=sys.stderr)

    deadline = time.monotonic() + timeout
    while True:
        run = dbx("genie", "genie-get-eval-run", space_id, eval_run_id)
        status = run["eval_run_status"]
        print(
            f"  status={status} done={run.get('num_done')}/{run.get('num_questions')} "
            f"correct={run.get('num_correct')} needs_review={run.get('num_needs_review')}",
            file=sys.stderr,
        )
        if status in ("DONE", "FAILED", "CANCELLED"):
            break
        if time.monotonic() > deadline:
            raise TimeoutError(f"eval run {eval_run_id} did not finish within {timeout}s")
        time.sleep(poll_interval)

    results_list = dbx("genie", "genie-list-eval-results", space_id, eval_run_id)
    results = []
    for r in results_list.get("eval_results", []):
        detail = dbx(
            "genie", "genie-get-eval-result-details", space_id, eval_run_id, r["result_id"]
        )
        actual_sql = None
        for resp in detail.get("actual_response", []) or []:
            if resp.get("response_type") == "SQL":
                actual_sql = resp.get("response")
                break
        results.append(
            {
                "result_id": r["result_id"],
                "benchmark_question_id": r["benchmark_question_id"],
                "question": r["question"],
                "status": r["status"],
                "assessment": detail.get("assessment"),
                "manual_assessment": detail.get("manual_assessment"),
                "generated_sql": actual_sql,
            }
        )

    return {
        "space_id": space_id,
        "eval_run_id": eval_run_id,
        "eval_run_status": run["eval_run_status"],
        "created_timestamp": run.get("created_timestamp"),
        "num_questions": run.get("num_questions"),
        "num_correct": run.get("num_correct"),
        "num_needs_review": run.get("num_needs_review"),
        "results": results,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("space_id")
    parser.add_argument("output_path")
    parser.add_argument("--poll-interval", type=float, default=5.0)
    parser.add_argument("--timeout", type=float, default=600.0)
    args = parser.parse_args()

    output = run_benchmark(args.space_id, args.poll_interval, args.timeout)

    with open(args.output_path, "w") as f:
        json.dump(output, f, indent=2)
        f.write("\n")

    print(
        f"\n{args.output_path}: {output['num_correct']}/{output['num_questions']} correct "
        f"(eval_run_id={output['eval_run_id']})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
