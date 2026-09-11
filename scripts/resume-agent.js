import { runAgent } from '../src/agentRunner.js';


const reply = 'The developer replied: "Customer_Tier__c should be a Picklist with values: Gold, Silver, Bronze. Please expose both fields on the standard Account Page Layout.". Continue the task and produce agent-context/tickets/SCRUM-2/plan.md.';

console.log('[RESUME] Resuming Agent 1 with developer input...');
const res = await runAgent(reply, true);
console.log('[RESUME] Agent finished with code:', res.code);
