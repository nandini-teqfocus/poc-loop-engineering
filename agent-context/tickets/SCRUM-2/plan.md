# Plan: SCRUM-2 - Expose Renewal Risk Score and add Customer Tier on Account

## 1. Context & Dependencies
- **Existing State (from MEMORY.md & target org):**
  - Builds upon the Account custom fields introduced in SCRUM-1, specifically `Renewal_Risk_Score__c` (Number: 3, 0).
  - Target org `time-sheet` already has `Renewal_Risk_Score__c` deployed.
  - In git, `SCRUM-1` is on branch `portal/SCRUM-1` (PR #1 open). 
- **Dependencies & Pre-conditions:**
  - Target Salesforce org alias: `time-sheet`.
  - Target org username: `nandini.singh.c2d90108260b@agentforce.com`.
  - Standard Account object and standard layout `Account-Account Layout` are available in target org.
  - When working on `portal/SCRUM-2`, Agent 2 must incorporate `portal/SCRUM-1` branch changes (or merge `portal/SCRUM-1` into `portal/SCRUM-2`) so that metadata for `Renewal_Risk_Score__c` and SCRUM-1 artifacts are present.

## 2. Technical Specification

### 2.1 Custom Field: `Customer_Tier__c` (Object: `Account`)
- **File:** `force-app/main/default/objects/Account/fields/Customer_Tier__c.field-meta.xml`
- **API Name:** `Customer_Tier__c`
- **Label:** Customer Tier
- **Data Type:** Picklist
- **Required:** false
- **Description:** Customer segmentation classification tier for portal accounts.
- **Help Text:** Select the customer tier classification (Gold, Silver, Bronze).
- **Picklist Definition:**
  - Values: `Gold`, `Silver`, `Bronze`
  - Restricted: `true`
  - Sorted: `false`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Customer_Tier__c</fullName>
    <description>Customer segmentation classification tier for portal accounts.</description>
    <externalId>false</externalId>
    <inlineHelpText>Select the customer tier classification (Gold, Silver, Bronze).</inlineHelpText>
    <label>Customer Tier</label>
    <required>false</required>
    <trackFeedHistory>false</trackFeedHistory>
    <type>Picklist</type>
    <valueSet>
        <restricted>true</restricted>
        <valueSetDefinition>
            <sorted>false</sorted>
            <value>
                <fullName>Gold</fullName>
                <default>false</default>
                <label>Gold</label>
            </value>
            <value>
                <fullName>Silver</fullName>
                <default>false</default>
                <label>Silver</label>
            </value>
            <value>
                <fullName>Bronze</fullName>
                <default>false</default>
                <label>Bronze</label>
            </value>
        </valueSetDefinition>
    </valueSet>
</CustomField>
```

### 2.2 Page Layout: `Account-Account Layout`
- **File:** `force-app/main/default/layouts/Account-Account Layout.layout-meta.xml`
- **Action:**
  - Retrieve the standard layout from org:
    ```bash
    sf project retrieve start --metadata Layout:Account-Account Layout --target-org time-sheet
    ```
  - Place `Customer_Tier__c` and `Renewal_Risk_Score__c` into the layout XML under the "Additional Information" or "Account Information" section.
  - Layout items:
    ```xml
    <layoutItems>
        <behavior>Edit</behavior>
        <field>Customer_Tier__c</field>
    </layoutItems>
    <layoutItems>
        <behavior>Edit</behavior>
        <field>Renewal_Risk_Score__c</field>
    </layoutItems>
    ```

## 3. Deployment & Verification Steps

### 3.1 Git Branching & Deployment
1. Create and switch to the ticket branch:
   ```bash
   git checkout -b portal/SCRUM-2
   ```
2. Merge `portal/SCRUM-1` to ensure base metadata is intact:
   ```bash
   git merge portal/SCRUM-1 --no-edit
   ```
3. Deploy changes to target org `time-sheet`:
   ```bash
   sf project deploy start --target-org time-sheet
   ```

### 3.2 Verification Checks
1. **SOQL Field Verification:**
   Verify `Customer_Tier__c` and `Renewal_Risk_Score__c` query successfully:
   ```bash
   sf data query --query "SELECT Id, Name, Customer_Tier__c, Renewal_Risk_Score__c FROM Account LIMIT 1" --target-org time-sheet
   ```
2. **Picklist Valid Value Test (Positive):**
   Create a test Account with valid tier and risk score:
   ```bash
   sf data create record --sobject Account --values "Name='Test Tier Account' Customer_Tier__c='Gold' Renewal_Risk_Score__c=50" --target-org time-sheet
   ```
   *Expected Result:* Successfully creates Account record.
3. **Restricted Picklist Test (Negative):**
   Attempt creating an Account with an invalid picklist value:
   ```bash
   sf data create record --sobject Account --values "Name='Test Invalid Tier' Customer_Tier__c='Platinum'" --target-org time-sheet
   ```
   *Expected Result:* Operation rejected due to restricted picklist violation.
4. **Layout Verification:**
   Verify deployment of `force-app/main/default/layouts/Account-Account Layout.layout-meta.xml` completes with status Succeeded.

## 4. Persistent Memory Updates Required

### 4.1 Updates for `agent-context/MEMORY.md`
Update the `## Account Object` section to:
```markdown
## Account Object
- **Custom Portal Fields:**
  - `Industry_Segment__c` (Picklist: A, B, C) - Industry segmentation classification.
  - `Renewal_Risk_Score__c` (Number: 3, 0) - Assessed risk score (0-100). Exposed on standard Account Page Layout.
  - `Customer_Tier__c` (Picklist: Gold, Silver, Bronze) - Customer segmentation classification tier. Exposed on standard Account Page Layout.
  - `Last_Health_Check__c` (Date) - Most recent customer health check date.
  - `Primary_Competitor__c` (Text: 80) - Primary competitor name.
  - `Contract_Value__c` (Currency: 18, 2) - Total active contract monetary value.
  - `Auto_Renew__c` (Checkbox) - Indicates auto-renewal agreement status.
- **Validation Rules:**
  - `Primary_Competitor_Required_High_Risk`: Requires `Primary_Competitor__c` when `Renewal_Risk_Score__c > 80`.
- **Page Layouts:**
  - `Account-Account Layout`: Exposes `Renewal_Risk_Score__c` and `Customer_Tier__c` for portal/account segmentation.
```

### 4.2 Entry to Append to `agent-context/CHANGELOG.md`
```markdown
### [SCRUM-2] - 2026-09-11
- **Summary:** Added Customer_Tier__c picklist (Gold, Silver, Bronze) on Account and exposed Customer_Tier__c and Renewal_Risk_Score__c on Account-Account Layout.
- **Artifacts:**
  - `force-app/main/default/objects/Account/fields/Customer_Tier__c.field-meta.xml`
  - `force-app/main/default/layouts/Account-Account Layout.layout-meta.xml`
- **PR:** <PR_URL>
```
