CREATE TABLE `oauth_states` (
	`expiresAt` integer NOT NULL,
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
