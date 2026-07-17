CREATE TABLE `project_creation_limits` (
	`bucket` text PRIMARY KEY NOT NULL,
	`hits` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `project_creation_limits_expiry_idx` ON `project_creation_limits` (`expires_at`);