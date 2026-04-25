'use strict';

const path = require('path');
const crypto = require('crypto');
const { getDb } = require('./db');
const { isBlocklisted } = require('./automationConfig');

function clubId(seed) {
  return 'club-' + crypto.createHash('md5').update(seed).digest('hex').slice(0, 10);
}

function commonDir(files) {
  const clean = files.filter(Boolean).map(f => f.replace(/\\/g, '/'));
  if (clean.length === 0) return '';
  if (clean.length === 1) return path.posix.dirname(clean[0]);
  const split = clean.map(f => f.split('/'));
  const out = [];
  for (let i = 0; i < split[0].length; i++) {
    const seg = split[0][i];
    if (split.every(parts => parts[i] === seg)) out.push(seg);
    else break;
  }
  return out.join('/') || '/';
}

function groupBy(items, keyFn) {
  const m = new Map();
  for (const it of items) {
    const k = keyFn(it);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(it);
  }
  return m;
}

/**
 * Split an ordered array of issues into chunks honoring caps.
 * Greedy: add issues while both file-count and issue-count stay under caps.
 */
function chunkIssues(issues, caps) {
  const chunks = [];
  let cur = [];
  let curFiles = new Set();
  for (const issue of issues) {
    const nextFiles = new Set(curFiles);
    if (issue.file_path) nextFiles.add(issue.file_path);
    const wouldExceedIssues = cur.length + 1 > caps.max_issues;
    const wouldExceedFiles = nextFiles.size > caps.max_files;
    if (cur.length > 0 && (wouldExceedIssues || wouldExceedFiles)) {
      chunks.push(cur);
      cur = [];
      curFiles = new Set();
    }
    cur.push(issue);
    if (issue.file_path) curFiles.add(issue.file_path);
  }
  if (cur.length > 0) chunks.push(cur);
  return chunks;
}

/**
 * Build clubs from an issue list honoring config caps.
 * Rules:
 *   1. Same category + rule_id → same club candidate.
 *   2. If exceeds caps, split by common directory.
 *   3. If still exceeds, chunk greedily.
 *
 * Returns an array of club objects (NOT persisted). Sorted by summed score desc.
 */
function buildClubs(issues, config) {
  const caps = config.clubbing;
  const filtered = issues.filter(i => !isBlocklisted(i.file_path, config.blocklist));

  // Group by category + rule_id.
  const byCatRule = groupBy(filtered, i => `${i.category || 'other'}||${i.rule_id || 'unknown'}`);

  const clubs = [];
  for (const [catRule, group] of byCatRule) {
    const [category, rule_id] = catRule.split('||');
    const uniqueFiles = new Set(group.map(i => i.file_path).filter(Boolean)).size;
    const fitsWhole = group.length <= caps.max_issues && uniqueFiles <= caps.max_files;

    let chunks;
    if (fitsWhole) {
      chunks = [group];
    } else if (caps.prefer_same_directory) {
      // Split by directory, then chunk each
      const byDir = groupBy(group, i => i.file_path ? path.posix.dirname(i.file_path.replace(/\\/g, '/')) : 'root');
      chunks = [];
      for (const dirIssues of byDir.values()) {
        for (const c of chunkIssues(dirIssues, caps)) chunks.push(c);
      }
    } else {
      chunks = chunkIssues(group, caps);
    }

    for (const chunk of chunks) {
      const files = [...new Set(chunk.map(i => i.file_path).filter(Boolean))];
      const dir = commonDir(files);
      const score = chunk.reduce((s, i) => s + (i.impact_score || 0), 0);
      const id = clubId(`${category}|${rule_id}|${dir}|${chunk.map(i => i.id).sort().join(',')}`);
      const title = buildTitle(chunk, category, rule_id, dir);
      clubs.push({
        id,
        category,
        rule_id,
        common_dir: dir,
        title,
        issue_count: chunk.length,
        files_count: files.length,
        issue_ids: chunk.map(i => i.id),
        files,
        score,
        issues: chunk,
      });
    }
  }

  clubs.sort((a, b) => b.score - a.score);
  return clubs;
}

function buildTitle(issues, category, rule_id, dir) {
  const n = issues.length;
  const ruleLabel = rule_id && rule_id !== 'unknown' ? rule_id : category;
  const dirLabel = dir && dir !== '/' && dir !== '.' ? ` in ${dir}` : '';
  return `Fix ${n} ${ruleLabel} ${n === 1 ? 'issue' : 'issues'}${dirLabel}`;
}

/**
 * Persist a set of clubs into the DB with status='proposed'.
 * Also rolls forward: if a proposed club with the same id exists, updates it.
 * Returns the persisted clubs.
 */
function persistClubs(clubs, { session_id, source }) {
  const db = getDb();
  const now = new Date().toISOString();

  const upsert = db.prepare(`
    INSERT INTO clubs (
      id, session_id, source, category, rule_id, common_dir,
      issue_count, files_count, lines_est, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      session_id = excluded.session_id,
      issue_count = excluded.issue_count,
      files_count = excluded.files_count,
      lines_est = excluded.lines_est,
      updated_at = excluded.updated_at
  `);

  const clearIssues = db.prepare('DELETE FROM club_issues WHERE club_id = ?');
  const insertIssue = db.prepare('INSERT OR IGNORE INTO club_issues (club_id, issue_id) VALUES (?, ?)');

  const tx = db.transaction(() => {
    for (const c of clubs) {
      upsert.run(
        c.id, session_id, source, c.category, c.rule_id, c.common_dir,
        c.issue_count, c.files_count, c.issue_count * 20, now, now
      );
      clearIssues.run(c.id);
      for (const iid of c.issue_ids) insertIssue.run(c.id, iid);
    }
  });
  tx();

  return clubs;
}

function getClub(clubId) {
  const db = getDb();
  const club = db.prepare('SELECT * FROM clubs WHERE id = ?').get(clubId);
  if (!club) return null;
  const issueIds = db.prepare('SELECT issue_id FROM club_issues WHERE club_id = ?').all(clubId).map(r => r.issue_id);
  club.issue_ids = issueIds;
  return club;
}

function getClubIssues(clubId) {
  const db = getDb();
  return db.prepare(`
    SELECT i.* FROM issues i
    INNER JOIN club_issues ci ON ci.issue_id = i.id
    WHERE ci.club_id = ?
    ORDER BY i.impact_score DESC
  `).all(clubId);
}

module.exports = {
  buildClubs,
  persistClubs,
  getClub,
  getClubIssues,
  clubId,
};
