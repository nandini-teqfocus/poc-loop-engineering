# Plan: SCRUM-10 - Create 2 Fields in Account Object

## 1. Context & Dependencies
- **Existing Memory State**: Current `agent-context/MEMORY.md` records that the `Account` object has no custom portal fields deployed yet (baseline state). Custom fields have previously been added to `Contact` (SCRUM-6) and `Opportunity` (SCRUM-8).
- **Dependencies**: Standard Salesforce `Account` object exists out-of-the-box in the target org (`time-sheet`). No custom object dependencies or upstream prerequisites exist.
- **Clarification / Ambiguity**: None. The ticket description specifies exact field names, data types, picklist values (`Standard`, `Silver`, `Gold`, `Platinum`), and help texts for both fields.

---

## 2. Technical Specification

### Metadata Files to Create
All custom field metadata files will be created under `force-app/main/default/objects/Account/fields/`:

1. **`Service_Tier__c`**
   - **File Path**: `force-app/main/default/objects/Account/fields/Service_Tier__c.field-meta.xml`
   - **Label**: `Service Tier`
   - **API Name**: `Service_Tier__c`
   - **Data Type**: `Picklist`
   - **Restricted**: `true`
   - **Required**: `false`
   - **Picklist Values**:
     - `Standard` (default: `false`, label: `Standard`)
     - `Silver` (default: `false`, label: `Silver`)
     - `Gold` (default: `false`, label: `Gold`)
     - `Platinum` (default: `false`, label: `Platinum`)
   - **Description**: Customer service level tier (Standard, Silver, Gold, Platinum).
   - **Help Text**: Customer service level tier.

2. **`Onboarding_Date__c`**
   - **File Path**: `force-app/main/default/objects/Account/fields/Onboarding_Date__c.field-meta.xml`
   - **Label**: `Onboarding Date`
   - **API Name**: `Onboarding_Date__c`
   - **Data Type**: `Date`
   - **Required**: `false`
   - **Description**: Date when account onboarding was officially completed.
   - **Help Text**: Date when account onboarding was officially completed.

### Validation Rules
- No validation rules requested in ticket SCRUM-10.

---

## 3. Deployment & Verification Steps

### Target Environment
- **Target Org Alias**: `time-sheet`
- **Target Org Username**: `nandini.singh.c2d90108260b@agentforce.com`

### Deployment Command
Deploy the new Account custom fields to the target org using the Salesforce CLI:
```bash
sf project deploy start --metadata CustomField:Account.Service_Tier__c,CustomField:Account.Onboarding_Date__c --target-org time-sheet
```
Or deploy via the source directory:
```bash
sf project deploy start --source-dir force-app/main/default/objects/Account --target-org time-sheet
```

### Verification Checks
1. Ensure the Salesforce CLI deployment output reports `Status: Succeeded` and lists `Created` for both fields:
   - `Account.Service_Tier__c`
   - `Account.Onboarding_Date__c`
2. Verify metadata existence in target org:
   ```bash
   sf sobject describe --sobject Account --target-org time-sheet
   ```
   Confirm both `Service_Tier__c` (Picklist with values `Standard`, `Silver`, `Gold`, `Platinum`) and `Onboarding_Date__c` (Date) are present in the describe output.

---

## 4. Persistent Memory Updates Required

### Updates to `agent-context/MEMORY.md`
Agent 2 must update the `## Account Object` section in `agent-context/MEMORY.md` to:

```markdown
## Account Object
- Fields added in SCRUM-10:
  - `Service_Tier__c` (Picklist: Standard, Silver, Gold, Platinum) - Customer service level tier.
  - `Onboarding_Date__c` (Date) - Date when account onboarding was officially completed.
- Not yet done: Fields not yet exposed on Experience Cloud portal account record pages or layouts.
```

### Entry to Append to `agent-context/CHANGELOG.md`
Agent 2 must append the following entry to `agent-context/CHANGELOG.md`:

```markdown
- **Ticket**: SCRUM-10
  - **Date**: 2026-09-14
  - **Summary**: Create 2 custom fields on Account object (Service_Tier__c, Onboarding_Date__c).
  - **Artifacts**:
    - `force-app/main/default/objects/Account/fields/Service_Tier__c.field-meta.xml`
    - `force-app/main/default/objects/Account/fields/Onboarding_Date__c.field-meta.xml`
  - **PR**: <PR-URL>
```
