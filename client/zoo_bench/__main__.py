import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import platform
from time import perf_counter
from uuid import uuid4

import psycopg

from .data import generate
from .postgres import PostgresBackend, SchemaMismatchError
from .runner import measure, run


def positive(value: str) -> int:
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError("must be at least 1")
    return number


def nonnegative(value: str) -> int:
    number = int(value)
    if number < 0:
        raise argparse.ArgumentTypeError("must be at least 0")
    return number


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate and append zoo data, then benchmark PostgreSQL.")
    parser.add_argument("--animals", type=positive, default=1000)
    parser.add_argument("--checkups", type=nonnegative, default=1000)
    parser.add_argument("--enclosures", type=positive, default=20)
    parser.add_argument("--employees", type=positive, default=20)
    parser.add_argument("--batch-size", type=positive, default=1000)
    parser.add_argument("--method", choices=("single", "executemany", "copy"), default="executemany")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--repeats", type=positive, default=5)
    parser.add_argument("--warmups", type=nonnegative, default=1)
    parser.add_argument("--output", type=Path, help="JSON report path (default: results/<run-id>.json)")
    args = parser.parse_args()
    run_id = uuid4().hex
    output = args.output or Path("results") / f"{run_id}.json"
    # Check the output directory before inserting anything.
    output.parent.mkdir(parents=True, exist_ok=True)
    settings = vars(args).copy()
    settings.pop("output")
    report = {
        "run_id": run_id, "started_at": datetime.now(timezone.utc).isoformat(),
        "backend": "postgres", "python_version": platform.python_version(),
        "driver_version": psycopg.__version__, "settings": settings,
        "status": "running", "measurements": [], "inserts": {}, "queries": {},
    }
    # Exclusive creation prevents accidentally overwriting an earlier benchmark.
    with output.open("x", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2)
    backend = None
    start = perf_counter()
    try:
        data = measure(report, "generate", lambda: generate(
            args.enclosures, args.employees, args.animals, args.checkups, args.seed, run_id
        ), rows=args.enclosures + args.employees + args.animals + args.checkups)
        dsn = os.environ.get("DATABASE_URL") or psycopg.conninfo.make_conninfo(
            host=os.environ.get("PGHOST", "localhost"),
            port=os.environ.get("PGPORT", os.environ.get("POSTGRES_PORT", "5432")),
            dbname=os.environ.get("PGDATABASE", "zoo"),
            user=os.environ.get("PGUSER", "zoo"),
            password=os.environ.get("PGPASSWORD", os.environ.get("POSTGRES_PASSWORD", "zoo_local_password")),
        )
        backend = measure(report, "connect", lambda: PostgresBackend(dsn))
        report["server_version"] = backend.connection.info.server_version
        run(backend, data, report, args.batch_size, args.method, args.repeats, args.warmups)
        report["status"] = "completed"
    except (Exception, KeyboardInterrupt) as error:
        report["status"] = "failed"
        # Do not put connection strings, passwords or SQL data in the report.
        report["error_type"] = type(error).__name__
        if isinstance(error, psycopg.Error):
            report["sqlstate"] = error.sqlstate
            report["database_error"] = {
                "table": error.diag.table_name,
                "column": error.diag.column_name,
                "constraint": error.diag.constraint_name,
            }
        if isinstance(error, SchemaMismatchError):
            report["error_message"] = str(error)
            print(str(error))
        else:
            print(f"Benchmark failed ({type(error).__name__}). Check connection settings and schema.")
            if isinstance(error, psycopg.Error):
                print(f"Table: {error.diag.table_name}; column: {error.diag.column_name}; "
                      f"constraint: {error.diag.constraint_name}")
        print("Previously committed batches remain in the database; see the partial report.")
    finally:
        if backend is not None:
            backend.close()
        report["total_seconds"] = perf_counter() - start
        output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(f"Report: {output}")
    return 0 if report["status"] == "completed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
