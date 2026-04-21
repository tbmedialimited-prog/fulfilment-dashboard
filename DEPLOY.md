# Deploy to Vercel (free, 5 minutes)

## Step 1 — Create a free Vercel account
Go to https://vercel.com and sign up with GitHub, GitLab, or email.

## Step 2 — Install Vercel CLI
Open Terminal (Mac) or Command Prompt (Windows) and run:
```
npm install -g vercel
```
If you don't have Node.js: download from https://nodejs.org (LTS version).

## Step 3 — Deploy
In Terminal, navigate to this folder and run:
```
vercel
```
Follow the prompts:
- Set up and deploy? → Y
- Which scope? → your account
- Link to existing project? → N
- Project name? → fulfilment-dashboard (or anything)
- Directory? → ./ (just press Enter)
- Override settings? → N

Vercel will give you a URL like: https://fulfilment-dashboard-abc123.vercel.app

## Step 4 — Add your API keys as environment variables
Go to https://vercel.com/dashboard → your project → Settings → Environment Variables

Add each of these:

| Name                | Value                        |
|---------------------|------------------------------|
| MINTSOFT_API_KEY    | your Mintsoft API key        |
| DPD_API_KEY         | your DPD Local API key       |
| DPD_ACCOUNT_NUMBER  | 3025796                      |
| RM_API_KEY          | your Royal Mail API key      |
| RM_API_SECRET       | your Royal Mail API secret   |
| RM_CLIENT_ID        | your Royal Mail client ID    |
| RM_CLIENT_SECRET    | your Royal Mail client secret|

## Step 5 — Redeploy with env vars
After adding env vars, go to Deployments → click the 3-dot menu → Redeploy.

## Step 6 — Open your dashboard
Visit your Vercel URL. Done!

## Check if it's working
Visit: https://your-vercel-url.vercel.app/api/diagnose
This shows which APIs are connected.

## Notes
- Your API keys are stored securely in Vercel — never in the code
- Free tier includes 100GB bandwidth and unlimited deployments
- The dashboard URL is shareable — anyone with the link can view it
- To update the code later, just run `vercel` again from this folder
