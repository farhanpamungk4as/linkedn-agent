import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Lead } from "../leads/types.js";

export interface MessageTemplate {
  id: string;
  name: string;
  body: string;
  created_at: string;
  updated_at: string;
}

const variables = ["first_name", "name", "company", "job_title"] as const;
type TemplateVariables = Record<(typeof variables)[number], string>;

export function validateTemplate(body: string): void {
  if (!body.trim() || body.length > 4000) throw new Error("Template body must be 1–4000 characters");
  const remainder = body.replace(/{{\s*([^{}]+?)\s*}}/g, (_, key: string) => {
    if (!variables.includes(key as (typeof variables)[number])) throw new Error(`Unknown template variable: ${key}`);
    return "";
  });
  if (remainder.includes("{{") || remainder.includes("}}")) throw new Error("Malformed template variable");
}

export function renderTemplate(body: string, values: Partial<TemplateVariables>): string {
  validateTemplate(body);
  return body.replace(/{{\s*([^{}]+?)\s*}}/g, (_, key: string) => values[key as keyof TemplateVariables] ?? "");
}

export function valuesForLead(lead: Pick<Lead, "name" | "company" | "job_title">): TemplateVariables {
  return { first_name: lead.name.trim().split(/\s+/)[0] ?? "", name: lead.name,
    company: lead.company ?? "", job_title: lead.job_title ?? "" };
}

export class TemplateService {
  constructor(private readonly db: DatabaseSync) {}

  list(): MessageTemplate[] {
    return this.db.prepare("SELECT * FROM templates ORDER BY name COLLATE NOCASE").all() as unknown as MessageTemplate[];
  }
  get(id: string): MessageTemplate | undefined {
    return this.db.prepare("SELECT * FROM templates WHERE id = ?").get(id) as unknown as MessageTemplate | undefined;
  }
  create(input: { name: string; body: string }): MessageTemplate {
    const name = input.name.trim();
    if (!name || name.length > 100) throw new Error("Template name must be 1–100 characters");
    validateTemplate(input.body);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare("INSERT INTO templates (id, name, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, name, input.body.trim(), now, now);
    return this.get(id)!;
  }
  update(id: string, input: Partial<{ name: string; body: string }>): MessageTemplate {
    const current = this.get(id);
    if (!current) throw new Error(`Template not found: ${id}`);
    const name = input.name === undefined ? current.name : input.name.trim();
    const body = input.body === undefined ? current.body : input.body.trim();
    if (!name || name.length > 100) throw new Error("Template name must be 1–100 characters");
    validateTemplate(body);
    this.db.prepare("UPDATE templates SET name = ?, body = ?, updated_at = ? WHERE id = ?")
      .run(name, body, new Date().toISOString(), id);
    return this.get(id)!;
  }
  delete(id: string): void {
    if (!this.get(id)) throw new Error(`Template not found: ${id}`);
    const used = this.db.prepare("SELECT COUNT(*) AS count FROM leads WHERE template_id = ?").get(id) as { count: number };
    if (used.count) throw new Error("Template is assigned to leads; unassign it before deleting");
    this.db.prepare("DELETE FROM templates WHERE id = ?").run(id);
  }
  preview(id: string, values: Partial<TemplateVariables>): string {
    const template = this.get(id);
    if (!template) throw new Error(`Template not found: ${id}`);
    return renderTemplate(template.body, values);
  }
}
