"""Backend-independent timing and report collection."""

from statistics import median
from time import perf_counter

from .backend import Backend
from .data import Dataset


def measure(report: dict, name: str, action, *, rows: int | None = None):
    start = perf_counter()
    try:
        result = action()
    except Exception:
        report["measurements"].append({"operation": name, "seconds": perf_counter() - start,
                                       "status": "failed"})
        raise
    elapsed = perf_counter() - start
    entry = {"operation": name, "seconds": elapsed, "status": "ok"}
    if rows is not None:
        entry.update(rows=rows, rows_per_second=rows / elapsed if elapsed else None)
    report["measurements"].append(entry)
    return result


def run(backend: Backend, data: Dataset, report: dict, batch_size: int,
        method: str, repeats: int, warmups: int) -> None:
    report["counts_before"] = backend.counts()
    prepared = measure(report, "prepare_ids_and_records", lambda: backend.prepare(data))
    for table, records in prepared.items():
        batch_times = []
        for offset in range(0, len(records), batch_size):
            batch = records[offset:offset + batch_size]
            measure(report, f"insert.{table}", lambda: backend.insert(table, batch, method), rows=len(batch))
            batch_times.append(report["measurements"][-1]["seconds"])
        total = sum(batch_times)
        report["inserts"][table] = {
            "rows": len(records), "batches": len(batch_times), "seconds": total,
            "rows_per_second": len(records) / total if total else None,
        }
        print(f"Inserted {len(records):,} {table} in {total:.3f}s", flush=True)
    report["counts_after"] = backend.counts()
    measure(report, "analyze", backend.analyze)
    for name in backend.query_names():
        for _ in range(warmups):
            backend.query(name)
        samples = []
        returned = []
        for _ in range(repeats):
            returned.append(measure(report, f"query.{name}", lambda: backend.query(name)))
            report["measurements"][-1]["result_rows"] = returned[-1]
            samples.append(report["measurements"][-1]["seconds"])
        report["queries"][name] = {
            "samples_seconds": samples, "min_seconds": min(samples),
            "median_seconds": median(samples), "max_seconds": max(samples),
            "result_rows": returned,
        }
        print(f"Query {name}: median {median(samples):.6f}s ({returned[-1]:,} result rows)", flush=True)
