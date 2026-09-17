# Plan: SCRUM-13 - Create a Custom Field on Opportunity

## 1. Context & Dependencies
- **Existing Memory State**: Current `agent-context/MEMORY.md` records baseline state for `Account`, contact fields from `SCRUM-6`, and opportunity fields from `SCRUM-8` (`Insurance_Provider__c`, `Coverage_Status__c`).
- **Dependencies**: Standard Salesforce `Opportunity` object in the target org (`time-sheet`). Builds harmoniously upon the existing Opportunity object metadata in `force-app/main/default/objects/Opportunity/`.
- **Clarification / Ambiguity**: None. Field requirements are completely defined:
  - Object: `Opportunity`
  - Field Name: `External_Contract_Id__c`
  - Data Type: `Text(50)`
  - External ID: `true` (indexed)
  - Unique: `false`
  - Description: `Stores the unique identifier of the contract from external billing platform.`

---

## 2. Technical Specification

### Metadata Files to Create
A new custom field metadata file will be created under `force-app/main/default/objects/Opportunity/fields/`:

1. **`External_Contract_Id__c`**
   - **File Path**: `force-app/main/default/objects/Opportunity/fields/External_Contract_Id__c.field-meta.xml`
   - **Label**: `External Contract ID`
   - **API Name**: `External_Contract_Id__c`
   - **Data Type**: `Text`
   - **Length**: `50`
   - **External ID**: `true`
   - **Unique**: `false`
   - **Required**: `false`
   - **Track Feed History**: `false`
   - **Description**: `Stores the unique identifier of the contract from external billing platform.`
   - **Help Text**: `Enter the unique identifier of the contract from the external billing platform.`

#### XML Definition:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>External_Contract_Id__c</fullName>
    <description>Stores the unique identifier of the contract from external billing platform.</description>
    <externalId>true</externalId>
    <inlineHelpText>Enter the unique identifier of the contract from the external billing platform.</inlineHelpText>
    <label>External Contract ID</label>
    <length>50</length>
    <required>false</required>
    <trackFeedHistory>false</trackFeedHistory>
    <type>Text</type>
    <unique>false</unique>
</CustomField>
```

### Validation Rules
- No validation rules requested for SCRUM-13.

---

## 3. Deployment & Verification Steps

### Target Environment
- **Target Org Alias**: `time-sheet`
- **Target Org Username**: `nandini.singh.c2d90108260b@agentforce.com`

### Deployment Command
Deploy the new custom field metadata to the target org using the Salesforce CLI:
```bash
sf project deploy start --metadata CustomField:Opportunity.External_Contract_Id__c --target-org time-sheet
```
Or deploy via source directory:
```bash
sf project deploy start --source-dir force-app/main/default/objects/Opportunity/fields/External_Contract_Id__c.field-meta.xml --target-org time-sheet
```

### Verification Checks
1. Confirm CLI output indicates `Status: Succeeded` with component status `Created` for `Opportunity.External_Contract_Id__c`.
2. Inspect target org metadata describe:
   ```bash
   sf sobject describe --sobject Opportunity --target-org time-sheet
   ```
   Verify `External_Contract_Id__c` exists and has:
   - `type`: `string`
   - `length`: `50`
   - `externalId`: `true`
   - `idLookup`: `true`
   - `unique`: `false`
3. Validate all Acceptance Criteria:
   - Metadata file exists under `force-app/main/default/objects/Opportunity/fields/External_Contract_Id__c.field-meta.xml`.
   - Field is successfully deployed to target org `time-sheet`.
   - Field is marked as External ID and indexed.

---

## 4. Persistent Memory Updates Required

### Updates to `agent-context/MEMORY.md`
Agent 2 must update the `## Opportunity Object` section in `agent-context/MEMORY.md` as follows:

```markdown
## Opportunity Object
- Fields added in SCRUM-8:
  - `Insurance_Provider__c` (Text, 255) - Name of insurance provider (e.g., Blue Cross).
  - `Coverage_Status__c` (Picklist: Active, Expired, Pending) - Current status of insurance coverage.
- Fields added in SCRUM-13:
  - `External_Contract_Id__c` (Text, 50, External ID) - Stores the unique identifier of the contract from external billing platform.
- Not yet done: Fields not yet exposed on Experience Cloud portal opportunity record pages or layouts.
```

### Entry to Append to `agent-context/CHANGELOG.md`
Agent 2 must append the following entry to `agent-context/CHANGELOG.md`:

```markdown
- **Ticket**: SCRUM-13
  - **Date**: 2026-09-17
  - **Summary**: Create custom field External_Contract_Id__c (Text(50), External ID) on Opportunity object.
  - **Artifacts**:
    - `force-app/main/default/objects/Opportunity/fields/External_Contract_Id__c.field-meta.xml`
  - **PR**: <PR-URL>
```
