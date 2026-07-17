CREATE TABLE `project_assets` (
	`project_id` text NOT NULL,
	`asset_id` text NOT NULL,
	`data_format` text NOT NULL,
	`asset_type` text NOT NULL,
	`data` blob NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`project_id`, `asset_id`)
);
--> statement-breakpoint
CREATE INDEX `project_assets_project_idx` ON `project_assets` (`project_id`);