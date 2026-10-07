import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface Activity {
  id: string;
  lead_id: string | null;
  event: string;
  message: string;
  created_at: string;
}

export class ActivityService {
  constructor(private readonly db: DatabaseSync) {}

  add(event: string, message: string, leadId: string | null = null): Activity {
    const item = { id: randomUUID(), lead_id: leadId, event, message, created_at: new Date().toISOString() };
    this.db.prepare("INSERT INTO activity_logs (id, lead_id, event, message, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(item.id, item.lead_id, item.event, item.message, item.created_at);
    return item;
  }

  list(leadId?: string, limit = 100): Activity[] {
    if (leadId) return this.db.prepare("SELECT * FROM activity_logs WHERE lead_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?")
      .all(leadId, limit) as unknown as Activity[];
    return this.db.prepare("SELECT * FROM activity_logs ORDER BY created_at DESC, rowid DESC LIMIT ?")
      .all(limit) as unknown as Activity[];
  }

  count(event: string, since?: string): number {
    const row = since
      ? this.db.prepare("SELECT COUNT(*) AS count FROM activity_logs WHERE event = ? AND created_at >= ?").get(event, since)
      : this.db.prepare("SELECT COUNT(*) AS count FROM activity_logs WHERE event = ?").get(event);
    return (row as { count: number }).count;
  }
}
