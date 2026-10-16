import { KEEPER_EVENT_SUFFIX } from "@keeper.sh/constants";
import { sha256Hex } from "../utils/sha256";

const generateDeterministicEventUid = (seed: string): string => {
  const hash = sha256Hex(seed).slice(0, 32);
  return `${hash}${KEEPER_EVENT_SUFFIX}`;
};

const isKeeperEvent = (uid: string): boolean => uid.endsWith(KEEPER_EVENT_SUFFIX);

export { generateDeterministicEventUid, isKeeperEvent };
