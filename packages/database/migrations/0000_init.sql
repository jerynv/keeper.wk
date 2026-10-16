CREATE TABLE `caldav_credentials` (
	`authMethod` text DEFAULT 'basic' NOT NULL,
	`createdAt` integer NOT NULL,
	`encryptedPassword` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`serverUrl` text NOT NULL,
	`updatedAt` integer NOT NULL,
	`username` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `calendar_accounts` (
	`accountId` text,
	`authType` text NOT NULL,
	`caldavCredentialId` text,
	`calendarsRefreshAttemptedAt` integer,
	`calendarsRefreshedAt` integer,
	`createdAt` integer NOT NULL,
	`displayName` text,
	`email` text,
	`id` text PRIMARY KEY NOT NULL,
	`needsReauthentication` integer DEFAULT false NOT NULL,
	`oauthCredentialId` text,
	`provider` text NOT NULL,
	`reauthenticationSource` text,
	`updatedAt` integer NOT NULL,
	`userId` text DEFAULT 'owner' NOT NULL,
	FOREIGN KEY (`caldavCredentialId`) REFERENCES `caldav_credentials`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`oauthCredentialId`) REFERENCES `oauth_credentials`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `calendar_accounts_user_idx` ON `calendar_accounts` (`userId`);--> statement-breakpoint
CREATE INDEX `calendar_accounts_provider_idx` ON `calendar_accounts` (`provider`);--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_accounts_provider_account_idx` ON `calendar_accounts` (`userId`,`provider`,`accountId`);--> statement-breakpoint
CREATE TABLE `calendar_removals` (
	`accountId` text NOT NULL,
	`calendarType` text NOT NULL,
	`calendarUrl` text,
	`createdAt` integer NOT NULL,
	`externalCalendarId` text,
	`id` text PRIMARY KEY NOT NULL,
	`userId` text DEFAULT 'owner' NOT NULL,
	FOREIGN KEY (`accountId`) REFERENCES `calendar_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `calendar_removals_account_idx` ON `calendar_removals` (`accountId`);--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_removals_external_idx` ON `calendar_removals` (`accountId`,`externalCalendarId`) WHERE "calendar_removals"."externalCalendarId" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_removals_url_idx` ON `calendar_removals` (`accountId`,`calendarUrl`) WHERE "calendar_removals"."calendarUrl" is not null;--> statement-breakpoint
CREATE TABLE `calendar_snapshots` (
	`calendarId` text NOT NULL,
	`contentHash` text,
	`createdAt` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	FOREIGN KEY (`calendarId`) REFERENCES `calendars`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_snapshots_calendarId_unique` ON `calendar_snapshots` (`calendarId`);--> statement-breakpoint
CREATE TABLE `calendars` (
	`accountId` text NOT NULL,
	`calendarType` text NOT NULL,
	`calendarUrl` text,
	`createdAt` integer NOT NULL,
	`excludeAllDayEvents` integer DEFAULT false NOT NULL,
	`excludeAvailabilities` text DEFAULT '[]' NOT NULL,
	`excludeEventDescription` integer DEFAULT true NOT NULL,
	`excludeEventLocation` integer DEFAULT true NOT NULL,
	`excludeEventName` integer DEFAULT true NOT NULL,
	`excludeFocusTime` integer DEFAULT false NOT NULL,
	`excludeOutOfOffice` integer DEFAULT false NOT NULL,
	`excludeTitleKeywords` text DEFAULT '[]' NOT NULL,
	`treatFullDayTimedEventsAsAllDay` integer DEFAULT false NOT NULL,
	`customEventName` text DEFAULT '{{calendar_name}}' NOT NULL,
	`markEventsAsPrivate` integer DEFAULT false NOT NULL,
	`disabled` integer DEFAULT false NOT NULL,
	`failureCount` integer DEFAULT 0 NOT NULL,
	`lastFailureAt` integer,
	`nextAttemptAt` integer,
	`ingestFailureCount` integer DEFAULT 0 NOT NULL,
	`ingestLastFailureAt` integer,
	`ingestNextAttemptAt` integer,
	`ingestFutureRange` text DEFAULT '2_years' NOT NULL,
	`ingestHistoricRange` text DEFAULT '1_month' NOT NULL,
	`ingestSeq` integer DEFAULT 0 NOT NULL,
	`ingestWindowEnd` integer,
	`ingestWindowRecordedAt` integer,
	`ingestWindowStart` integer,
	`providerMissingSince` integer,
	`externalCalendarId` text,
	`id` text PRIMARY KEY NOT NULL,
	`capabilities` text DEFAULT '["pull"]' NOT NULL,
	`name` text NOT NULL,
	`originalName` text,
	`syncToken` text,
	`syncFutureRange` text DEFAULT '2_years' NOT NULL,
	`syncHistoricRange` text DEFAULT '1_month' NOT NULL,
	`unavailableSince` integer,
	`updatedAt` integer NOT NULL,
	`url` text,
	`userId` text DEFAULT 'owner' NOT NULL,
	FOREIGN KEY (`accountId`) REFERENCES `calendar_accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "calendars_sync_ranges_check" CHECK("syncHistoricRange" IN ('1_week', '1_month', '3_months', '6_months', '12_months', '2_years') AND "syncFutureRange" IN ('1_week', '1_month', '3_months', '6_months', '12_months', '2_years')),
	CONSTRAINT "calendars_ingest_coverage_check" CHECK("ingestHistoricRange" IN ('1_week', '1_month', '3_months', '6_months', '12_months', '2_years') AND "ingestFutureRange" IN ('1_week', '1_month', '3_months', '6_months', '12_months', '2_years') AND (("ingestWindowStart" IS NULL AND "ingestWindowEnd" IS NULL AND "ingestWindowRecordedAt" IS NULL) OR ("ingestWindowStart" IS NOT NULL AND "ingestWindowEnd" IS NOT NULL AND "ingestWindowRecordedAt" IS NOT NULL AND "ingestWindowStart" < "ingestWindowEnd")))
);
--> statement-breakpoint
CREATE INDEX `calendars_user_idx` ON `calendars` (`userId`);--> statement-breakpoint
CREATE INDEX `calendars_account_idx` ON `calendars` (`accountId`);--> statement-breakpoint
CREATE INDEX `calendars_type_idx` ON `calendars` (`calendarType`);--> statement-breakpoint
CREATE TABLE `event_mappings` (
	`calendarId` text NOT NULL,
	`createdAt` integer NOT NULL,
	`deleteIdentifier` text,
	`destinationEventUid` text NOT NULL,
	`endTime` integer NOT NULL,
	`eventStateId` text,
	`id` text PRIMARY KEY NOT NULL,
	`syncEventId` text,
	`syncEventHash` text,
	`sourceCalendarId` text,
	`startTime` integer NOT NULL,
	FOREIGN KEY (`calendarId`) REFERENCES `calendars`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`eventStateId`) REFERENCES `event_states`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "event_mappings_identity_check" CHECK("event_mappings"."eventStateId" is not null or "event_mappings"."syncEventId" is not null)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `event_mappings_sync_event_cal_idx` ON `event_mappings` (`calendarId`,`syncEventId`) WHERE "event_mappings"."syncEventId" is not null;--> statement-breakpoint
CREATE INDEX `event_mappings_calendar_idx` ON `event_mappings` (`calendarId`);--> statement-breakpoint
CREATE INDEX `event_mappings_event_state_idx` ON `event_mappings` (`eventStateId`);--> statement-breakpoint
CREATE INDEX `event_mappings_source_calendar_idx` ON `event_mappings` (`sourceCalendarId`);--> statement-breakpoint
CREATE INDEX `event_mappings_missing_sync_event_idx` ON `event_mappings` (`id`) WHERE "event_mappings"."syncEventId" is null;--> statement-breakpoint
CREATE INDEX `event_mappings_sync_hash_idx` ON `event_mappings` (`syncEventHash`);--> statement-breakpoint
CREATE TABLE `event_states` (
	`availability` text,
	`calendarId` text NOT NULL,
	`createdAt` integer NOT NULL,
	`description` text,
	`endTime` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`location` text,
	`recurrenceRule` text,
	`exceptionDates` text,
	`recurrenceId` integer,
	`isAllDay` integer,
	`sourceEventId` text,
	`sourceEventType` text,
	`sourceEventUid` text,
	`startTime` integer NOT NULL,
	`startTimeZone` text,
	`title` text,
	FOREIGN KEY (`calendarId`) REFERENCES `calendars`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `event_states_start_time_idx` ON `event_states` (`startTime`);--> statement-breakpoint
CREATE INDEX `event_states_end_time_idx` ON `event_states` (`endTime`);--> statement-breakpoint
CREATE INDEX `event_states_calendar_idx` ON `event_states` (`calendarId`);--> statement-breakpoint
CREATE UNIQUE INDEX `event_states_source_event_idx` ON `event_states` (`calendarId`,`sourceEventId`) WHERE "event_states"."sourceEventId" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `event_states_recurring_instance_idx` ON `event_states` (`calendarId`,`sourceEventUid`,`recurrenceId`) WHERE "event_states"."sourceEventId" is null and "event_states"."recurrenceId" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `event_states_non_recurring_instance_idx` ON `event_states` (`calendarId`,`sourceEventUid`,`startTime`,`endTime`) WHERE "event_states"."sourceEventId" is null and "event_states"."recurrenceId" is null;--> statement-breakpoint
CREATE TABLE `locks` (
	`expiresAt` integer NOT NULL,
	`holder` text NOT NULL,
	`key` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `oauth_credentials` (
	`accessToken` text NOT NULL,
	`createdAt` integer NOT NULL,
	`email` text,
	`expiresAt` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`needsReauthentication` integer DEFAULT false NOT NULL,
	`provider` text NOT NULL,
	`refreshToken` text NOT NULL,
	`updatedAt` integer NOT NULL,
	`userId` text DEFAULT 'owner' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `oauth_credentials_user_idx` ON `oauth_credentials` (`userId`);--> statement-breakpoint
CREATE INDEX `oauth_credentials_provider_idx` ON `oauth_credentials` (`provider`);--> statement-breakpoint
CREATE TABLE `source_destination_mappings` (
	`createdAt` integer NOT NULL,
	`destinationCalendarId` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`sourceCalendarId` text NOT NULL,
	FOREIGN KEY (`destinationCalendarId`) REFERENCES `calendars`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sourceCalendarId`) REFERENCES `calendars`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `source_destination_mapping_idx` ON `source_destination_mappings` (`sourceCalendarId`,`destinationCalendarId`);--> statement-breakpoint
CREATE INDEX `source_destination_mappings_source_idx` ON `source_destination_mappings` (`sourceCalendarId`);--> statement-breakpoint
CREATE INDEX `source_destination_mappings_destination_idx` ON `source_destination_mappings` (`destinationCalendarId`);--> statement-breakpoint
CREATE TABLE `sync_status` (
	`calendarId` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`lastError` text,
	`lastSyncedAt` integer,
	`localEventCount` integer DEFAULT 0 NOT NULL,
	`remoteEventCount` integer DEFAULT 0 NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`calendarId`) REFERENCES `calendars`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sync_status_calendar_idx` ON `sync_status` (`calendarId`);