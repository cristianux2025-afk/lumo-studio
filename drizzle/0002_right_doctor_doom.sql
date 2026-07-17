CREATE INDEX `comments_project_created_idx` ON `comments` (`project_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `presence_project_seen_idx` ON `presence` (`project_id`,`last_seen`);--> statement-breakpoint
CREATE UNIQUE INDEX `project_events_client_seq_idx` ON `project_events` (`project_id`,`client_id`,`client_seq`);--> statement-breakpoint
CREATE INDEX `project_events_project_seq_idx` ON `project_events` (`project_id`,`seq`);