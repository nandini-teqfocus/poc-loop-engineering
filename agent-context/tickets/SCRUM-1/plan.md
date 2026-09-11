# Plan: SCRUM-1 - Create 6 custom fields and validation rule on Account

## 1. Context & Dependencies
- **Existing State (from MEMORY.md):** Account object currently has no custom portal fields deployed (baseline state).
- **Dependencies & Pre-conditions:**
  - Target Salesforce org alias: `time-sheet`.
  - Standard Account object availability in target org.
  - Verified org connectivity via `sf org display --target-org time-sheet`.
  - No naming conflicts with existing custom fields on Account.

## 2. Technical Specification

### 2.1 Custom Fields (Object: `Account`)
Location: `force-app/main/default/objects/Account/fields/`

1. **`Industry_Segment__c`**
   - **File:** `force-app/main/default/objects/Account/fields/Industry_Segment__c.field-meta.xml`
   - **Label:** Industry Segment
   - **Type:** Picklist
   - **Values:** `A`, `B`, `C` (restricted: true)
   - **Description:** Industry segmentation classification for portal accounts.

2. **`Renewal_Risk_Score__c`**
   - **File:** `force-app/main/default/objects/Account/fields/Renewal_Risk_Score__c.field-meta.xml`
   - **Label:** Renewal Risk Score
   - **Type:** Number
   - **Precision:** 3
   - **Scale:** 0
   - **Description:** Risk score assessing likelihood of non-renewal (range: 0-100).

3. **`Last_Health_Check__c`**
   - **File:** `force-app/main/default/objects/Account/fields/Last_Health_Check__c.field-meta.xml`
   - **Label:** Last Health Check
   - **Type:** Date
   - **Description:** Date of the most recent customer health check.

4. **`Primary_Competitor__c`**
   - **File:** `force-app/main/default/objects/Account/fields/Primary_Competitor__c.field-meta.xml`
   - **Label:** Primary Competitor
   - **Type:** Text
   - **Length:** 80
   - **Description:** Identified primary competitor associated with the account.

5. **`Contract_Value__c`**
   - **File:** `force-app/main/default/objects/Account/fields/Contract_Value__c.field-meta.xml`
   - **Label:** Contract Value
   - **Type:** Currency
   - **Precision:** 18
   - **Scale:** 2
   - **Description:** Total monetary value of the active contract.

6. **`Auto_Renew__c`**
   - **File:** `force-app/main/default/objects/Account/fields/Auto_Renew__c.field-meta.xml`
   - **Label:** Auto Renew
   - **Type:** Checkbox
   - **Default Value:** `false`
   - **Description:** Indicates whether the account contract automatically renews.

### 2.2 Validation Rule (Object: `Account`)
Location: `force-app/main/default/objects/Account/validationRules/`

1. **`Primary_Competitor_Required_High_Risk`**
   - **File:** `force-app/main/default/objects/Account/validationRules/Primary_Competitor_Required_High_Risk.validationRule-meta.xml`
   - **Rule Name:** `Primary_Competitor_Required_High_Risk`
   - **Active:** `true`
   - **Description:** Requires Primary Competitor to be populated if Renewal Risk Score is greater than 80.
   - **Error Condition Formula:**
     ```
     AND(
         Renewal_Risk_Score__c > 80,
         ISBLANK(Primary_Competitor__c)
     )
     ```
   - **Error Message:** `Primary Competitor is required when Renewal Risk Score is greater than 80.`
   - **Error Display Location:** Field (`Primary_Competitor__c`)

## 3. Deployment & Verification Steps

### 3.1 Branching & Deployment
1. Create and switch to the ticket branch:
   ```bash
   git checkout -b portal/SCRUM-1
   ```
2. Deploy Account metadata to target org `time-sheet`:
   ```bash
   sf project deploy start --target-org time-sheet
   ```

### 3.2 Verification Checks
1. **Field Deployment Verification:**
   Query Account custom fields to verify presence and accessibility:
   ```bash
   sf data query --query "SELECT Id, Industry_Segment__c, Renewal_Risk_Score__c, Last_Health_Check__c, Primary_Competitor__c, Contract_Value__c, Auto_Renew__c FROM Account LIMIT 1" --target-org time-sheet
   ```
2. **Validation Rule Blocking Test (Negative Case):**
   Attempt creating an Account with `Renewal_Risk_Score__c = 85` and no `Primary_Competitor__c`:
   ```bash
   sf data create record --sobject Account --values "Name='Test High Risk Fail' Renewal_Risk_Score__c=85" --target-org time-sheet
   ```
   *Expected Result:* Operation fails with error message: `"Primary Competitor is required when Renewal Risk Score is greater than 80."`
3. **Validation Rule Passing Test (Positive Case):**
   Attempt creating an Account with `Renewal_Risk_Score__c = 85` and `Primary_Competitor__c = 'Competitor ABC'`:
   ```bash
   sf data create record --sobject Account --values "Name='Test High Risk Pass' Renewal_Risk_Score__c=85 Primary_Competitor__c='Competitor ABC'" --target-org time-sheet
   ```
   *Expected Result:* Record created successfully. Clean up test record afterwards.

## 4. Persistent Memory Updates Required

### 4.1 Updates for `agent-context/MEMORY.md`
Update the `## Account Object` section to:
```markdown
## Account Object
- **Custom Portal Fields:**
  - `Industry_Segment__c` (Picklist: A, B, C) - Industry segmentation classification.
  - `Renewal_Risk_Score__c` (Number: 3, 0) - Assessed risk score (0-100).
  - `Last_Health_Check__c` (Date) - Most recent customer health check date.
  - `Primary_Competitor__c` (Text: 80) - Primary competitor name.
  - `Contract_Value__c` (Currency: 18, 2) - Total active contract monetary value.
  - `Auto_Renew__c` (Checkbox) - Indicates auto-renewal agreement status.
- **Validation Rules:**
  - `Primary_Competitor_Required_High_Risk`: Requires `Primary_Competitor__c` when `Renewal_Risk_Score__c > 80`.
```

### 4.2 Entry to Append to `agent-context/CHANGELOG.md`
```markdown
### [SCRUM-1] - 2026-09-11
- **Summary:** Created 6 custom fields and validation rule on Account for portal tracking.
- **Artifacts:**
  - `force-app/main/default/objects/Account/fields/Industry_Segment__c.field-meta.xml`
  - `force-app/main/default/objects/Account/fields/Renewal_Risk_Score__c.field-meta.xml`
  - `force-app/main/default/objects/Account/fields/Last_Health_Check__c.field-meta.xml`
  - `force-app/main/default/objects/Account/fields/Primary_Competitor__c.field-meta.xml`
  - `force-app/main/default/objects/Account/fields/Contract_Value__c.field-meta.xml`
  - `force-app/main/default/objects/Account/fields/Auto_Renew__c.field-meta.xml`
  - `force-app/main/default/objects/Account/validationRules/Primary_Competitor_Required_High_Risk.validationRule-meta.xml`
- **PR:** <PR_URL>
```
