/*
 * Standard replacements for Node's Buffer base64 helpers, which Workers lack without
 * nodejs_compat. Strings are encoded as UTF-8 first, as Buffer.from(string) does.
 */
const bytesToBinaryString = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }
  return binary;
};

const encodeBase64 = (value: string): string =>
  btoa(bytesToBinaryString(new TextEncoder().encode(value)));

const encodeBase64Url = (value: string): string =>
  encodeBase64(value).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

// Throws on characters outside the alphabet, where Buffer silently skipped them.
const decodeBase64Url = (value: string): string => {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.codePointAt(0) ?? 0);
  return new TextDecoder().decode(bytes);
};

export { decodeBase64Url, encodeBase64, encodeBase64Url };
