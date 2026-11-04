import { z } from "zod";

export const entities = ["enclosures", "employees", "animals", "checkups"] as const;
export type Entity = typeof entities[number];
export const habitats = ["Savannah", "Grassland", "Coastal", "Tropical rainforest"] as const;
const text = (max: number) => z.string().trim().min(1).max(max);
const id = z.string().min(1).max(100);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(value);
  return !isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "Use a valid calendar date (YYYY-MM-DD)");
export const schemas = {
  enclosures: z.object({ name: text(100), habitatType: z.enum(habitats), areaSqm: z.number().positive().max(99999999.99).refine(n => Math.abs(n * 100 - Math.round(n * 100)) < 0.00001, "Use at most two decimal places") }).strict(),
  employees: z.object({ firstName: text(60), lastName: text(60), jobTitle: text(80), email: z.email().max(254) }).strict(),
  animals: z.object({ name: text(80), birthDate: date, enclosureId: id, parentId: id.nullable().default(null) }).strict(),
  checkups: z.object({ animalId: id, employeeId: id, checkedAt: z.iso.datetime({ offset: true }), notes: text(10000) }).strict(),
};
export type Input = Record<string, any>;
export type RecordData = Record<string, any> & { id: string };
export type ListOptions = { q: string; page: number; limit: number; animalId?: string; employeeId?: string; enclosureId?: string; parentId?: string };
export type Page = { items: RecordData[]; total: number; page: number; limit: number };
export interface Store {
  list(entity: Entity, options: ListOptions): Promise<Page>;
  get(entity: Entity, id: string): Promise<RecordData | null>;
  create(entity: Entity, input: Input): Promise<RecordData>;
  update(entity: Entity, id: string, input: Input): Promise<RecordData>;
  delete(entity: Entity, id: string): Promise<void>;
  stats(): Promise<Record<Entity, number>>;
  ping(): Promise<void>;
}
export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export const searchFields: Record<Entity, string[]> = {
  enclosures: ["name", "habitatType"],
  employees: ["firstName", "lastName", "jobTitle", "email"],
  animals: ["name", "enclosure.name", "parent.name"],
  checkups: ["notes", "animal.name", "employee.firstName", "employee.lastName"],
};
export function parseList(params: URLSearchParams): ListOptions {
  const integer = (key: string, fallback: number, max: number) => {
    const raw = params.get(key);
    if (raw === null) return fallback;
    if (!/^\d+$/.test(raw) || +raw < 1 || +raw > max) throw new HttpError(400, `Invalid ${key}`);
    return +raw;
  };
  const q = params.get("q")?.trim() || "";
  if (q.length > 200) throw new HttpError(400, "Search is limited to 200 characters");
  const options: ListOptions = { q, page: integer("page", 1, 10000000), limit: integer("limit", 20, 100) };
  for (const key of ["animalId", "employeeId", "enclosureId", "parentId"] as const) {
    const value = params.get(key);
    if (value !== null) { if (!value || value.length > 100) throw new HttpError(400, `Invalid ${key}`); options[key] = value; }
  }
  return options;
}
