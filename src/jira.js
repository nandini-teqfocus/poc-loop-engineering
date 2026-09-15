import 'dotenv/config';

function getJiraConfig() {
  const rawUrl = process.env.JIRA_BASE_URL?.trim();
  if (!rawUrl) throw new Error('JIRA_BASE_URL is missing in .env');
  const baseUrl = new URL(rawUrl).origin;
  const email = process.env.JIRA_USER_EMAIL?.trim();
  const token = process.env.JIRA_API_TOKEN?.trim();
  if (!email || !token) throw new Error('JIRA_USER_EMAIL or JIRA_API_TOKEN is missing in .env');

  const authHeader = 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
  return { baseUrl, authHeader };
}

/**
 * Constructs the direct browser URL for a given JIRA issue
 * @param {string} issueKey E.g. SCRUM-6
 * @returns {string} E.g. https://snandini548.atlassian.net/browse/SCRUM-6
 */
export function getJiraTicketUrl(issueKey) {
  try {
    const rawUrl = process.env.JIRA_BASE_URL?.trim();
    if (!rawUrl) return null;
    const baseUrl = new URL(rawUrl).origin;
    return `${baseUrl}/browse/${encodeURIComponent(issueKey)}`;
  } catch (e) {
    return null;
  }
}

export function extractTextFromAdf(doc) {
  if (!doc) return '';
  if (typeof doc === 'string') return doc;
  let text = '';
  function walk(node) {
    if (node.type === 'text' && node.text) {
      text += node.text;
    }
    if (node.content && Array.isArray(node.content)) {
      for (const child of node.content) {
        walk(child);
      }
      if (node.type === 'paragraph' || node.type === 'listItem') {
        text += '\n';
      }
    }
  }
  walk(doc);
  return text.trim();
}

export async function getJiraIssue(issueKey) {

  const { baseUrl, authHeader } = getJiraConfig();
  const res = await fetch(`${baseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}`, {
    headers: {
      'Authorization': authHeader,
      'Accept': 'application/json'
    }
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to get JIRA issue ${issueKey}: ${res.status} ${text}`);
  }

  return await res.json();
}

export async function addJiraComment(issueKey, commentText) {
  const { baseUrl, authHeader } = getJiraConfig();
  const payload = {
    body: {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: commentText
            }
          ]
        }
      ]
    }
  };

  const res = await fetch(`${baseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, {
    method: 'POST',
    headers: {
      'Authorization': authHeader,
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to add comment to JIRA issue ${issueKey}: ${res.status} ${text}`);
  }

  return await res.json();
}

export async function transitionJiraIssue(issueKey, targetStatusNames) {
  const { baseUrl, authHeader } = getJiraConfig();
  const targets = Array.isArray(targetStatusNames) ? targetStatusNames : [targetStatusNames];

  // 1. Get available transitions
  const res = await fetch(`${baseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`, {
    headers: {
      'Authorization': authHeader,
      'Accept': 'application/json'
    }
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to get transitions for JIRA issue ${issueKey}: ${res.status} ${text}`);
  }

  const data = await res.json();
  const transitions = data.transitions || [];

  const matched = transitions.find(t =>
    targets.some(name => t.name.toLowerCase() === name.toLowerCase())
  );

  if (!matched) {
    console.warn(`[JIRA] No transition matching [${targets.join(', ')}] found for ${issueKey}. Available: ${transitions.map(t => t.name).join(', ')}`);
    return false;
  }

  // 2. Perform the transition
  const transRes = await fetch(`${baseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`, {
    method: 'POST',
    headers: {
      'Authorization': authHeader,
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      transition: { id: matched.id }
    })
  });

  if (!transRes.ok) {
    const text = await transRes.text();
    throw new Error(`Failed to transition JIRA issue ${issueKey} to ${matched.name}: ${transRes.status} ${text}`);
  }

  console.log(`[JIRA] Transitioned ${issueKey} to '${matched.name}' (id: ${matched.id})`);
  return true;
}

export async function createJiraIssue({ projectKey = 'SCRUM', summary, description, issueTypeName = 'Task' }) {
  const { baseUrl, authHeader } = getJiraConfig();

  const content = [];
  const paragraphs = description.split('\n\n');
  for (const para of paragraphs) {
    if (!para.trim()) continue;
    content.push({
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: para.trim()
        }
      ]
    });
  }

  const payload = {
    fields: {
      project: { key: projectKey },
      summary,
      description: {
        type: 'doc',
        version: 1,
        content: content.length > 0 ? content : [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: description || summary }]
          }
        ]
      },
      issuetype: { name: issueTypeName }
    }
  };

  const res = await fetch(`${baseUrl}/rest/api/3/issue`, {
    method: 'POST',
    headers: {
      'Authorization': authHeader,
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to create JIRA issue: ${res.status} ${text}`);
  }

  const issueData = await res.json();

  // If there is an active sprint on the board, move the issue into it so it appears on the active board
  try {
    const boardRes = await fetch(`${baseUrl}/rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(projectKey)}`, {
      headers: { 'Authorization': authHeader, 'Accept': 'application/json' }
    });
    if (boardRes.ok) {
      const boardData = await boardRes.json();
      const boardId = boardData.values?.[0]?.id;
      if (boardId) {
        const sprintRes = await fetch(`${baseUrl}/rest/agile/1.0/board/${boardId}/sprint?state=active`, {
          headers: { 'Authorization': authHeader, 'Accept': 'application/json' }
        });
        if (sprintRes.ok) {
          const sprintData = await sprintRes.json();
          const activeSprintId = sprintData.values?.[0]?.id;
          if (activeSprintId) {
            await fetch(`${baseUrl}/rest/agile/1.0/sprint/${activeSprintId}/issue`, {
              method: 'POST',
              headers: {
                'Authorization': authHeader,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({ issues: [issueData.key] })
            });
          }
        }
      }
    }
  } catch (e) {
    // Non-fatal if agile sprint assignment is unavailable
  }

  return issueData;
}

/**
 * Searches JIRA issues using JQL via /rest/api/3/search/jql
 * @param {Object} options
 * @param {string} options.jql JQL query string
 * @param {Array<string>} options.fields Fields to return
 * @param {number} options.maxResults Max number of issues
 * @returns {Promise<Array>} List of matched issues
 */
export async function searchJiraIssues({ jql, fields = ['summary', 'status', 'description', 'updated'], maxResults = 10 }) {
  const { baseUrl, authHeader } = getJiraConfig();
  try {
    const res = await fetch(`${baseUrl}/rest/api/3/search/jql`, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        jql,
        maxResults,
        fields
      })
    });

    if (!res.ok) {
      const text = await res.text();
      console.warn(`[JIRA] searchJiraIssues failed (${res.status}):`, text.substring(0, 150));
      return [];
    }

    const data = await res.json();
    return data.issues || [];
  } catch (err) {
    console.warn(`[JIRA] searchJiraIssues exception:`, err.message);
    return [];
  }
}
