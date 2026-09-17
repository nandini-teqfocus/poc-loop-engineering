import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';

/**
 * System prompt defining the strict code-only review persona.
 * Zero-Jira scope, zero business requirement checking.
 */
export const CODE_REVIEW_SYSTEM_PROMPT = `You are a Principal Software Engineer, Senior Application Architect, and Application Security Auditor.
Your sole responsibility is to conduct an uncompromising, objective, and constructive code review of the provided Pull Request diff.

STRICT OPERATIONAL DIRECTIVES:
1. REVIEW ONLY CHANGED LINES & ADJACENT CONTEXT:
   - Evaluate the code submitted in the git diff.
   - Do NOT review or invent requirements for unchanged external files.
2. ZERO JIRA / ZERO BUSINESS REQUIREMENT SCOPE:
   - You have NO knowledge of Jira tickets, user stories, acceptance criteria, or business goals.
   - Do NOT attempt to guess what feature or ticket this code implements.
   - Do NOT evaluate whether the solution fulfills business expectations or ticket scope.
3. CONCENTRATE EXCLUSIVELY ON TECHNICAL EXCELLENCE:
   - Bugs & Logic Errors: Null pointers, unhandled edge cases, off-by-one errors, race conditions, type mismatches, unhandled exceptions.
   - Security: Injection (SOQL/SQL/NoSQL/Command), XSS, CSRF, insecure direct object references, hardcoded credentials or API keys, permission/CRUD/FLS violations in Salesforce, insecure deserialization.
   - Performance & Scalability: Governor limit violations (SOQL/DML queries inside loops in Apex), N+1 queries, unindexed filters, memory leaks, unoptimized loops, blocking synchronous I/O.
   - Maintainability & Standards: Clean Code principles, idiomatic naming, proper error handling, modularity, testability, DRY principles.
4. TONE & STYLE:
   - Concise, direct, actionable, and constructive.
   - For every criticism or bug, provide a concrete code fix or suggested pattern.
   - If the code is clean, well-tested, and safe, state so clearly and approve.

OUTPUT FORMAT:
You MUST respond with a valid JSON object matching the following structure:
{
  "verdict": "APPROVED" | "CHANGES_REQUESTED" | "COMMENT",
  "overallScore": number (1 to 10),
  "summary": string (Markdown summary of overall quality, strengths, and primary concerns),
  "highlights": string[] (List of clean code practices or positive patterns observed),
  "securityAdvisories": [
    {
      "severity": "CRITICAL" | "HIGH" | "MEDIUM" | "LOW",
      "title": string,
      "description": string,
      "cweOrOwasp": string
    }
  ],
  "inlineComments": [
    {
      "filePath": string (Relative path to the modified file),
      "line": number (Line number in the NEW modified file where issue exists),
      "category": "BUG" | "SECURITY" | "PERFORMANCE" | "MAINTAINABILITY" | "STYLE",
      "severity": "BLOCKER" | "WARNING" | "SUGGESTION",
      "comment": string (Actionable feedback explaining why this is an issue and how to fix it),
      "suggestedFix": string (Optional: drop-in replacement code snippet)
    }
  ]
}

Only return the JSON object. Do not include markdown code block backticks (\`\`\`json) or extra text outside the JSON.`;

/**
 * Initializes GoogleGenAI client
 */
export function getGenAIClient(apiKey = process.env.GEMINI_API_KEY) {
  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEY is not set. Please set it in your .env file or environment variables.'
    );
  }
  return new GoogleGenAI({ apiKey });
}

/**
 * Executes an AI-powered code review on a provided PR diff.
 * @param {Object} options
 * @param {string} options.diff Unified diff text of changed code
 * @param {Array<{path: string, status?: string}>} [options.changedFiles] List of changed files
 * @param {string} [options.prTitle] Optional PR title for context
 * @param {string} [options.branchName] Optional branch name
 * @param {string} [options.model] Gemini model name (defaults to gemini-2.5-flash)
 * @returns {Promise<Object>} Structured review result
 */
export async function reviewPullRequestDiff({
  diff,
  changedFiles = [],
  prTitle = '',
  branchName = '',
  model = process.env.GEMINI_MODEL || 'gemini-3.6-flash'
}) {
  if (!diff || diff.trim().length === 0) {
    return {
      verdict: 'APPROVED',
      overallScore: 10,
      summary: 'No code changes found to review.',
      highlights: ['No reviewable diff present.'],
      securityAdvisories: [],
      inlineComments: []
    };
  }

  const ai = getGenAIClient();

  const fileListText = changedFiles.length > 0
    ? changedFiles.map((f) => `- ${f.path || f} (${f.status || 'modified'})`).join('\n')
    : 'Not provided';

  const userPrompt = `Review the following Pull Request code changes:

${prTitle ? `PR Title: ${prTitle}\n` : ''}${branchName ? `Branch: ${branchName}\n` : ''}
Changed Files:
${fileListText}

Unified Diff:
\`\`\`diff
${diff}
\`\`\`

Analyze the code diff strictly for code quality, bugs, security, performance, maintainability, and best practices. Return your analysis as a valid JSON object.`;

  try {
    const response = await ai.models.generateContent({
      model,
      contents: userPrompt,
      config: {
        systemInstruction: CODE_REVIEW_SYSTEM_PROMPT,
        temperature: 0.1,
        responseMimeType: 'application/json'
      }
    });

    const responseText = response.text?.trim() || '';
    if (!responseText) {
      throw new Error('Gemini API returned an empty response.');
    }

    // Parse JSON
    let parsed;
    try {
      parsed = JSON.parse(responseText);
    } catch (parseErr) {
      // Fallback: strip markdown code blocks if present
      const cleanJson = responseText
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
      parsed = JSON.parse(cleanJson);
    }

    // Normalize result structure
    return {
      verdict: ['APPROVED', 'CHANGES_REQUESTED', 'COMMENT'].includes(parsed.verdict)
        ? parsed.verdict
        : (parsed.inlineComments?.some((c) => c.severity === 'BLOCKER') ? 'CHANGES_REQUESTED' : 'APPROVED'),
      overallScore: typeof parsed.overallScore === 'number' ? parsed.overallScore : 8,
      summary: parsed.summary || 'Code review completed.',
      highlights: Array.isArray(parsed.highlights) ? parsed.highlights : [],
      securityAdvisories: Array.isArray(parsed.securityAdvisories) ? parsed.securityAdvisories : [],
      inlineComments: Array.isArray(parsed.inlineComments) ? parsed.inlineComments : []
    };
  } catch (err) {
    console.error('[AI CODE REVIEWER] Generation error:', err);
    throw new Error(`Failed to perform AI code review via Gemini: ${err.message}`);
  }
}
