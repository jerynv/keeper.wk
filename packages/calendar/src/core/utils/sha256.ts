import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

/*
 * Synchronous on purpose: event identity and content hashes are computed inline all
 * through the planner, and Web Crypto's digest is async. Same bytes as
 * upstream's Bun.CryptoHasher("sha256").update(input).digest("hex").
 */
const sha256Hex = (input: string): string => bytesToHex(sha256(utf8ToBytes(input)));

export { sha256Hex };
