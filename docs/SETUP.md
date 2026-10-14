# Setting up your own PageSync

This guide deploys a complete copy of PageSync on free services in about 30 minutes. You'll need accounts on **Supabase**, **Netlify** and one storage provider (**Backblaze B2** is free and needs no card).

## Part A: Supabase (accounts and sync)

1. Go to **https://supabase.com**, sign up, and click **New project**. Pick the region closest to you (e.g. **Mumbai**).
2. **SQL Editor → New query.** Paste all of `supabase/setup.sql` and click **Run**.
3. Click **Connect** at the top, or go to **Project Settings → API Keys**. Copy the **Project URL** (just `https://xxxx.supabase.co`, nothing after it) and the **Publishable key** (`sb_publishable_…`, or the older *anon public* key).
4. Put both into `public/config.js`:
   ```js
   export const SUPABASE_URL = 'https://abcdxyz.supabase.co';
   export const SUPABASE_KEY = 'sb_publishable_...';
   ```

## Part B: Storage for the PDFs: pick one

| | **Backblaze B2** (recommended) | Cloudflare R2 | AWS S3 |
|---|---|---|---|
| Card / bank details | **Not needed** | Needed to turn R2 on | Already on your AWS account |
| Free space | 10 GB, doesn't expire | 10 GB, doesn't expire | Uses your free-plan credits; new accounts' free plan ends after 6 months |
| If you go over | Stops at the free limit, no charge | Small charge | Charged after the free plan ends |

### Option 1: Backblaze B2 (no card)

1. Go to **https://www.backblaze.com/sign-up/cloud-storage** and sign up for **B2 Cloud Storage** (no credit card). Confirm your email.
2. **Buckets → Create a Bucket**:
   - Name: something unique, e.g. `pagesync-yourname`
   - Files in Bucket: **Private**
   - Leave encryption and Object Lock off, then click **Create a Bucket**.
   - Write down the **Endpoint** shown on the bucket, e.g. `s3.us-east-005.backblazeb2.com`.
3. On the bucket, click **CORS Rules**. Choose **Share everything in this bucket with all HTTPS origins**, and under *Apply CORS rules to*, pick **S3 Compatible API** (or both). Save.
4. **Application Keys → Add a New Application Key**:
   - Name: `pagesync`
   - Allow access to Bucket(s): **All** (this lets the setup check fix browser permissions for you if needed)
   - Type of access: **Read and Write**
   - Click **Create**, then copy the **keyID** and **applicationKey** right away. The applicationKey is shown only once.

Secrets for Part C:
- `S3_ENDPOINT` = `https://` + your endpoint, e.g. `https://s3.us-east-005.backblazeb2.com`
- `S3_BUCKET` = your bucket name
- `S3_ACCESS_KEY_ID` = keyID
- `S3_SECRET_ACCESS_KEY` = applicationKey

Downloads are free up to 3× what you store each month. With PageSync each device downloads a PDF once and then keeps it, so you won't come near that.

### Option 2: Cloudflare R2

1. **https://dash.cloudflare.com → R2 Object Storage.** Cloudflare asks you to add a payment method once. Then **Create bucket** named `pagesync`.
2. **Manage API tokens → Create API token** with **Object Read & Write**, limited to that bucket. Copy the Access Key ID, the Secret Access Key, and the endpoint `https://<account-id>.r2.cloudflarestorage.com`.
3. CORS: the setup check can set it with one click (Part F). You can also add it under bucket **Settings → CORS policy** using the JSON shown under Option 3.

### Option 3: AWS S3

1. **S3 → Create bucket**: pick a name **without dots**, e.g. `pagesync-yourname`, choose a region (e.g. *Asia Pacific (Mumbai) ap-south-1*), and keep *Block all public access* **on**.
2. Bucket → **Permissions → Cross-origin resource sharing (CORS) → Edit**, then paste the following with your own Netlify address:
   ```json
   [{ "AllowedOrigins": ["https://YOUR-SITE.netlify.app"], "AllowedMethods": ["GET", "PUT", "HEAD"],
      "AllowedHeaders": ["*"], "ExposeHeaders": ["ETag", "Content-Length"], "MaxAgeSeconds": 3600 }]
   ```
