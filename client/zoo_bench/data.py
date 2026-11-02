"""Database-independent records. IDs are local to this generated dataset."""

from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from random import Random


@dataclass
class Dataset:
    enclosures: list[tuple]
    employees: list[tuple]
    animals: list[tuple]
    checkups: list[tuple]


def generate(enclosures: int, employees: int, animals: int, checkups: int,
             seed: int, namespace: str) -> Dataset:
    """Return reproducible records for a seed and namespace, without database I/O."""
    if min(enclosures, employees, animals) < 1 or checkups < 0:
        raise ValueError("Enclosures, employees and animals must be positive; checkups cannot be negative")
    rng = Random(seed)
    habitats = ("Savannah", "Grassland", "Coastal", "Tropical rainforest")
    first_names = ("Emma", "Noah", "Olivia", "Liam", "Ava", "Leo")
    last_names = ("Carter", "Reed", "Brooks", "Parker", "Smith", "Taylor")
    enclosure_rows = [
        (i, f"Bench-{namespace}-{i}", rng.choice(habitats), rng.randint(100, 10000))
        for i in range(1, enclosures + 1)
    ]
    employee_rows = [
        (i, rng.choice(first_names), rng.choice(last_names),
         rng.choice(("Veterinarian", "Veterinary nurse", "Zookeeper")),
         f"bench-{namespace}-{i}@example.com")
        for i in range(1, employees + 1)
    ]
    # Children reference roots only: no cycles, with parents older than children
    # and living in the same enclosure.
    roots = max(1, animals // 2)
    animal_rows = []
    for i in range(1, animals + 1):
        parent = rng.randint(1, roots) if i > roots else None
        enclosure = animal_rows[parent - 1][3] if parent else rng.randint(1, enclosures)
        born = date(2020 if parent else 2000, 1, 1) + timedelta(days=rng.randrange(1800))
        animal_rows.append((i, f"Animal-{i}", born, enclosure, parent))
    checkup_rows = [
        (i, rng.randint(1, animals), rng.randint(1, employees),
         datetime(2025, 1, 1, tzinfo=timezone.utc) + timedelta(minutes=rng.randrange(500000)),
         rng.choice(("Routine examination; healthy.", "Weight checked.", "Follow-up completed.")))
        for i in range(1, checkups + 1)
    ]
    return Dataset(enclosure_rows, employee_rows, animal_rows, checkup_rows)
