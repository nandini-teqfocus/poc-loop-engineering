# Persistent Living Memory

This document is the distilled, living summary of what exists in the target Salesforce org and why.
Agent 1 reads this document FIRST before planning any new ticket.

---

## Account Object
- *No custom portal fields deployed yet. Baseline state.*

## Contact Object
- Fields added in SCRUM-6:
  - `Blood_Group__c` (Picklist: A+, A-, B+, B-, O+, O-, AB+, AB-) - Health/emergency record.
  - `Allergies__c` (Long Text Area, 32768) - Tracks contact allergies.
  - `Emergency_Contact_Name__c` (Text, 255) - Emergency contact person full name.
  - `Emergency_Contact_Phone__c` (Phone) - Emergency contact direct phone.
  - `Medical_Conditions__c` (Long Text Area, 32768) - Chronic/relevant medical conditions.
- Not yet done: Fields not yet exposed on Experience Cloud portal profile/community record pages.

## Opportunity Object
- Fields added in SCRUM-8:
  - `Insurance_Provider__c` (Text, 255) - Name of insurance provider (e.g., Blue Cross).
  - `Coverage_Status__c` (Picklist: Active, Expired, Pending) - Current status of insurance coverage.
- Not yet done: Fields not yet exposed on Experience Cloud portal opportunity record pages or layouts.

