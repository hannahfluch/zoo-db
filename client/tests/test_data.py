import unittest

from zoo_bench.data import generate


class GenerationTests(unittest.TestCase):
    def test_reproducible_and_valid_relationships(self):
        data = generate(3, 4, 101, 203, 42, "test")
        self.assertEqual(data, generate(3, 4, 101, 203, 42, "test"))
        self.assertEqual(len(data.animals), 101)
        self.assertEqual(len(data.checkups), 203)
        for animal_id, _, birth, enclosure, parent in data.animals:
            self.assertIn(enclosure, range(1, 4))
            if parent:
                self.assertLess(parent, animal_id)
                self.assertLess(data.animals[parent - 1][2], birth)
                self.assertEqual(data.animals[parent - 1][3], enclosure)
        for _, animal, employee, checked_at, _ in data.checkups:
            self.assertIn(employee, range(1, 5))
            self.assertLess(data.animals[animal - 1][2], checked_at.date())
        self.assertEqual(len({r[1] for r in data.enclosures}), 3)
        self.assertEqual(len({r[4] for r in data.employees}), 4)

    def test_minimal_dataset_and_invalid_counts(self):
        data = generate(1, 1, 1, 0, 1, "test")
        self.assertIsNone(data.animals[0][-1])
        self.assertEqual(data.checkups, [])
        with self.assertRaises(ValueError):
            generate(0, 1, 1, 0, 1, "test")


if __name__ == "__main__":
    unittest.main()