3. **IAM → Users → Create user** `pagesync`, with no console access. Attach a policy that only allows this bucket:
   ```json
   { "Version": "2012-10-17", "Statement": [{ "Effect": "Allow",
     "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts", "s3:PutBucketCORS", "s3:GetBucketCORS"],
     "Resource": ["arn:aws:s3:::pagesync-yourname", "arn:aws:s3:::pagesync-yourname/*"] }] }
   ```
   Then go to **Security credentials → Create access key** (*Application running outside AWS*) and copy both values.
4. Secrets: `S3_ENDPOINT` = `https://s3.ap-south-1.amazonaws.com` (use your region), plus the bucket name and the two keys.
5. In **Billing → Budgets**, create a $1 budget alert so you hear about any charge early.

## Part C: The pdf-storage function (connects the two)

This small program runs inside Supabase. It keeps your storage keys secret and checks the 300 MB limit and each person's quota.

1. In Supabase: **Edge Functions → Deploy a new function → Via Editor**.
2. Name it exactly **`pdf-storage`**. Delete the sample code, paste in all of `supabase/functions/pdf-storage/index.ts`, and click **Deploy**.
3. Open the function's **Details** (or settings) and turn **off "Enforce JWT verification"** (also called *Verify JWT*). Save. This is safe because the function checks each user's login itself.
4. Go to **Edge Functions → Secrets** and add:

   | Name | Value |
   |---|---|
   | `S3_ENDPOINT` | from Part B, e.g. `https://s3.us-east-005.backblazeb2.com` |
   | `S3_BUCKET` | your bucket name |
   | `S3_ACCESS_KEY_ID` | Backblaze keyID / R2 or AWS access key id |
   | `S3_SECRET_ACCESS_KEY` | Backblaze applicationKey / R2 or AWS secret key |
   | `UNLIMITED_EMAILS` | **your email**, so you have no quota and can use the setup check's fix buttons (several can be separated with commas) |
   | `USER_QUOTA_MB` | space per person, default `1024` (optional) |
   | `MAX_FILE_MB` | largest PDF, default `300` (optional) |

If the function isn't set up, the app falls back to Supabase Storage with a 50 MB limit.

## Part D: Let other people sign up

1. **Authentication → Sign In / Providers**: turn **on** "Allow new users to sign up".
2. **Authentication → URL Configuration**: set **Site URL** to your Netlify address (e.g. `https://yourname-pagesync.netlify.app`). Under **Redirect URLs**, add `https://yourname-pagesync.netlify.app/**`.
3. **Emails.** Supabase's built-in email only reaches your own team's addresses and sends very few per hour. Pick one:
   - **Quick:** **Authentication → Sign In / Providers → Email**, turn **off "Confirm email"**. People can sign up and use the app immediately. However, "Forgot password" emails won't reach other people until you do the next option.
   - **Proper (recommended):** **Authentication → Emails → SMTP Settings**, turn on custom SMTP. A free option is Gmail:
     - Host `smtp.gmail.com`, port `465`.
     - Username: your Gmail address.
     - Password: a Gmail **App Password**. Create one at Google Account → Security → 2-Step Verification → App passwords.
     - About 500 emails per day. Brevo's free SMTP (300/day) also works.

     Confirmation and reset emails then reach everyone.

## Part E: Put it online (Netlify)

1. Go to **https://app.netlify.com** → **Add new project → Deploy manually** and drag the **`public` folder** in.
2. Under **Project configuration → Change project name**, choose your address. Use the same address in Part B (CORS) and Part D (URL Configuration).
3. Share the link. People tap **Create account**, and on phones they can use *Add to Home screen* to install it like an app.

## Part F: Run the setup check

Open **`https://YOUR-SITE.netlify.app/check.html`** while signed in. When your email is in `UNLIMITED_EMAILS`, there's also a **Setup check** link next to the storage bar in the library. The page tests, from your browser:

1. config.js and sign-in
2. that the `pdf-storage` function is deployed and reachable
3. that the function can use your bucket with your keys
4. an upload from this website. If the bucket's browser permissions (CORS) are missing, owners get a **Fix automatically** button.
5. a download
6. your limits

