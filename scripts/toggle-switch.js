import 'dotenv/config';
import { getSwitchState, toggleSwitch, setSwitchState } from '../src/switchManager.js';

const arg = process.argv[2]?.toLowerCase();

let state;
if (arg === '--on' || arg === '--gha' || arg === 'on' || arg === 'true') {
  state = setSwitchState(true, 'CLI argument');
} else if (arg === '--off' || arg === '--local' || arg === 'off' || arg === 'false') {
  state = setSwitchState(false, 'CLI argument');
} else if (arg === '--status' || arg === 'status') {
  state = getSwitchState();
} else {
  // Default: Toggle
  state = toggleSwitch('CLI Toggle');
}

console.log('======================================================');
console.log('🎛️  PR REVIEW AGENT SWITCH');
console.log('======================================================');
console.log(`Active Mode:             ${state.githubActionsActive ? '🚀 GITHUB ACTIONS (Active)' : '💻 LOCAL AGENT (Active)'}`);
console.log(`GitHub Workflow:         ${state.githubActionsActive ? 'ENABLED (pr-review.yml)' : 'DISABLED (pr-review.yml)'}`);
console.log(`Local Orchestrator Phase: ${state.githubActionsActive ? 'Delegated to GitHub Actions (Tokens Saved)' : 'Agent 4 Executes Locally'}`);
console.log(`Last Updated:            ${state.lastUpdated} via ${state.updatedBy}`);
console.log('======================================================\n');
