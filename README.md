🇳🇬 NaijaLite Ledger PWA

NaijaLite Ledger is an ultra-lightweight, offline-first Progressive Web App (PWA) designed specifically for micro-entrepreneurs, traders, and small business owners in Nigeria and other emerging markets with metered data or unstable internet connections.

🌟 Key Features

⚡ Ultra-Low Data Footprint: Initial load size is under 30 KB (no heavy external CSS/JS frameworks or heavy web fonts). Uses native system fonts and optimized utility styles.

📶 Network & Data-Saver Aware: Detects OS-level Data Saver settings or slow connection types (2g, 3g) via the Network Information API and defers heavy background sync tasks.

📲 100% Offline-First: Allows users to record sales, view balances, and manage expenses completely offline using localStorage and IndexedDB.

🔄 Deferred Queue Sync: Records created offline are held in a sync queue and pushed to the cloud once a reliable network connection is restored.

📱 Installable PWA: Can be added directly to an Android or iOS home screen as a standalone app without consuming tens of megabytes from app stores.

🇳🇬 Naira (₦) Native: Out-of-the-box support for Nigerian Naira formatting and instant cash flow calculations.

🚀 Quick Start (Local Setup)

Clone or download this repository:

git clone https://github.com/YOUR-USERNAME/naijalite-ledger.git


Open the project directory:

cd naijalite-ledger


Open index.html directly in any web browser, or serve it using a local HTTP server:

# Using Python 3
python -m http.server 8000


Access the app at http://localhost:8000.

🛠️ Free Deployment Guide

You can deploy this application for 100% free using static site hosts that provide edge delivery across Africa.

Option 1: Deploying with Cloudflare Pages (Recommended)

Push your code to a GitHub repository.

Sign in to Cloudflare Dashboard and navigate to Workers & Pages.

Click Create Application > Pages > Connect to Git.

Select your repository and leave the build command blank.

Click Save and Deploy. Your site will be live at https://<your-project>.pages.dev.

Option 2: Deploying with Vercel

Sign in to Vercel with your GitHub account.

Click Add New Project and select your naijalite-ledger repository.

Keep default settings and click Deploy.

🗄️ Backend Integration (Supabase Free Tier)

To connect cloud syncing to a free database:

Create a free project at Supabase.com.

Create a table named transactions with the following schema:

id (int8 / primary key)

type (text: 'income' or 'expense')

amount (numeric)

description (text)

category (text)

created_at (timestamp)

Include the Supabase JS client inside index.html and update the syncData() function with your Supabase URL and Anon Key.

📄 License

This project is open-source and available under the MIT License.
