'use strict';

const { getDb } = require('./db');

/**
 * Acquire a lock on a file path for a given issue.
 * Returns true if lock acquired, false if already locked by another issue.
 */
function acquireLock(filePath, issueId, expiryMinutes = 30) {
  const db = getDb();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + expiryMinutes * 60 * 1000).toISOString();

  // Clean expired lock on this file first
  db.prepare('DELETE FROM locks WHERE file_path = ? AND expires_at < ?').run(filePath, now);

  // Check if already locked
  const existing = db.prepare('SELECT locked_by FROM locks WHERE file_path = ?').get(filePath);

  if (existing) {
    // Already locked by the same issue — refresh the expiry
    if (existing.locked_by === issueId) {
      db.prepare('UPDATE locks SET expires_at = ? WHERE file_path = ?').run(expiresAt, filePath);
      return true;
    }
    // Locked by a different issue
    return false;
  }

  // Insert new lock
  db.prepare(
    'INSERT INTO locks (file_path, locked_by, locked_at, expires_at) VALUES (?, ?, ?, ?)'
  ).run(filePath, issueId, now, expiresAt);

  return true;
}

/**
 * Release lock on a specific file.
 */
function releaseLock(filePath) {
  const db = getDb();
  db.prepare('DELETE FROM locks WHERE file_path = ?').run(filePath);
}

/**
 * Release all locks held by a given issue.
 */
function releaseLocksForIssue(issueId) {
  const db = getDb();
  db.prepare('DELETE FROM locks WHERE locked_by = ?').run(issueId);
}

/**
 * Check if a file is locked (and not expired).
 * Returns the lock row if locked, null otherwise.
 */
function isLocked(filePath) {
  const db = getDb();
  const now = new Date().toISOString();
  return db.prepare(
    'SELECT * FROM locks WHERE file_path = ? AND expires_at >= ?'
  ).get(filePath, now) || null;
}

/**
 * Delete all expired locks.
 */
function cleanExpiredLocks() {
  const db = getDb();
  const now = new Date().toISOString();
  const result = db.prepare('DELETE FROM locks WHERE expires_at < ?').run(now);
  return result.changes;
}

/**
 * Get all active locks (for diagnostics).
 */
function getActiveLocks() {
  const db = getDb();
  const now = new Date().toISOString();
  return db.prepare('SELECT * FROM locks WHERE expires_at >= ?').all(now);
}

module.exports = {
  acquireLock,
  releaseLock,
  releaseLocksForIssue,
  isLocked,
  cleanExpiredLocks,
  getActiveLocks,
};
