"""PostgreSQL-specific identity mapping, inserts and query workloads."""

import psycopg
from psycopg import sql

from .data import Dataset


COLUMNS = {
    "enclosures": ("enclosure_id", "name", "habitat_type", "area_sqm"),
    "employees": ("employee_id", "first_name", "last_name", "job_title", "email"),
    "animals": ("animal_id", "name", "birth_date", "enclosure_id", "parent_id"),
    "checkups": ("checkup_id", "animal_id", "employee_id", "checked_at", "notes"),
}
QUERIES = {
    "animal_count": "SELECT count(*) FROM animals",
    "animals_with_enclosures": """SELECT a.animal_id, a.name, e.name
        FROM animals a JOIN enclosures e USING (enclosure_id)
        ORDER BY a.animal_id LIMIT 1000""",
    "enclosure_population": """SELECT e.enclosure_id, count(a.animal_id)
        FROM enclosures e LEFT JOIN animals a USING (enclosure_id)
        GROUP BY e.enclosure_id""",
    "latest_checkup": """SELECT a.animal_id, max(c.checked_at)
        FROM animals a LEFT JOIN checkups c USING (animal_id)
        GROUP BY a.animal_id""",
    "animals_without_checkups": """SELECT a.animal_id FROM animals a
        WHERE NOT EXISTS (SELECT 1 FROM checkups c WHERE c.animal_id = a.animal_id)""",
}


class SchemaMismatchError(ValueError):
    """The connected database does not match the client's expected columns."""


class PostgresBackend:
    def __init__(self, dsn: str):
        self.connection = psycopg.connect(dsn, autocommit=True, connect_timeout=10)

    def prepare(self, data: Dataset) -> dict[str, list[tuple]]:
        self.validate_schema()
        # Reserve real identity values instead of assuming an empty database or
        # using MAX(id). nextval remains safe with concurrent writers.
        ids = {}
        for table, columns in COLUMNS.items():
            count = len(getattr(data, table))
            with self.connection.cursor() as cursor:
                cursor.execute(
                    "SELECT nextval(pg_get_serial_sequence(%s, %s)) FROM generate_series(1, %s)",
                    (table, columns[0], count),
                )
                ids[table] = [row[0] for row in cursor]
        mapped = {}
        for table in COLUMNS:
            mapped[table] = []
            for source in getattr(data, table):
                row = list(source)
                row[0] = ids[table][row[0] - 1]
                if table == "animals":
                    row[3] = ids["enclosures"][row[3] - 1]
                    row[4] = ids["animals"][row[4] - 1] if row[4] else None
                elif table == "checkups":
                    row[1] = ids["animals"][row[1] - 1]
                    row[2] = ids["employees"][row[2] - 1]
                mapped[table].append(tuple(row))
        return mapped

    def validate_schema(self) -> None:
        problems = []
        for table, expected in COLUMNS.items():
            # Resolve the same search_path used by the insert statements.
            actual = self.connection.execute(
                """SELECT attname FROM pg_attribute
                   WHERE attrelid = to_regclass(%s)
                     AND attnum > 0 AND NOT attisdropped""", (table,)
            ).fetchall()
            names = {row[0] for row in actual}
            missing = sorted(set(expected) - names)
            extra = sorted(names - set(expected))
            if missing:
                problems.append(f"{table}: missing columns {', '.join(missing)}")
            if extra:
                problems.append(f"{table}: unexpected columns {', '.join(extra)}")
        if problems:
            raise SchemaMismatchError(
                "Database schema does not match sql/01_schema.sql: " + "; ".join(problems)
                + ". Use the current schema in a new database, or run ./reset-db.sh "
                "from the repository root (deletes all stored zoo data)."
            )

    def insert(self, table: str, rows: list[tuple], method: str) -> None:
        columns = COLUMNS[table]
        names = sql.SQL(", ").join(map(sql.Identifier, columns))
        # One transaction per batch. Timed by the runner, including commit.
        with self.connection.transaction(), self.connection.cursor() as cursor:
            if method == "copy":
                statement = sql.SQL("COPY {} ({}) FROM STDIN").format(sql.Identifier(table), names)
                with cursor.copy(statement) as copy:
                    for row in rows:
                        copy.write_row(row)
            else:
                statement = sql.SQL("INSERT INTO {} ({}) OVERRIDING SYSTEM VALUE VALUES ({})").format(
                    sql.Identifier(table), names,
                    sql.SQL(", ").join(sql.Placeholder() for _ in columns),
                )
                if method == "executemany":
                    cursor.executemany(statement, rows)
                elif method == "single":
                    for row in rows:
                        cursor.execute(statement, row)
                else:
                    raise ValueError(f"Unsupported insert method: {method}")

    def analyze(self) -> None:
        for table in COLUMNS:
            self.connection.execute(sql.SQL("ANALYZE {}").format(sql.Identifier(table)))

    def query_names(self) -> list[str]:
        return list(QUERIES)

    def query(self, name: str) -> int:
        with self.connection.cursor() as cursor:
            cursor.execute(QUERIES[name])
            count = 0
            while rows := cursor.fetchmany(1000):
                count += len(rows)
            return count

    def counts(self) -> dict[str, int]:
        return {
            table: self.connection.execute(
                sql.SQL("SELECT count(*) FROM {}").format(sql.Identifier(table))
            ).fetchone()[0]
            for table in COLUMNS
        }

    def close(self) -> None:
        self.connection.close()
