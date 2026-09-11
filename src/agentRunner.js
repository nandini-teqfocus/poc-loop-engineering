import { spawn } from 'child_process';

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
