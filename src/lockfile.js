import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const LOCKFILE_NAME = ".apply-agent-rules.lock.json";
export const LOCKFILE_VERSION = 1;

export function lockfilePath(target) {
  return path.join(target, LOCKFILE_NAME);
}

export function readLockfile(target) {
  const p = lockfilePath(target);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = fs.readFileSync(p, "utf8");
    const data = JSON.parse(raw);
    if (data.version !== LOCKFILE_VERSION) {
      throw new Error(
        `lockfile version ${data.version} not supported (expected ${LOCKFILE_VERSION})`
      );
    }
    return data;
  } catch (err) {
    throw new Error(`failed to read lockfile at ${p}: ${err.message}`);
  }
}

export function writeLockfile(target, data) {
  const payload = { version: LOCKFILE_VERSION, ...data };
  fs.writeFileSync(lockfilePath(target), JSON.stringify(payload, null, 2) + "\n");
}

export function hashFile(absPath) {
  const buf = fs.readFileSync(absPath);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

export function hashBuffer(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}
