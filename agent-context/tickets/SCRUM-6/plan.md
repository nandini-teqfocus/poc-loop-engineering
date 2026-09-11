# Plan: SCRUM-6 - Create Fields on Contact Object

## 1. Context & Dependencies
- **Existing Memory State**: Current `agent-context/MEMORY.md` reflects a baseline state with no custom fields on `Contact` (only baseline `Account` object recorded).
- **Dependencies**: None. Standard Salesforce `Contact` object exists out-of-the-box in the target org (`time-sheet`).
- **Clarification Resolved**: Developer confirmed Option A for `Blood_Group__c` — include all 8 standard blood types (`A+`, `A-`, `B+`, `B-`, `O+`, `O-`, `AB+`, `AB-`).

---

## 2. Technical Specification

### Metadata Files to Create
All metadata files will be created in `force-app/main/default/objects/Contact/fields/`:

1. **`Blood_Group__c`**
   - **File Path**: `force-app/main/default/objects/Contact/fields/Blood_Group__c.field-meta.xml`
   - **Label**: `Blood Group`
   - **Data Type**: `Picklist`
   - **Restricted**: `true`
   - **Picklist Values**: `A+`, `A-`, `B+`, `B-`, `O+`, `O-`, `AB+`, `AB-`
   - **Description**: Contact's blood group for health/emergency records.
   - **Help Text**: Select the contact's blood group.

2. **`Allergies__c`**
   - **File Path**: `force-app/main/default/objects/Contact/fields/Allergies__c.field-meta.xml`
   - **Label**: `Allergies`
   - **Data Type**: `LongTextArea`
   - **Length**: `32768`
   - **Visible Lines**: `3`
   - **Description**: Known allergies for the contact (e.g., Penicillin, Peanuts).
   - **Help Text**: Specify any known allergies.

3. **`Emergency_Contact_Name__c`**
   - **File Path**: `force-app/main/default/objects/Contact/fields/Emergency_Contact_Name__c.field-meta.xml`
   - **Label**: `Emergency Contact Name`
   - **Data Type**: `Text`
   - **Length**: `255`
   - **Description**: Name of the designated emergency contact person.
   - **Help Text**: Enter the full name of the emergency contact.

4. **`Emergency_Contact_Phone__c`**
   - **File Path**: `force-app/main/default/objects/Contact/fields/Emergency_Contact_Phone__c.field-meta.xml`
   - **Label**: `Emergency Contact Phone`
   - **Data Type**: `Phone`
   - **Description**: Phone number of the emergency contact person.
   - **Help Text**: Enter the phone number of the emergency contact.

5. **`Medical_Conditions__c`**
   - **File Path**: `force-app/main/default/objects/Contact/fields/Medical_Conditions__c.field-meta.xml`
   - **Label**: `Medical Conditions`
   - **Data Type**: `LongTextArea`
   - **Length**: `32768`
   - **Visible Lines**: `3`
   - **Description**: Known medical conditions of the contact (e.g., Diabetes, Asthma).
   - **Help Text**: Specify any known medical conditions.

### Validation Rules
- No validation rules requested in ticket SCRUM-6.

---

## 3. Deployment & Verification Steps

### Deployment Command
Deploy the new metadata to the target org (`time-sheet`):
```bash
sf project deploy start --metadata CustomField:Contact.Blood_Group__c,CustomField:Contact.Allergies__c,CustomField:Contact.Emergency_Contact_Name__c,CustomField:Contact.Emergency_Contact_Phone__c,CustomField:Contact.Medical_Conditions__c --target-org time-sheet
```
Or deploy the whole Contact object directory:
```bash
sf project deploy start --source-dir force-app/main/default/objects/Contact --target-org time-sheet
```

### Verification Checks
1. Confirm deployment success message and component status `Created` for all 5 custom fields.
2. Query Salesforce metadata to confirm fields exist:
   ```bash
   sf sobject describe --sobject Contact --target-org time-sheet
   ```
   Verify `Blood_Group__c`, `Allergies__c`, `Emergency_Contact_Name__c`, `Emergency_Contact_Phone__c`, and `Medical_Conditions__c` are present.

---

## 4. Persistent Memory Updates Required

### Updates to `agent-context/MEMORY.md`
Agent 2 must append the following section to `agent-context/MEMORY.md`:

```markdown
## Contact Object
- Fields added in SCRUM-6:
  - `Blood_Group__c` (Picklist: A+, A-, B+, B-, O+, O-, AB+, AB-) - Health/emergency record.
  - `Allergies__c` (Long Text Area, 32768) - Tracks contact allergies.
  - `Emergency_Contact_Name__c` (Text, 255) - Emergency contact person full name.
  - `Emergency_Contact_Phone__c` (Phone) - Emergency contact direct phone.
  - `Medical_Conditions__c` (Long Text Area, 32768) - Chronic/relevant medical conditions.
- Not yet done: Fields not yet exposed on Experience Cloud portal profile/community record pages.
```

### Entry to Append to `agent-context/CHANGELOG.md`
Agent 2 must append the following entry to `agent-context/CHANGELOG.md`:

```markdown
- **Ticket**: SCRUM-6
  - **Date**: 2026-09-11
  - **Summary**: Create medical and emergency contact fields on Contact object (Blood_Group__c, Allergies__c, Emergency_Contact_Name__c, Emergency_Contact_Phone__c, Medical_Conditions__c).
  - **Artifacts**:
    - `force-app/main/default/objects/Contact/fields/Blood_Group__c.field-meta.xml`
    - `force-app/main/default/objects/Contact/fields/Allergies__c.field-meta.xml`
    - `force-app/main/default/objects/Contact/fields/Emergency_Contact_Name__c.field-meta.xml`
    - `force-app/main/default/objects/Contact/fields/Emergency_Contact_Phone__c.field-meta.xml`
    - `force-app/main/default/objects/Contact/fields/Medical_Conditions__c.field-meta.xml`
  - **PR**: <PR-URL>
```
