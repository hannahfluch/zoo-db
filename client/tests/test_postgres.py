"""Opt-in integration tests in a disposable schema, never existing zoo tables."""

import os
from pathlib import Path
import unittest
from uuid import uuid4

import psycopg
from psycopg import sql

from zoo_bench.data import generate
from zoo_bench.postgres import PostgresBackend, SchemaMismatchError


@unittest.skipUnless(os.environ.get("TEST_DATABASE_URL"), "set TEST_DATABASE_URL to run PostgreSQL tests")
class PostgresTests(unittest.TestCase):
    def setUp(self):
        self.backend = PostgresBackend(os.environ["TEST_DATABASE_URL"])
        self.schema = "bench_test_" + uuid4().hex
        connection = self.backend.connection
        connection.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(self.schema)))
        connection.execute(sql.SQL("SET search_path TO {}").format(sql.Identifier(self.schema)))
        schema_file = Path(__file__).resolve().parents[2] / "sql" / "01_schema.sql"
        connection.execute(schema_file.read_text())

    def tearDown(self):
        try:
            self.backend.connection.execute(
                sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(self.schema))
            )
        finally:
            self.backend.close()

    def test_modes_append_and_preserve_relationships(self):
        for index, method in enumerate(("single", "executemany", "copy"), start=1):
            data = generate(2, 3, 11, 13, 42, method)
            prepared = self.backend.prepare(data)
            for table, records in prepared.items():
                for offset in range(0, len(records), 4):
                    self.backend.insert(table, records[offset:offset + 4], method)
            self.assertEqual(self.backend.counts(), {
                "enclosures": 2 * index, "employees": 3 * index,
                "animals": 11 * index, "checkups": 13 * index,
            })
        count = self.backend.connection.execute("""SELECT count(*) FROM animals child
            JOIN animals parent ON child.parent_id = parent.animal_id
            WHERE parent.birth_date < child.birth_date
              AND parent.enclosure_id = child.enclosure_id""").fetchone()[0]
        self.assertEqual(count, 18)
        for name in self.backend.query_names():
            self.assertGreaterEqual(self.backend.query(name), 0)

    def test_failed_batch_rolls_back_for_every_mode(self):
        for method in ("single", "executemany", "copy"):
            with self.subTest(method=method):
                prepared = self.backend.prepare(generate(2, 1, 1, 0, 42, method))
                rows = prepared["enclosures"]
                # Two different IDs but the same unique name: entire batch must roll back.
                duplicate = (rows[1][0], rows[0][1], *rows[1][2:])
                with self.assertRaises(psycopg.errors.UniqueViolation):
                    self.backend.insert("enclosures", [rows[0], duplicate], method)
                self.assertEqual(self.backend.counts()["enclosures"], 0)

    def test_old_schema_rejected_before_reserving_ids(self):
        self.backend.connection.execute("ALTER TABLE enclosures ADD COLUMN location text NOT NULL")
        self.backend.connection.execute("ALTER TABLE animals ADD COLUMN species text NOT NULL")
        with self.assertRaises(SchemaMismatchError) as caught:
            self.backend.prepare(generate(1, 1, 1, 0, 42, "old-schema"))
        self.assertIn("enclosures: unexpected columns location", str(caught.exception))
        self.assertIn("animals: unexpected columns species", str(caught.exception))
        self.assertEqual(self.backend.counts()["enclosures"], 0)
        self.assertFalse(self.backend.connection.execute(
            "SELECT is_called FROM enclosures_enclosure_id_seq"
        ).fetchone()[0])


if __name__ == "__main__":
    unittest.main()
