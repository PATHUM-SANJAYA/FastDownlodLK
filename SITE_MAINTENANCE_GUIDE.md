# 🛠 Site Maintenance Guide

To keep the YouTube downloader working smoothly on the Oracle VPS, you occasionaly need to update the "bypass assets" (Cookies, PO Tokens, and Proxies).

## 1. Updating Cookies 🍪
If you see "Sign in to confirm you're not a bot", your cookies might be stale.
1. Use a browser extension (like "EditThisCookie" or "Get cookies.txt LOCALLY") to export cookies for **youtube.com** in Netscape format.
2. Replace the contents of `cookies.txt`, `cookies1.txt`, etc., in the project folder.
3. Commit and Push to Git:
   ```powershell
   git add .
   git commit -m "update: fresh youtube cookies"
   git push origin master:main
   ```

## 2. Updating the PO Token 🔑
The PO Token helps bypass the "bot" check for high-quality videos.
1. Follow the [PO Token Guide](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide) to generate a new `po_token` and `visitor_data`.
2. Update the `po_token.txt` and `visitor_data.txt` files in the project root.
3. Commit and Push to Git.

## 3. Updating Proxies 🌐
If the Oracle IP is completely blocked, the server uses a proxy rotation.
1. Open `server.js`.
2. Locate the `YOUTUBE_PROXIES` array at the top.
3. Add fresh SOCKS5 proxies found from free lists or a paid provider.
   ```javascript
   const YOUTUBE_PROXIES = [
       'socks5://user:pass@host:port',
       'socks5://new_proxy:port'
   ];
   ```
4. Commit and Push to Git.

## 4. Restarting the Server 🔄
After pushing logic changes to Git, always restart the server:
```bash
ssh -i oracle_key.key ubuntu@161.118.226.131 "cd ~/FastDownlodLK && git pull origin main && pm2 restart all"
```
