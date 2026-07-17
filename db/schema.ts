import { blob, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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
  (table) => [
    primaryKey({ columns: [table.projectId, table.clientId] }),
    index("presence_project_seen_idx").on(table.projectId, table.lastSeen),
  ],
);

export const comments = sqliteTable(
  "comments",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    author: text("author").notNull(),
    color: text("color").notNull(),
    message: text("message").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("comments_project_created_idx").on(table.projectId, table.createdAt)],
);

export const profiles = sqliteTable("profiles", {
  email: text("email").primaryKey(),
  handle: text("handle").notNull().unique(),
  displayName: text("display_name").notNull(),
  avatarColor: text("avatar_color").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const projectEvents = sqliteTable(
  "project_events",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    projectId: text("project_id").notNull(),
    clientId: text("client_id").notNull(),
    clientSeq: integer("client_seq").notNull(),
    payload: text("payload").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("project_events_client_seq_idx").on(table.projectId, table.clientId, table.clientSeq),
    index("project_events_project_seq_idx").on(table.projectId, table.seq),
  ],
);

export const projectAssets = sqliteTable(
  "project_assets",
  {
    projectId: text("project_id").notNull(),
    assetId: text("asset_id").notNull(),
    dataFormat: text("data_format").notNull(),
    assetType: text("asset_type").notNull(),
    data: blob("data", {mode: "buffer"}).notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({columns: [table.projectId, table.assetId]}),
    index("project_assets_project_idx").on(table.projectId),
  ],
);

export const projectCreationLimits = sqliteTable(
  "project_creation_limits",
  {
    bucket: text("bucket").primaryKey(),
    hits: integer("hits").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [index("project_creation_limits_expiry_idx").on(table.expiresAt)],
);
