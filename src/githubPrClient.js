import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

// Non-code or auto-generated files to exclude from AI code review
const EXCLUDED_EXTENSIONS = new Set([
  '.lock',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.svg',
  '.ico',
  '.pdf',
  '.zip',
  '.map'
]);

const EXCLUDED_FILENAMES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  '.gitignore',
  'LICENSE',
  'cloudflared.exe',
  'cloudflared.log',
  'cloudflared.out.log'
]);

const EXCLUDED_DIRECTORIES = [
  'node_modules/',
  'dist/',
  'build/',
  '.git/',
  '.sf/',
  '.sfdx/'
];

/**
 * Checks if a given file path is eligible for code review.
 * @param {string} filePath
 * @returns {boolean}
 */
export function isReviewableFile(filePath) {
  if (!filePath) return false;
  const normalized = filePath.replace(/\\/g, '/');

  // Check excluded directories
  for (const dir of EXCLUDED_DIRECTORIES) {
    if (normalized.startsWith(dir) || normalized.includes(`/${dir}`)) {
      return false;
    }
  }

  // Check excluded filenames
  const baseName = path.basename(normalized);
  if (EXCLUDED_FILENAMES.has(baseName)) {
    return false;
  }

  // Check excluded extensions
  const ext = path.extname(normalized).toLowerCase();
  if (EXCLUDED_EXTENSIONS.has(ext)) {
    return false;
  }

  return true;
}

/**
 * Filters a raw unified diff, keeping only chunks for reviewable files.
 * @param {string} rawDiff
 * @returns {string} Filtered unified diff
 */
export function filterDiff(rawDiff) {
  if (!rawDiff) return '';

  const fileChunks = rawDiff.split(/(?=^diff --git )/m);
  const allowedChunks = [];

  for (const chunk of fileChunks) {
    if (!chunk.trim()) continue;
    const match = chunk.match(/^diff --git a\/(.+?) b\/(.+?)$/m);
    if (match) {
      const targetPath = match[2];
      if (isReviewableFile(targetPath)) {
        allowedChunks.push(chunk);
      }
    } else {
      allowedChunks.push(chunk);
    }
  }

  return allowedChunks.join('');
}

/**
 * Fetches Pull Request metadata using GitHub CLI
 * @param {string|number} prNumber
 * @returns {Object}
 */
export function getPullRequestDetails(prNumber) {
  try {
    const raw = execSync(
      `gh pr view ${prNumber} --json number,title,body,headRefName,baseRefName,url,files,headRefOid`,
      { encoding: 'utf8' }
    );
    const data = JSON.parse(raw);
    const reviewableFiles = (data.files || []).filter((f) => isReviewableFile(f.path));
    return {
      number: data.number,
      title: data.title,
      body: data.body,
      headBranch: data.headRefName,
      baseBranch: data.baseRefName,
      headSha: data.headRefOid,
      url: data.url,
      allFiles: data.files || [],
      reviewableFiles
    };
  } catch (err) {
    throw new Error(`Failed to fetch PR #${prNumber} details via GitHub CLI: ${err.message}`);
  }
}

/**
 * Fetches the unified diff for a Pull Request
 * @param {string|number} prNumber
 * @returns {string}
 */
