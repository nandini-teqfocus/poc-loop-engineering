import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { reviewPullRequestDiff } from '../src/aiCodeReviewer.js';
import { getPullRequestDiff, getPullRequestDetails } from '../src/githubPrClient.js';

console.log('======================================================');
console.log('🧪 Gemini AI Code Review - Local Diagnostic & Test Suite');
console.log('======================================================\n');

if (!process.env.GEMINI_API_KEY) {
  console.error('❌ Error: GEMINI_API_KEY is not configured in .env');
  process.exit(1);
}

// Sample diff containing a known security vulnerability and performance flaw for testing
const SAMPLE_BUGGY_DIFF = `
diff --git a/force-app/main/default/classes/AccountContactService.cls b/force-app/main/default/classes/AccountContactService.cls
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/force-app/main/default/classes/AccountContactService.cls
@@ -0,0 +1,25 @@
+public without sharing class AccountContactService {
+    // Hardcoded API token (Critical Security Vulnerability)
+    private static final String API_SECRET = "DEMO_HARDCODED_API_KEY_12345";
+
+    public static void updateContactsForAccounts(List<Id> accountIds) {
+        for (Id accId : accountIds) {
+            // SOQL Query inside a loop (Salesforce Governor Limit Violation)
+            List<Contact> contacts = [SELECT Id, Name, Email FROM Contact WHERE AccountId = :accId];
+            
+            for (Contact c : contacts) {
+                if (c.Email == null) {
+                    // Potential NullPointerException if Name is null
+                    String domain = c.Name.toLowerCase().replaceAll(" ", "") + "@default.com";
+                    c.Email = domain;
+                }
+                // DML inside a loop (Governor Limit Violation)
+                update c;
+            }
+        }
+    }
+}
+`;

async function run() {
  const prArgIdx = process.argv.indexOf('--pr');
  if (prArgIdx !== -1 && process.argv[prArgIdx + 1]) {
    const prNumber = process.argv[prArgIdx + 1];
    console.log(`[TEST] Testing AI Review against live PR #${prNumber}...`);

    const details = getPullRequestDetails(prNumber);
    console.log(`Title: ${details.title}`);
    console.log(`Reviewable files: ${details.reviewableFiles.length}`);

    const diff = getPullRequestDiff(prNumber);
    console.log(`Diff length: ${diff.length} characters`);

    console.log('\n[TEST] Running Gemini analysis...');
    const result = await reviewPullRequestDiff({
      diff,
      changedFiles: details.reviewableFiles,
      prTitle: details.title,
      branchName: details.headBranch
    });

    console.log('\n--- REVIEW RESULT ---');
    console.log(JSON.stringify(result, null, 2));
    console.log('\n✅ Live PR review test completed successfully.');
    return;
  }

  // Default: run against fixture
  console.log('[TEST] Running against sample vulnerable Salesforce Apex diff...');
  const result = await reviewPullRequestDiff({
    diff: SAMPLE_BUGGY_DIFF,
    changedFiles: [{ path: 'force-app/main/default/classes/AccountContactService.cls', status: 'added' }],
    prTitle: 'Add AccountContactService class',
    branchName: 'feature/account-service'
  });

  console.log('\n--- REVIEW RESULT ---');
  console.log(`Verdict:     ${result.verdict}`);
  console.log(`Score:       ${result.overallScore} / 10`);
  console.log(`Summary:     ${result.summary}`);
  console.log('\nSecurity Advisories:');
  console.log(JSON.stringify(result.securityAdvisories, null, 2));
  console.log('\nInline Comments:');
  console.log(JSON.stringify(result.inlineComments, null, 2));

  // Assert expected detections
  const foundSecurity = result.securityAdvisories.length > 0 ||
    result.inlineComments.some(c => c.category === 'SECURITY');
  const foundPerformance = result.inlineComments.some(c => c.category === 'PERFORMANCE' || c.comment.toLowerCase().includes('loop'));

  console.log('\n--- VERIFICATION CHECKS ---');
  console.log(`[CHECK] Security flaw detected:      ${foundSecurity ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`[CHECK] Governor limit detected:     ${foundPerformance ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`[CHECK] Verdict is CHANGES_REQUESTED: ${result.verdict === 'CHANGES_REQUESTED' ? '✅ PASS' : '❌ FAIL'}`);

  if (foundSecurity && foundPerformance && result.verdict === 'CHANGES_REQUESTED') {
    console.log('\n🎉 ALL CHECKS PASSED: Gemini AI accurately identified code quality, security, and performance defects!');
  } else {
    console.warn('\n⚠️ Some checks did not match exact expectations. Review model outputs above.');
  }
}

run().catch((err) => {
  console.error('\n❌ Test failed with error:', err.message);
  process.exit(1);
});
