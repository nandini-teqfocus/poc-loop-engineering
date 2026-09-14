# Plan: SCRUM-9 - Create 2 fields in Contact object

## 1. Context & Dependencies
- **Existing Memory State**: 
  - `agent-context/MEMORY.md` currently records standard `Contact` object fields added in SCRUM-6 (`Blood_Group__c`, `Allergies__c`, `Emergency_Contact_Name__c`, `Emergency_Contact_Phone__c`, `Medical_Conditions__c`).
  - Baseline `Account` has no custom portal fields yet.
- **Dependencies**: 
  - Builds directly upon the standard Salesforce `Contact` object in the target org (`time-sheet`).
  - No conflicting or blocking dependencies.

---

## 2. Technical Specification

### Metadata Files to Create
All metadata files will be created in `force-app/main/default/objects/Contact/fields/`:

1. **`Preferred_Language__c`**
   - **File Path**: `force-app/main/default/objects/Contact/fields/Preferred_Language__c.field-meta.xml`
   - **Label**: `Preferred Language`
   - **API Name**: `Preferred_Language__c`
   - **Data Type**: `Picklist`
   - **Restricted**: `true`
   - **Picklist Values**:
     - `English` (default: `false`)
     - `Spanish` (default: `false`)
     - `French` (default: `false`)
     - `German` (default: `false`)
   - **Description**: Customer preferred communication language.
   - **Help Text (`inlineHelpText`)**: Customer preferred communication language.
   - **Required**: `false`
   - **TrackFeedHistory**: `false`

   **XML Definition (`Preferred_Language__c.field-meta.xml`)**:
   ```xml
   <?xml version="1.0" encoding="UTF-8"?>
   <CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
       <fullName>Preferred_Language__c</fullName>
       <description>Customer preferred communication language.</description>
       <inlineHelpText>Customer preferred communication language.</inlineHelpText>
       <label>Preferred Language</label>
       <required>false</required>
       <trackFeedHistory>false</trackFeedHistory>
       <type>Picklist</type>
       <valueSet>
           <restricted>true</restricted>
           <valueSetDefinition>
               <sorted>false</sorted>
               <value>
                   <fullName>English</fullName>
                   <default>false</default>
                   <label>English</label>
               </value>
               <value>
                   <fullName>Spanish</fullName>
                   <default>false</default>
                   <label>Spanish</label>
               </value>
               <value>
                   <fullName>French</fullName>
                   <default>false</default>
                   <label>French</label>
               </value>
               <value>
                   <fullName>German</fullName>
                   <default>false</default>
                   <label>German</label>
               </value>
           </valueSetDefinition>
       </valueSet>
   </CustomField>
   ```

2. **`Portal_Active__c`**
   - **File Path**: `force-app/main/default/objects/Contact/fields/Portal_Active__c.field-meta.xml`
   - **Label**: `Portal Active`
   - **API Name**: `Portal_Active__c`
   - **Data Type**: `Checkbox`
   - **Default Value (`defaultValue`)**: `false`
   - **Description**: Indicates whether the contact has active access to the experience cloud portal.
   - **Help Text (`inlineHelpText`)**: Indicates whether the contact has active access to the experience cloud portal.
   - **TrackFeedHistory**: `false`

   **XML Definition (`Portal_Active__c.field-meta.xml`)**:
   ```xml
   <?xml version="1.0" encoding="UTF-8"?>
   <CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
       <fullName>Portal_Active__c</fullName>
       <defaultValue>false</defaultValue>
       <description>Indicates whether the contact has active access to the experience cloud portal.</description>
       <inlineHelpText>Indicates whether the contact has active access to the experience cloud portal.</inlineHelpText>
       <label>Portal Active</label>
       <trackFeedHistory>false</trackFeedHistory>
       <type>Checkbox</type>
   </CustomField>
   ```

### Validation Rules
- No validation rules requested for SCRUM-9.

---

## 3. Deployment & Verification Steps

### Deployment Command
Deploy the new field metadata to the target org (`time-sheet`):
```bash
sf project deploy start --metadata CustomField:Contact.Preferred_Language__c,CustomField:Contact.Portal_Active__c --target-org time-sheet
```
Alternatively, deploy via directory:
```bash
sf project deploy start --source-dir force-app/main/default/objects/Contact/fields --target-org time-sheet
```

### Verification Checks
1. Confirm deployment returns exit status 0 with `Created` status for both fields:
   - `Contact.Preferred_Language__c`
   - `Contact.Portal_Active__c`
2. Verify field existence and properties via Salesforce CLI:
   ```bash
   sf data query --query "SELECT Id, Preferred_Language__c, Portal_Active__c FROM Contact LIMIT 1" --target-org time-sheet
   ```
   Or describe the Contact object:
   ```bash
   sf sobject describe --sobject Contact --target-org time-sheet
   ```

---

## 4. Persistent Memory Updates Required

### Updates to `agent-context/MEMORY.md`
Agent 2 must update the `## Contact Object` section in `agent-context/MEMORY.md` to include:

```markdown
- Fields added in SCRUM-9:
  - `Preferred_Language__c` (Picklist: English, Spanish, French, German) - Customer preferred communication language.
  - `Portal_Active__c` (Checkbox: default false) - Indicates whether the contact has active access to the experience cloud portal.
```

### Entry to Append to `agent-context/CHANGELOG.md`
Agent 2 must append the following entry to `agent-context/CHANGELOG.md`:

```markdown
- **Ticket**: SCRUM-9
  - **Date**: 2026-09-14
  - **Summary**: Create custom fields on Contact object (Preferred_Language__c, Portal_Active__c) for language preference and portal access tracking.
  - **Artifacts**:
    - `force-app/main/default/objects/Contact/fields/Preferred_Language__c.field-meta.xml`
    - `force-app/main/default/objects/Contact/fields/Portal_Active__c.field-meta.xml`
  - **PR**: <PR-URL>
```
