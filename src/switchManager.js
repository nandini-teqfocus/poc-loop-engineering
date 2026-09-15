import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const STATE_FILE = path.join(process.cwd(), 'agent-context', 'switch-state.json');

/**
 * Retrieves the current switch state.
 * @returns {{ githubActionsActive: boolean, mode: 'github_actions'|'local_agent', lastUpdated: string, updatedBy: string }}
 */
export function getSwitchState() {
  if (fs.existsSync(STATE_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      return {
        githubActionsActive: Boolean(data.githubActionsActive),
        mode: data.githubActionsActive ? 'github_actions' : 'local_agent',
        lastUpdated: data.lastUpdated || new Date().toISOString(),
        updatedBy: data.updatedBy || 'default'
      };
    } catch (e) {}
  }

  // Fallback to environment variable or default true (GitHub Actions active)
  const envVal = process.env.ENABLE_PR_REVIEW_AGENT ?? 'true';
  const active = String(envVal).trim().toLowerCase() !== 'false';
  return {
    githubActionsActive: active,
    mode: active ? 'github_actions' : 'local_agent',
    lastUpdated: new Date().toISOString(),
    updatedBy: 'initial_default'
  };
}

/**
 * Sets the switch state, updates GitHub workflow state via gh CLI, and persists to disk.
 * @param {boolean} githubActionsActive 
 * @param {string} source 
 * @returns {{ githubActionsActive: boolean, mode: 'github_actions'|'local_agent', lastUpdated: string, updatedBy: string }}
 */
export function setSwitchState(githubActionsActive, source = 'system') {
  const active = Boolean(githubActionsActive);
  const mode = active ? 'github_actions' : 'local_agent';

  // 1. Synchronize GitHub Actions workflow enablement state
  try {
    if (active) {
      console.log('[SWITCH] Enabling GitHub Actions workflow pr-review.yml...');
      execSync('gh workflow enable pr-review.yml', { stdio: 'pipe' });
      console.log('[SWITCH] GitHub Actions workflow pr-review.yml ENABLED.');
    } else {
      console.log('[SWITCH] Disabling GitHub Actions workflow pr-review.yml...');
      execSync('gh workflow disable pr-review.yml', { stdio: 'pipe' });
      console.log('[SWITCH] GitHub Actions workflow pr-review.yml DISABLED.');
    }
  } catch (err) {
    console.warn('[SWITCH] Note regarding gh workflow enable/disable:', err.message);
  }

  // 2. Persist state to disk
  const state = {
    githubActionsActive: active,
    mode,
    lastUpdated: new Date().toISOString(),
    updatedBy: source
  };

  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) {
    console.error('[SWITCH] Failed to save switch state file:', e.message);
  }

  // 3. Keep process.env aligned
  process.env.ENABLE_PR_REVIEW_AGENT = active ? 'true' : 'false';

  return state;
}

/**
 * Toggles the switch between GitHub Actions Active and Local Agent Active.
 * @param {string} source 
 * @returns {{ githubActionsActive: boolean, mode: string, lastUpdated: string, updatedBy: string }}
 */
export function toggleSwitch(source = 'button') {
  const current = getSwitchState();
  return setSwitchState(!current.githubActionsActive, source);
}

/**
 * Returns true if GitHub Actions is active for PR review.
 * @returns {boolean}
 */
export function isGitHubActionActive() {
  return getSwitchState().githubActionsActive;
}

/**
 * Returns true if Local Agent is active for PR review.
 * @returns {boolean}
 */
export function isLocalAgentActive() {
  return !isGitHubActionActive();
}
