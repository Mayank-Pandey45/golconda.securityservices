# Golconda Security Services — Website Starter

A responsive dark-and-gold website starter for GOLCONDA SECURITY SERVICES. Includes React frontend, Express API endpoints for contact enquiries and job-interest forms, service cards, notifications, events, company profile area, social links, and a clearly labelled team-login placeholder.

## Requirements
- Node.js 20.19+ (or a compatible newer LTS release)
- npm
- Internet access for initial dependency install and Google Fonts

## Run locally
1. Extract this project ZIP.
2. Open a terminal inside the extracted `golconda-security-services` folder.
3. Install packages:
   ```bash
   npm install
   ```
4. Start frontend and backend:
   ```bash
   npm run dev
   ```
5. Open `http://localhost:5173`.
6. API health check: open `http://localhost:4000/api/health`.

## Project structure
- `src/main.jsx` — website pages, UI, navigation and forms
- `src/styles.css` — responsive design and dark/gold visual system
- `server/index.js` — Express API and form validation
- `.env.example` — environment configuration example

## Official logo and brand palette
- The uploaded GSS logo is included at `public/gss-logo.png` and displayed in the header/footer.
- Theme updated to navy, blue and cool ivory to match the logo.

## Before public launch
- Replace generic social links with official company profile URLs.
- Add the real company logo in `public/` and update the `Brand` component.
- Add official email, phone, address and business hours.
- Confirm the exact meaning/scope of the “VPAT” service and update its description.
- Replace in-memory demo form storage with PostgreSQL or another managed database.
- Add a privacy notice, consent wording, anti-spam/rate limiting, server-side validation, monitoring and backups.
- Implement authentication using a maintained auth provider or secure server-side session system. Never store plaintext passwords or hard-code credentials.
- Add role-based authorization for admin/team content and private documents.
- Upload company profile documents/media to controlled object storage with access rules.
- Configure HTTPS, environment variables, CORS, security headers, backups, and production logs.
- Configure your existing domain's DNS at your registrar/hosting provider after deployment.
- Test mobile layouts, accessibility, forms and security before announcing the site.

## Important
The team login is a visual placeholder and does not authenticate anyone. Do not enter real credentials. The forms currently use in-memory storage; submissions are lost when the server restarts. This is a development starter, not a production-hardened deployment.


## GitHub + Vercel deployment (starter)
1. Create a new GitHub repository and upload/push the contents of this folder (not the ZIP itself).
2. In Vercel, choose **Add New → Project**, import that GitHub repository, and deploy.
3. For a production full-stack setup, configure the API/server as a supported Vercel deployment (for example, convert Express routes to Vercel Functions or deploy the Express API on a compatible Node host). The current starter's long-running Express server may require deployment configuration and is not guaranteed to run as-is on Vercel.
4. Configure environment variables, test form submissions, and add your existing domain under Vercel project settings. Update DNS at your domain registrar as instructed by Vercel.
5. GitHub stores the source and Vercel deploys connected commits. No hosting provider can promise a website will stay online forever; availability depends on account status, plan limits, platform policies, domain renewal and ongoing maintenance.
