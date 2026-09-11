# Persistent Living Memory

This document is the distilled, living summary of what exists in the target Salesforce org and why.
Agent 1 reads this document FIRST before planning any new ticket.

---

## Account Object
- **Custom Portal Fields:**
  - `Industry_Segment__c` (Picklist: A, B, C) - Industry segmentation classification for portal accounts.
  - `Renewal_Risk_Score__c` (Number: 3, 0) - Assessed risk score (0-100) assessing likelihood of non-renewal. Exposed on standard Account Page Layout.
  - `Customer_Tier__c` (Picklist: Gold, Silver, Bronze) - Customer segmentation classification tier. Exposed on standard Account Page Layout.
  - `Last_Health_Check__c` (Date) - Most recent customer health check date.
  - `Primary_Competitor__c` (Text: 80) - Primary competitor associated with the account.
  - `Contract_Value__c` (Currency: 18, 2) - Total active contract monetary value.
  - `Auto_Renew__c` (Checkbox) - Indicates whether the account contract automatically renews.
- **Validation Rules:**
  - `Primary_Competitor_Required_High_Risk`: Requires `Primary_Competitor__c` to be populated when `Renewal_Risk_Score__c > 80`.
- **Page Layouts:**
  - `Account-Account Layout`: Exposes `Renewal_Risk_Score__c` and `Customer_Tier__c` for portal/account segmentation.
