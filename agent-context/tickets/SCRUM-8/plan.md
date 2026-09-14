# Plan: SCRUM-8 - Create 2 Fields in Opportunity Object

## 1. Context & Dependencies
- **Existing Memory State**: Current `agent-context/MEMORY.md` tracks baseline `Account` object state and custom fields on `Contact` added in `SCRUM-6`. The `Opportunity` object has no custom portal fields registered in `MEMORY.md`.
- **Dependencies**: Standard Salesforce `Opportunity` object exists out-of-the-box in the target org (`time-sheet`). No custom object dependencies or upstream prerequisites.
- **Clarification / Ambiguity**: None. The ticket description specifies exact field names, data types, and picklist values (`Insurance Provider`: Text; `Coverage Status`: Picklist with values `Active`, `Expired`, `Pending`). Standard Salesforce text field length of 255 characters will be applied.

---

## 2. Technical Specification

### Metadata Files to Create
All custom field metadata files will be created under `force-app/main/default/objects/Opportunity/fields/`:

1. **`Insurance_Provider__c`**
   - **File Path**: `force-app/main/default/objects/Opportunity/fields/Insurance_Provider__c.field-meta.xml`
   - **Label**: `Insurance Provider`
   - **API Name**: `Insurance_Provider__c`
   - **Data Type**: `Text`
   - **Length**: `255`
   - **Required**: `false`
   - **External ID**: `false`
   - **Unique**: `false`
   - **Track Trending**: `false`
   - **Description**: Name of the insurance provider associated with the opportunity (e.g., Blue Cross).
   - **Help Text**: Enter the name of the insurance provider.

2. **`Coverage_Status__c`**
   - **File Path**: `force-app/main/default/objects/Opportunity/fields/Coverage_Status__c.field-meta.xml`
   - **Label**: `Coverage Status`
   - **API Name**: `Coverage_Status__c`
   - **Data Type**: `Picklist`
   - **Restricted**: `true`
   - **Required**: `false`
   - **Picklist Values**:
     - `Active` (default: `false`, label: `Active`)
     - `Expired` (default: `false`, label: `Expired`)
     - `Pending` (default: `false`, label: `Pending`)
   - **Description**: Current status of the insurance coverage (Active, Expired, Pending).
   - **Help Text**: Select the current insurance coverage status.

### Validation Rules
- No validation rules requested in ticket SCRUM-8.

---

## 3. Deployment & Verification Steps

### Target Environment
- **Target Org Alias**: `time-sheet`
- **Target Org Username**: `nandini.singh.c2d90108260b@agentforce.com`

### Deployment Command
Deploy the new Opportunity custom fields to the target org using the Salesforce CLI:
```bash
sf project deploy start --metadata CustomField:Opportunity.Insurance_Provider__c,CustomField:Opportunity.Coverage_Status__c --target-org time-sheet
```
Or deploy via the source directory:
```bash
sf project deploy start --source-dir force-app/main/default/objects/Opportunity --target-org time-sheet
```

### Verification Checks
1. Ensure the Salesforce CLI deployment output reports `Status: Succeeded` and lists `Created` for both fields:
   - `Opportunity.Insurance_Provider__c`
   - `Opportunity.Coverage_Status__c`
2. Verify metadata existence in target org:
   ```bash
   sf sobject describe --sobject Opportunity --target-org time-sheet
   ```
   Confirm both `Insurance_Provider__c` (Text, length 255) and `Coverage_Status__c` (Picklist with values `Active`, `Expired`, `Pending`) are present in the describe output.

---

## 4. Persistent Memory Updates Required

### Updates to `agent-context/MEMORY.md`
Agent 2 must append the following section to `agent-context/MEMORY.md`:

```markdown
## Opportunity Object
- Fields added in SCRUM-8:
  - `Insurance_Provider__c` (Text, 255) - Name of insurance provider (e.g., Blue Cross).
  - `Coverage_Status__c` (Picklist: Active, Expired, Pending) - Current status of insurance coverage.
- Not yet done: Fields not yet exposed on Experience Cloud portal opportunity record pages or layouts.
```

### Entry to Append to `agent-context/CHANGELOG.md`
Agent 2 must append the following entry to `agent-context/CHANGELOG.md`:

```markdown
- **Ticket**: SCRUM-8
  - **Date**: 2026-09-14
  - **Summary**: Create 2 fields on Opportunity object (Insurance_Provider__c, Coverage_Status__c).
  - **Artifacts**:
    - `force-app/main/default/objects/Opportunity/fields/Insurance_Provider__c.field-meta.xml`
    - `force-app/main/default/objects/Opportunity/fields/Coverage_Status__c.field-meta.xml`
  - **PR**: <PR-URL>
```
