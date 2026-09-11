# Persistent Living Memory

This document is the distilled, living summary of what exists in the target Salesforce org and why.
Agent 1 reads this document FIRST before planning any new ticket.

---

## Account Object
- **Custom Portal Fields:**
  - `Industry_Segment__c` (Picklist: A, B, C) - Industry segmentation classification for portal accounts.
  - `Renewal_Risk_Score__c` (Number: 3, 0) - Risk score assessing likelihood of non-renewal (0-100).
  - `Last_Health_Check__c` (Date) - Date of the most recent customer health check.
  - `Primary_Competitor__c` (Text: 80) - Primary competitor associated with the account.
  - `Contract_Value__c` (Currency: 18, 2) - Total monetary value of the active contract.
  - `Auto_Renew__c` (Checkbox) - Indicates whether the account contract automatically renews.
- **Validation Rules:**
  - `Primary_Competitor_Required_High_Risk`: Requires `Primary_Competitor__c` to be populated when `Renewal_Risk_Score__c > 80`.
