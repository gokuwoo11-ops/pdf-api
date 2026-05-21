# PDF API Branding & Evidence-Safe Wording Fixes

## Files Changed
- **server.js** - Core API server with all route updates

## Exact Fixes Made

### 1. ✅ Enhanced `/analyze-lead` Route
**What was fixed:**
- Added `Evidence Source` field to the analysis prompt
- Improved `audit_pdf_raw_notes` requirements to include:
  - Prospect business name and category
  - Specific problems/opportunities with evidence source
  - Service being offered
  - Why they need it
  - Available contact channel
- Removed placeholder/generic terms requirement

**Evidence-Safe Wording Rules Added:**
- "not found in available map data" instead of "no Instagram"
- "not discoverable in search results" instead of "zero digital presence"  
- Respectful SaaS language: "limited discoverability", "missed online booking opportunity", "opportunity to strengthen digital presence"
- Always reference evidence source: "based on website analysis", "from map data", "from manual notes"
- Never invent digital presence not supported by evidence

### 2. ✅ Updated `buildBriefPrompt()` Function
**Changes:**
- **SERVICE PROVIDER field:** Now explicitly extracts from notes. Rules state: "NEVER use 'Our Agency' or placeholder text. Always use the actual business name provided in the notes."
- **CONTACT field:** Now explicitly extracts from notes. Rules state: "NEVER use 'contact@youragency.com' placeholder. If no contact found, use empty string and let template handle it."
- **Added EVIDENCE-SAFE WORDING RULES section** to the prompt for Gemini

**Key Instructions:**
```
SERVICE PROVIDER: [Extract from notes if available. If notes contain "Prepared By:", 
use that value. If notes contain sender or agency name, use it. NEVER use "Our Agency" 
or placeholder text. Always use the actual business name provided in the notes.]

CONTACT: [Extract email or phone from notes if mentioned. If notes contain "Contact Email:" 
or "Contact:" or "Sender Email:", use that value. NEVER use "contact@youragency.com" 
placeholder. If no contact found, use empty string and let template handle it.]
```

### 3. ✅ Modified `/generate-outreach` Route
**Added:**
- Now accepts optional `sender_email` parameter
- Prepends a **branding block** to `audit_pdf_raw_notes` before generating brief:
  ```
  PREPARED BY: ${sender_business}
  SENDER NAME: ${sender_name}
  CONTACT EMAIL: ${sender_email || "Available upon request"}
  SERVICE OFFERED: ${sender_service}
  ---
  ${auditNotes}
  ```
- This ensures the PDF always includes client branding from the start

### 4. ✅ Updated `/process-lead` Route
**Changes:**
- Now accepts `sender_email` parameter in request body
- Passes `sender_email` to `/generate-outreach` endpoint
- Enables email contact info to flow through the entire pipeline

### 5. ✅ Updated `/process-leads` Route
**Changes:**
- Added `sender_email` parameter extraction
- Passes `sender_email` to each `/process-lead` call

### 6. ✅ Updated `runCampaignInBackground()` Function
**Changes:**
- Passes `campaign.sender_email` when calling `/process-lead` for batch processing
- Ensures automated campaign runs include sender email info

### 7. ✅ Improved Category-Specific Image Keywords
**Updated HTML template image prompts:**

**Cover Page:**
```
[IMG:professional industry photo matching sector — select gym fitness training 
for SPORTS category, medical healthcare professional for HEALTH category, 
restaurant food service dining for restaurants, corporate modern professional 
for CORPORATE]
```

**Opportunity Page:**
```
[IMG:opportunity success sector-specific — gym training results fitness growth 
for SPORTS, healthcare clinic patient success for HEALTH, restaurant revenue 
growth dining success for restaurants, business team achievement for corporate]
```

**Added Image Keyword Selection Rules:**
```
- For SPORTS category (gyms, fitness): Use keywords like "gym", "fitness", 
  "training", "workout", "strength training", "personal trainer"
- For HEALTH category (clinics, dental): Use keywords like "clinic", "healthcare", 
  "medical", "professional", "modern healthcare", "patient care"
- For restaurants/cafes: Use keywords like "restaurant", "dining", "food service", 
  "customer experience", "modern eatery", "food business"
- For other categories: Use professional, industry-specific imagery keywords
```

## Testing: Exact curl Command

