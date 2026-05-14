import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const LOCKFILE_NAME = ".apply-agent-rules.lock.json";
export const LOCKFILE_VERSION = 2;

export function lockfilePath(target) {
  return path.join(target, LOCKFILE_NAME);
}

export function readLockfile(target) {
  const p = lockfilePath(target);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = fs.readFileSync(p, "utf8");
    const data = JSON.parse(raw);
    if (data.version === LOCKFILE_VERSION) return data;
    if (data.version === 1) return migrateV1(data);
    throw new Error(
      `lockfile version ${data.version} not supported (expected ${LOCKFILE_VERSION})`
    );
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

// Canonical key for matching a source in the lockfile across re-applies that
// only differ by ref (e.g. "owner/repo" and "owner/repo@v1" share a key).
export function sourceKey(source) {
  if (!source) return "";
  const hashIdx = source.indexOf("#");
  const slashIdx = source.indexOf("/");
  let base = source;
  if (hashIdx !== -1) {
    base = source.slice(0, hashIdx);
  } else {
    const atIdx = source.lastIndexOf("@");
    if (atIdx !== -1 && atIdx > slashIdx) base = source.slice(0, atIdx);
  }
  return base.replace(/\.git$/, "").toLowerCase();
}

export function findSourceEntry(lock, source) {
  if (!lock?.sources?.length) return null;
  const key = sourceKey(source);
  return lock.sources.find((s) => sourceKey(s.source) === key) ?? null;
}

function migrateV1(data) {
  const entry = {
    source: data.source ?? "",
    kind: data.kind ?? null,
    ref: data.ref ?? null,
    commit: data.commit ?? null,
    installedAt: data.installedAt ?? new Date().toISOString(),
    updatedAt: data.updatedAt ?? null,
    agents: data.agents ?? [],
    files: data.files ?? [],
  };
  return { version: LOCKFILE_VERSION, sources: entry.source ? [entry] : [] };
}
