BEGIN;

CREATE TYPE enclosure_type AS ENUM (
    'Savannah', 'Grassland', 'Coastal', 'Tropical rainforest'
);

CREATE TABLE enclosures (
    enclosure_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    habitat_type enclosure_type NOT NULL,
    area_sqm NUMERIC(10, 2) NOT NULL CHECK (area_sqm > 0)
);

CREATE TABLE employees (
    employee_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    first_name VARCHAR(60) NOT NULL,
    last_name VARCHAR(60) NOT NULL,
    job_title VARCHAR(80) NOT NULL,
    email VARCHAR(254) NOT NULL UNIQUE
);

CREATE TABLE animals (
    animal_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name VARCHAR(80) NOT NULL,
    birth_date DATE NOT NULL,
    enclosure_id INTEGER NOT NULL REFERENCES enclosures (enclosure_id) ON DELETE RESTRICT,
    parent_id INTEGER REFERENCES animals (animal_id) ON DELETE SET NULL,
    CONSTRAINT animal_not_own_parent CHECK (parent_id <> animal_id)
);

CREATE TABLE checkups (
    checkup_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    animal_id INTEGER NOT NULL REFERENCES animals (animal_id) ON DELETE CASCADE,
    employee_id INTEGER NOT NULL REFERENCES employees (employee_id) ON DELETE RESTRICT,
    checked_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    notes TEXT NOT NULL CHECK (btrim(notes) <> '')
);

COMMIT;