Every failed step tells you exactly what to change. When all six are green, big PDFs will work.

---

## Part G: Turn on "Explain" (optional, free)

Explain uses an AI model to explain a selected word in its sentence, or a whole passage, in English, simple English, Hinglish or Hindi. The free option is **Google Gemini**: you only need a Google account.

1. Go to **https://aistudio.google.com**, sign in with Google, and click **Get API key → Create API key**. Copy the key.
2. In Supabase: **Edge Functions → Secrets**, add:

   | Name | Value |
   |---|---|
   | `AI_API_KEY` | the key you copied |
   | `AI_DAILY_LIMIT` | explanations per person per day (optional, default `50`; emails in `UNLIMITED_EMAILS` have no limit) |

3. Update the `pdf-storage` function with the latest `index.ts` (replace its code and click **Deploy**), and re-run `supabase/setup.sql` in the SQL Editor (it adds the daily counter).
4. Open **check.html**. The **AI Explain** step should be green and show a sample answer.

Other providers work too: set `AI_PROVIDER` to `groq` (free tier, key from console.groq.com) or `anthropic` (Claude; needs paid API credits), and optionally `AI_MODEL` to choose a model. With Gemini, if the main model is busy the function automatically tries `gemini-3.5-flash`, then `gemini-3.5-flash-lite`, then `gemini-2.5-flash-lite` (change the list with the `AI_FALLBACK_MODELS` secret).

**Privacy:** the text you ask about (plus about a paragraph around it for context) is sent to the AI provider. On Google's free tier, Google may use that content to improve its products, so avoid Explain on confidential documents.

## Good to know

- **Space.** With 1 GB each, the 10 GB free allowance fits about 9 people plus you. On Backblaze without a card, uploads simply stop at the free limit. Change `USER_QUOTA_MB` any time; it applies immediately.
- **Offline.** A ✓ on a cover means that PDF is saved on this device. Open PDFs once before a trip. Each device keeps up to about 1.5 GB of PDFs and removes the least recently opened ones first.
- **Supabase free projects pause after about a week with nobody using them.** Click **Restore** in the dashboard; nothing is lost. Regular use keeps them awake.
- **Updating the site.** Drag the `public` folder into Netlify → **Deploys** again. If you change `sw.js` or `vendor/`, bump `VERSION` at the top of `sw.js`.
- **Abuse.** Anyone with the link can sign up. If strangers start using it, turn off sign-ups (Part D1) or remove users under **Authentication → Users**. Removing a user deletes their notes. Their PDF files can be removed in your storage dashboard (each user's files are in a folder named after their user id).

## Troubleshooting

| What you see | Fix |
|---|---|
| *Invalid path specified in request URL* | `SUPABASE_URL` in config.js must be just `https://xxxx.supabase.co`. (The app now fixes this automatically.) |
| Big uploads fail, or the library says "PDFs up to 50 MB" | Open **check.html** (Part F). It pinpoints the problem and can fix CORS for you. |
| "Fix automatically" fails on Backblaze | Your key is limited to one bucket. Create a new key with access to **All** buckets (Part B, Option 1, step 4), or set CORS Rules on the bucket by hand. |
| "Please sign in again" from uploads | In the function settings, turn off *Enforce JWT verification* (Part C3). |
| *Email not confirmed* / no email arrives | Part D3: turn off *Confirm email*, or set up SMTP. Also check spam. |
| Reset link opens the wrong site | Part D2: Site URL and Redirect URLs. |
| Explain says "not set up" / no Explain button | Add the `AI_API_KEY` secret and redeploy the function (Part G); then reload the PDF. |
| Explain: "free AI service is busy" | The free tier allows a limited number of requests per minute. Wait a minute and try again. |
| Explain: "AI service is busy" / "high demand" | Google's free model is overloaded for a moment. The function already tries backup models automatically (`AI_FALLBACK_MODELS`); just try again in a minute. |
| Explain: "model wasn't found" | Remove `AI_MODEL` to use the default, or set it to a model your provider currently offers. |
| *Wrong email or password* | Reset it with "Forgot password?", or in Authentication → Users. |