### Test 1: Generate PDF for a Restaurant Lead

```bash
curl -X POST http://localhost:3000/process-lead \
  -H "Content-Type: application/json" \
  -d '{
    "business_name": "Pasta Paradise Restaurant",
    "website": "https://pastaparadise.local",
    "google_maps_url": "https://www.google.com/maps/place/Pasta+Paradise",
    "instagram_url": "https://instagram.com/pastaparadise",
    "phone": "+91-9876543210",
    "email": "info@pastaparadise.com",
    "address": "123 Food Street, Mumbai",
    "notes": "Italian restaurant, established 2015, Instagram has 500 followers but outdated content",
    "source": "openstreetmap",
    "service_offered": "Social Media Marketing and Online Booking Integration",
    "sender_name": "Rajesh Kumar",
    "sender_business": "Digital Growth Solutions",
    "sender_email": "rajesh@digitalgrowth.com"
  }'
```

**Expected PDF Will Show:**
- ✅ Prepared By: **Digital Growth Solutions** (NOT "Our Agency")
- ✅ Sender: **Rajesh Kumar**
- ✅ Contact: **rajesh@digitalgrowth.com** (NOT "contact@youragency.com")
- ✅ Service: **Social Media Marketing and Online Booking Integration**
- ✅ Category: **STARTUP or CORPORATE** (intelligent selection)
- ✅ Image Keywords: restaurant-specific (dining, food service, customer experience)
- ✅ Problems use evidence-safe wording: "Instagram presence not regularly updated based on available data" instead of "No social media strategy"

### Test 2: Generate PDF for a Gym Lead

```bash
curl -X POST http://localhost:3000/process-lead \
  -H "Content-Type: application/json" \
  -d '{
    "business_name": "FitZone Gym & Fitness",
    "website": "https://fitzone.local",
    "google_maps_url": "https://www.google.com/maps/place/FitZone+Gym",
    "phone": "+91-8765432100",
    "notes": "CrossFit gym, personal training available, located in commercial area",
    "source": "manual_research",
    "service_offered": "Website Redesign and Online Class Booking System",
    "sender_name": "Priya Singh",
    "sender_business": "Fitness Tech Innovations",
    "sender_email": "priya@fitnesstech.com"
  }'
```

**Expected PDF Will Show:**
- ✅ Prepared By: **Fitness Tech Innovations** (NOT "Our Agency")
- ✅ Sender: **Priya Singh**
- ✅ Contact: **priya@fitnesstech.com** (NOT "contact@youragency.com")
- ✅ Category: **SPORTS**
- ✅ Image Keywords: gym-specific (gym, fitness, training, workout, strength training)
- ✅ Problems use evidence-safe wording about missing online presence

## Syntax Validation
✅ **No syntax errors** - Verified with Node.js linter

## Database Compatibility
✅ Backward compatible - All new fields are optional with sensible defaults

## How the Fix Works (Flow)

1. **Lead Analysis Step:**
   - `/analyze-lead` generates `audit_pdf_raw_notes` with specific business context
   - Evidence source is noted in analysis

2. **Branding Injection Step:**
   - `/generate-outreach` receives `sender_email` parameter
   - Prepends branding block to notes:
     ```
     PREPARED BY: [sender_business]
     SENDER NAME: [sender_name]
     CONTACT EMAIL: [sender_email]
     SERVICE OFFERED: [service]
     ---
     [original notes]
     ```

3. **Brief Generation Step:**
   - `buildBriefPrompt()` explicitly extracts SERVICE_PROVIDER and CONTACT from notes
   - Rules prevent fallback values from being used
   - Evidence-safe wording rules are included

4. **PDF Output:**
   - PDF shows actual sender details, not placeholder text
   - Image keywords are category-specific
   - Problems are phrased respectfully with evidence references

## Summary of Benefits

✅ **Client Branding** - All PDFs now show actual client business names and emails  
✅ **No Generic Fallbacks** - "Our Agency" and "contact@youragency.com" never appear  
✅ **Evidence-Safe Language** - Respectful SaaS wording that doesn't claim absence without proof  
✅ **Sender Email Tracking** - Email contact info flows through entire pipeline  
✅ **Category-Specific Design** - Images match the business type  
✅ **SaaS-Compliant** - Professional, respectful tone for multi-client use  