export function getPullRequestDiff(prNumber) {
  try {
    const rawDiff = execSync(`gh pr diff ${prNumber}`, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
    return filterDiff(rawDiff);
  } catch (err) {
    throw new Error(`Failed to fetch PR #${prNumber} diff: ${err.message}`);
  }
}

/**
 * Submits a top-level review summary comment on the PR.
 * @param {string|number} prNumber
 * @param {Object} reviewResult
 * @param {Object} prDetails
 */
export function submitReviewSummary(prNumber, reviewResult, prDetails = {}) {
  const { verdict, overallScore, summary, highlights, securityAdvisories, inlineComments } = reviewResult;

  let badge = '💬 **COMMENT**';
  let action = 'COMMENT';
  if (verdict === 'APPROVED') {
    badge = '✅ **APPROVED**';
    action = 'APPROVE';
  } else if (verdict === 'CHANGES_REQUESTED') {
    badge = '⚠️ **CHANGES REQUESTED**';
    action = 'REQUEST_CHANGES';
  }

  const blockers = (inlineComments || []).filter((c) => c.severity === 'BLOCKER');
  const warnings = (inlineComments || []).filter((c) => c.severity === 'WARNING');
  const suggestions = (inlineComments || []).filter((c) => c.severity === 'SUGGESTION');

  const lines = [
    `# 🤖 Gemini AI Code Review`,
    ``,
    `| Review Metric | Assessment |`,
    `|---|---|`,
    `| **Verdict** | ${badge} |`,
    `| **Code Quality Score** | \`${overallScore} / 10\` |`,
    `| **Review Scope** | Changed files in PR #${prNumber} |`,
    `| **Issues Found** | **${blockers.length}** Blocker(s), **${warnings.length}** Warning(s), **${suggestions.length}** Suggestion(s) |`,
    ``,
    `---`,
    ``,
    `### 📋 Executive Summary`,
    summary || 'No summary provided.',
    ``
  ];

  if (securityAdvisories && securityAdvisories.length > 0) {
    lines.push(`### 🛡️ Security Advisories`);
    for (const sec of securityAdvisories) {
      lines.push(`- **[${sec.severity}] ${sec.title}**${sec.cweOrOwasp ? ` (\`${sec.cweOrOwasp}\`)` : ''}`);
      lines.push(`  > ${sec.description}`);
    }
    lines.push(``);
  }

  if (highlights && highlights.length > 0) {
    lines.push(`### ✨ Code Highlights & Strengths`);
    for (const hl of highlights) {
      lines.push(`- ${hl}`);
    }
    lines.push(``);
  }

  if (inlineComments && inlineComments.length > 0) {
    lines.push(`### 🔍 Key Findings & Recommendations`);
    for (const comment of inlineComments) {
      const icon = comment.severity === 'BLOCKER' ? '🛑' : (comment.severity === 'WARNING' ? '⚠️' : '💡');
      lines.push(`- ${icon} **\`${comment.filePath}:${comment.line}\`** [${comment.category}] — ${comment.comment}`);
      if (comment.suggestedFix) {
        lines.push(`  \`\`\`suggestion`);
        lines.push(`  ${comment.suggestedFix}`);
        lines.push(`  \`\`\``);
      }
    }
    lines.push(``);
  }

  lines.push(`---`);
  lines.push(`*Automated code review executed by Gemini AI Code Review Agent using Google Gen AI SDK.*`);

  const reviewBody = lines.join('\n');
  const tmpFile = path.join(process.cwd(), 'agent-context', `ai-review-${Date.now()}.md`);

  try {
    const dir = path.dirname(tmpFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmpFile, reviewBody, 'utf8');

    if (action === 'APPROVE') {
      try {
        execSync(`gh pr review ${prNumber} --approve -F "${tmpFile}"`, { stdio: 'pipe' });
        console.log(`[GITHUB PR] Successfully approved PR #${prNumber}.`);
      } catch (err) {
        console.warn(`[GITHUB PR] Self-approval limitation note. Submitting review comment...`);
        execSync(`gh pr review ${prNumber} --comment -F "${tmpFile}"`, { stdio: 'pipe' });
      }
    } else if (action === 'REQUEST_CHANGES') {
      try {
        execSync(`gh pr review ${prNumber} --request-changes -F "${tmpFile}"`, { stdio: 'pipe' });
        console.log(`[GITHUB PR] Requested changes on PR #${prNumber}.`);
      } catch (err) {
        console.warn(`[GITHUB PR] Self-request-changes limitation note. Submitting review comment...`);
        execSync(`gh pr review ${prNumber} --comment -F "${tmpFile}"`, { stdio: 'pipe' });
      }
    } else {
      execSync(`gh pr review ${prNumber} --comment -F "${tmpFile}"`, { stdio: 'pipe' });
      console.log(`[GITHUB PR] Submitted review comment on PR #${prNumber}.`);
    }
  } catch (err) {
    console.error(`[GITHUB PR ERROR] Failed to submit review to PR #${prNumber}:`, err.message);
  } finally {
    if (fs.existsSync(tmpFile)) {
      try { fs.unlinkSync(tmpFile); } catch (e) {}
    }
  }

  return reviewBody;
}

/**
 * Posts line-specific inline comments to the PR using GitHub API via gh api.
 * @param {string|number} prNumber
 * @param {Array} inlineComments
 * @param {string} headSha
 */
export function postInlineComments(prNumber, inlineComments = [], headSha = null) {
  if (!inlineComments || inlineComments.length === 0) return;

  for (const item of inlineComments) {
    if (!item.filePath || !item.line) continue;

    let commentBody = `**[${item.severity}] ${item.category}:** ${item.comment}`;
    if (item.suggestedFix) {
      commentBody += `\n\n\`\`\`suggestion\n${item.suggestedFix}\n\`\`\``;
    }

    try {
      const payload = {
        body: commentBody,
        commit_id: headSha,
        path: item.filePath,
        line: Number(item.line),
        side: 'RIGHT'
      };

      // Use gh api to post pull request comment
      execSync(
        `gh api repos/:owner/:repo/pulls/${prNumber}/comments --input -`,
        {
          input: JSON.stringify(payload),
          stdio: ['pipe', 'pipe', 'pipe']
        }
      );
      console.log(`[INLINE COMMENT] Added comment on ${item.filePath}:${item.line}`);
    } catch (err) {
      // Inline comments might fail if line is not part of diff hunk; non-fatal
      console.warn(`[INLINE COMMENT NOTE] Could not attach inline comment to ${item.filePath}:${item.line} (may be outside diff hunk).`);
    }
  }
}
