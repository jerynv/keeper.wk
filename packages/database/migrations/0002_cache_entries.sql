CREATE TABLE `cache_entries` (
	`expiresAt` integer NOT NULL,
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
