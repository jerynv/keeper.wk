/// <reference types="vite/client" />
import type { FixtureSource } from "./schema";

/*
 * Tests run inside workerd, which has no access to the host filesystem, so the fixture
 * files are bundled into the test module by Vite rather than read from disk.
 */
const fixtureFiles = import.meta.glob<string>("../ics/*.ics", {
  eager: true,
  import: "default",
  query: "?raw",
});

const readFixture = (fixtureSource: FixtureSource): string => {
  const contents = fixtureFiles[`../ics/${fixtureSource.fileName}`];
  if (typeof contents !== "string") {
    throw new TypeError(`Fixture ${fixtureSource.fileName} is missing from packages/fixtures/ics`);
  }
  return contents;
};

export { readFixture };
