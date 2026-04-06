'use strict';

/**
 * Score an issue based on severity weight and plugin-specific factors.
 *
 * @param {object} issue - Normalized issue object
 * @param {object} plugin - Plugin instance (must export scoringFactors)
 * @param {object} scoringConfig - Parsed config/scoring.json
 * @returns {number} impact_score
 */
function scoreIssue(issue, plugin, scoringConfig) {
  const severityWeights = scoringConfig.severity_weights || {};
  const severityWeight = severityWeights[issue.severity] || severityWeights.medium || 40;

  let sourceFactor = 1;
  if (typeof plugin.scoringFactors === 'function') {
    sourceFactor = plugin.scoringFactors(issue) || 1;
  }

  return severityWeight * sourceFactor;
}

/**
 * Compute priority for fix ordering.
 * Higher priority = higher impact relative to effort.
 *
 * @param {object} issue - Issue with impact_score and estimated_minutes set
 * @returns {number} priority value
 */
function computePriority(issue) {
  const impact = issue.impact_score || 0;
  const minutes = issue.estimated_minutes || 15; // default 15 min if unknown
  return impact / minutes;
}

module.exports = { scoreIssue, computePriority };
