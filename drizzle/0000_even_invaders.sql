CREATE TABLE `comments` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`author` text NOT NULL,
	`color` text NOT NULL,
	`message` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `presence` (
	`project_id` text NOT NULL,
	`client_id` text NOT NULL,
	`name` text NOT NULL,
	`color` text NOT NULL,
	`cursor_x` integer DEFAULT 50 NOT NULL,
	`cursor_y` integer DEFAULT 50 NOT NULL,
	`last_seen` integer NOT NULL,
	PRIMARY KEY(`project_id`, `client_id`)
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`invite_token` text NOT NULL,
	`name` text NOT NULL,
	`state` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text NOT NULL
);
