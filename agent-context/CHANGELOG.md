# Project Changelog

Append-only ledger of completed tickets. Each entry contains the ticket key, date, summary, artifacts touched, and PR link.

---

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
- **PR:** https://github.com/nandini-teqfocus/poc-loop-engineering/pull/1

### [SCRUM-2] - 2026-09-11
- **Summary:** Added Customer_Tier__c picklist (Gold, Silver, Bronze) on Account and exposed Customer_Tier__c and Renewal_Risk_Score__c on Account-Account Layout.
- **Artifacts:**
  - `force-app/main/default/objects/Account/fields/Customer_Tier__c.field-meta.xml`
  - `force-app/main/default/layouts/Account-Account Layout.layout-meta.xml`
- **PR:** https://github.com/nandini-teqfocus/poc-loop-engineering/pull/2
