import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

export function runAgent(prompt, isContinue = false, timeoutMinutes = 15) {
  return new Promise((resolve, reject) => {
    const agyBin = 'agy.exe';
    const args = [
      '--dangerously-skip-permissions',
      '--print-timeout', `${timeoutMinutes}m`
    ];

    if (isContinue) {
      args.push('--continue');
    }

    console.log(`\n================== [AGENT INVOCATION (${isContinue ? 'CONTINUE' : 'START'})] ==================`);
    console.log(`Spawning ${agyBin} with stdin prompt length: ${prompt.length} chars`);

    const child = spawn(agyBin, args, {
      shell: false,
      cwd: process.cwd(),
      env: { ...process.env, CI: '1' }
    });

    child.stdin.write(prompt);
    child.stdin.end();


    let fullOutput = '';
    let fullStderr = '';

    child.stdout.on('data', (data) => {
      const chunk = data.toString();
      process.stdout.write(chunk);
      fullOutput += chunk;
    });

    child.stderr.on('data', (data) => {
      const chunk = data.toString();
      process.stderr.write(chunk);
      fullStderr += chunk;
    });

    child.on('error', (err) => {
      console.error('[AGENT PROCESS ERROR]', err);
      reject(err);
    });

    child.on('close', (code) => {
      console.log(`\n================== [AGENT FINISHED (exit code: ${code})] ==================\n`);
      resolve({
        code,
        output: fullOutput.trim(),
        stderr: fullStderr.trim()
      });
    });
  });
}

/**
 * Checks if the agent output requested human input via NEEDS_INPUT
 */
export function parseNeedsInput(output) {
  if (!output) return null;

  // Search lines from bottom up for NEEDS_INPUT: <question>
  const lines = output.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = lines[i].match(/^NEEDS_INPUT:\s*(.+)$/i);
    if (match) {
      return match[1].trim();
    }
  }

  // Also check regex in case it's on a multi-line format
  const globalMatch = output.match(/NEEDS_INPUT:\s*([^\n\r]+)/i);
  return globalMatch ? globalMatch[1].trim() : null;
}

/**
 * Parses the QA Tester (Agent 3) output and test-report.md to determine PASS / FAIL status and bug details
 * @param {string} output Agent stdout/output text
 * @param {string} ticketKey E.g. SCRUM-8
 * @returns {{ passed: boolean, bugDetails: string, summary: string, reportContent: string }}
 */
export function parseTestResult(output, ticketKey) {
  let reportContent = '';
  try {
    const reportPath = path.join(process.cwd(), 'agent-context', 'tickets', ticketKey, 'test-report.md');
    if (fs.existsSync(reportPath)) {
      reportContent = fs.readFileSync(reportPath, 'utf8');
    }
  } catch (e) {}

  const combined = `${output || ''}\n\n${reportContent}`;

  // Check for explicit directives
  const passMatch = combined.match(/TEST_RESULT:\s*PASS\b/i);
  const failMatch = combined.match(/TEST_RESULT:\s*FAIL\b/i);

  let passed = false;
  if (passMatch && !failMatch) {
    passed = true;
  } else if (failMatch) {
    passed = false;
  } else {
    // Heuristic fallbacks if explicit directive omitted
    if (/all (acceptance criteria|tests) (passed|met|succeeded)/i.test(combined) && !/fail/i.test((output || '').slice(-200))) {
      passed = true;
    } else {
      passed = false;
    }
  }

  let bugDetails = '';
  let summary = '';

  if (!passed) {
    const bugDirective = combined.match(/BUG_DETAILS:\s*([\s\S]+?)(?=\n(?:TEST_RESULT|SUMMARY|FIX_COMPLETE):|$)/i);
    if (bugDirective && bugDirective[1].trim()) {
      bugDetails = bugDirective[1].trim();
    } else {
      const sectionMatch = reportContent.match(/###\s*(?:Bug|Failure|Issues)[\s\S]*?(?=\n##|$)/i);
      if (sectionMatch) {
        bugDetails = sectionMatch[0].trim();
      } else {
        bugDetails = 'Tester detected failures or unmet acceptance criteria during verification.';
      }
    }
  } else {
    const sumDirective = combined.match(/SUMMARY:\s*([^\n\r]+)/i);
    summary = sumDirective ? sumDirective[1].trim() : 'All acceptance criteria and deployment validation checks passed.';
  }

  return { passed, bugDetails, summary, reportContent };
}

