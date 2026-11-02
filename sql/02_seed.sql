-- Run once after 01_schema.sql on an empty database.
-- Identity values are assigned in the order of these rows, starting at 1.
BEGIN;

INSERT INTO enclosures (name, habitat_type, area_sqm) VALUES
    ('Lion Savannah', 'Savannah', 2500.00),
    ('Elephant Plains', 'Grassland', 5000.00),
    ('Penguin Coast', 'Coastal', 800.00),
    ('Rainforest House', 'Tropical rainforest', 1200.00);

INSERT INTO employees (first_name, last_name, job_title, email) VALUES
    ('Emma', 'Carter', 'Veterinarian', 'emma.carter@example.com'),
    ('Noah', 'Reed', 'Veterinary nurse', 'noah.reed@example.com'),
    ('Olivia', 'Brooks', 'Veterinarian', 'olivia.brooks@example.com'),
    ('Liam', 'Parker', 'Zookeeper', 'liam.parker@example.com');

INSERT INTO animals (name, birth_date, enclosure_id, parent_id) VALUES
    ('Nala', '2015-04-12', 1, NULL),
    ('Amara', '2005-08-21', 2, NULL),
    ('Pippa', '2018-02-10', 3, NULL);

INSERT INTO animals (name, birth_date, enclosure_id, parent_id) VALUES
    ('Kito', '2022-06-15', 1, 1),
    ('Milo', '2023-07-03', 1, 1),
    ('Tembo', '2020-09-18', 2, 2),
    ('Pebble', '2024-03-07', 3, 3),
    ('Rio', '2021-05-22', 4, NULL);

INSERT INTO checkups (animal_id, employee_id, checked_at, notes) VALUES
    (1, 1, '2026-09-01 09:00:00+02', 'Routine examination; healthy.'),
    (2, 3, '2026-09-02 10:30:00+02', 'Feet and teeth examined; no concerns.'),
    (3, 2, '2026-09-03 08:45:00+02', 'Weight and plumage checked; healthy.'),
    (4, 1, '2026-09-04 11:00:00+02', 'Minor paw irritation; follow-up scheduled.'),
    (4, 1, '2026-09-18 11:00:00+02', 'Follow-up: paw irritation resolved.'),
    (6, 3, '2026-09-05 14:00:00+02', 'Routine growth assessment; healthy.'),
    (7, 2, '2026-09-06 09:15:00+02', 'Routine examination; healthy.'),
    (1, 3, '2026-10-01 09:00:00+02', 'Dental examination; no concerns.');

COMMIT;
