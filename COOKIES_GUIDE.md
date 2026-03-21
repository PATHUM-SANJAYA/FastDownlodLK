# YouTube Cookie Maintenance Guide

To keep the downloader working for YouTube, you need to provide fresh cookies when the current ones expire or are flagged by YouTube's bot detection.

## 1. Export New Cookies
1. Open Chrome and install the extension: **[Get cookies.txt LOCALLY](https://chrome.google.com/webstore/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc)**
2. Go to [YouTube.com](https://www.youtube.com) and ensure you are logged in.
3. Click the extension icon and select **"Export cookies for this tab"**.
4. Save the file as `cookies.txt`.

## 2. Upload to Oracle Server
Use the following command from your local computer (where your SSH key is located):

```powershell
# Command for Windows PowerShell
scp -i "path\to\ssh-key.key" "path\to\cookies.txt" ubuntu@161.118.226.131:~/FastDownlodLK/cookies.txt
```

## 3. Restart the Downloader
SSH into the server and restart the PM2 process to apply the new cookies:

```bash
ssh -i "path/to/ssh-key.key" ubuntu@161.118.226.131 "pm2 restart all"
```

## Maintenance Tips
- **Frequency:** Update cookies whenever you see "Sign in to confirm you're not a bot" in the logs or the site fails for YouTube.
- **Privacy:** Always use a secondary/throwaway YouTube account for exporting cookies to protect your main account.
