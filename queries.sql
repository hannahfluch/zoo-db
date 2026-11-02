-- 1. Animals and their enclosures.
SELECT a.animal_id, a.name, a.birth_date, e.name AS enclosure
FROM animals AS a
JOIN enclosures AS e USING (enclosure_id)
ORDER BY a.animal_id;

-- 2. Animals and their recorded parent (including unknown parents).
SELECT child.name AS animal, parent.name AS parent
FROM animals AS child
LEFT JOIN animals AS parent ON parent.animal_id = child.parent_id
ORDER BY child.animal_id;

-- 3. Checkup history with the responsible employee.
SELECT c.checkup_id, a.name AS animal, c.checked_at,
       concat_ws(' ', e.first_name, e.last_name) AS employee, c.notes
FROM checkups AS c
JOIN animals AS a USING (animal_id)
JOIN employees AS e USING (employee_id)
ORDER BY c.checked_at DESC, c.checkup_id DESC;

-- 4. Number of animals in each enclosure, including empty enclosures.
SELECT e.name AS enclosure, COUNT(a.animal_id) AS animal_count
FROM enclosures AS e
LEFT JOIN animals AS a USING (enclosure_id)
GROUP BY e.enclosure_id, e.name
ORDER BY e.name;

-- 5. Animals without any checkup (Milo and Rio in the sample data).
SELECT a.animal_id, a.name
FROM animals AS a
WHERE NOT EXISTS (SELECT 1 FROM checkups AS c WHERE c.animal_id = a.animal_id)
ORDER BY a.animal_id;

-- 6. Latest checkup per animal; NULL means no checkup yet.
SELECT a.name AS animal, MAX(c.checked_at) AS last_checkup
FROM animals AS a
LEFT JOIN checkups AS c USING (animal_id)
GROUP BY a.animal_id, a.name
ORDER BY a.animal_id;

-- 7. Number of checkups performed by each employee, including zero.
SELECT e.first_name, e.last_name, COUNT(c.checkup_id) AS checkup_count
FROM employees AS e
LEFT JOIN checkups AS c USING (employee_id)
GROUP BY e.employee_id, e.first_name, e.last_name
ORDER BY checkup_count DESC, e.employee_id;
