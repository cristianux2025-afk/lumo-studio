import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  inviteToken: text("invite_token").notNull(),
  name: text("name").notNull(),
  state: text("state").notNull(),
  version: integer("version").notNull().default(1),
  updatedAt: integer("updated_at").notNull(),
  updatedBy: text("updated_by").notNull(),
});

export const presence = sqliteTable(
  "presence",
  {
    projectId: text("project_id").notNull(),
    clientId: text("client_id").notNull(),
    name: text("name").notNull(),
    color: text("color").notNull(),
    cursorX: integer("cursor_x").notNull().default(50),
    cursorY: integer("cursor_y").notNull().default(50),
    lastSeen: integer("last_seen").notNull(),
  },
  (table) => [primaryKey({ columns: [table.projectId, table.clientId] })],
);

export const comments = sqliteTable("comments", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  author: text("author").notNull(),
  color: text("color").notNull(),
  message: text("message").notNull(),
  createdAt: integer("created_at").notNull(),
});
