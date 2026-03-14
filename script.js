document.addEventListener('alpine:init', () => {
    Alpine.data('appData', () => ({
        url: '',
        isLoading: false,
        errorMessage: '',
        isDownloading: false,
        downloadProgress: 0,
        isDragging: false,
        isFocused: false,
        isDarkMode: false,
        videoData: null,
        formats: [],
        selectedFormat: '',

        init() {
            // Theme initialization
            this.isDarkMode = localStorage.getItem('theme') === 'dark' ||
                (!('theme' in localStorage) && window.matchMedia('(prefers-color-scheme: dark)').matches);
            this.updateTheme();

            // Initialize AOS Library
            if (typeof AOS !== 'undefined') {
                AOS.init({
                    once: true,
                    offset: 50,
                });
            }

            // Re-init AOS layout adjustments when UI data changes
            this.$watch('videoData', () => {
                setTimeout(() => {
                    if (typeof AOS !== 'undefined') AOS.refresh();
                }, 200);
            });
        },

        toggleTheme() {
            this.isDarkMode = !this.isDarkMode;
            localStorage.setItem('theme', this.isDarkMode ? 'dark' : 'light');
            this.updateTheme();
        },

        updateTheme() {
            if (this.isDarkMode) {
                document.documentElement.classList.add('dark');
            } else {
                document.documentElement.classList.remove('dark');
            }
        },

        async handlePaste() {
            try {
                const text = await navigator.clipboard.readText();
                if (text && text.trim() !== '') {
                    this.url = text.trim();
                    this.isFocused = true;
                    setTimeout(() => this.isFocused = false, 1500);
                    // Optionally auto-fetch immediately upon paste
                    // this.fetchVideoData();
                }
            } catch (err) {
                this.errorMessage = 'Failed to read clipboard text. Please paste manually.';
                setTimeout(() => this.errorMessage = '', 5000);
            }
        },

        handleDrop(e) {
            this.isDragging = false;
            const text = e.dataTransfer.getData('text');
            if (text && text.trim() !== '') {
                this.url = text.trim();
                this.fetchVideoData();
            }
        },

        detectPlatform(link) {
            const l = link.toLowerCase();
            if (l.includes('youtube.com') || l.includes('youtu.be')) return { name: 'YouTube', icon: 'fa-brands fa-youtube', color: '#FF0000' };
            if (l.includes('tiktok.com')) return { name: 'TikTok', icon: 'fa-brands fa-tiktok', color: '#000000' }; // Assuming icon logic handles dark/light if needed
            if (l.includes('instagram.com')) return { name: 'Instagram', icon: 'fa-brands fa-instagram', color: '#E1306C' };
            if (l.includes('facebook.com') || l.includes('fb.watch')) return { name: 'Facebook', icon: 'fa-brands fa-facebook', color: '#1877F2' };
            if (l.includes('twitter.com') || l.includes('x.com')) return { name: 'Twitter/X', icon: 'fa-brands fa-x-twitter', color: '#14171A' };
            if (l.includes('reddit.com')) return { name: 'Reddit', icon: 'fa-brands fa-reddit-alien', color: '#FF4500' };

            return { name: 'Website Video', icon: 'fa-solid fa-link', color: '#6366F1' }; // Fallback
        },

        async fetchVideoData() {
            if (!this.url) {
                this.errorMessage = 'Please enter a valid video URL.';
                return;
            }

            // Basic URL normalization + validation
            let candidate = this.url.trim();
            // Auto-prepend https:// if the user missed the protocol
            if (!/^https?:\/\//i.test(candidate)) {
                candidate = 'https://' + candidate;
            }
            try {
                let parsedUrl = new URL(candidate);
                
                // Clean YouTube URLs to remove playlist and tracking parameters
                if (parsedUrl.hostname.includes('youtube.com') || parsedUrl.hostname.includes('youtu.be')) {
                    // yt-dlp often fails or gets stuck when these parameters are present in API calls
                    parsedUrl.searchParams.delete('list');
                    parsedUrl.searchParams.delete('index');
                    parsedUrl.searchParams.delete('start_radio');
                    parsedUrl.searchParams.delete('feature');
                    parsedUrl.searchParams.delete('si');
                    parsedUrl.searchParams.delete('t');
                }
                
                this.url = parsedUrl.toString();
            } catch (e) {
                this.errorMessage = 'Invalid URL format. Please check the link.';
                return;
            }

            this.isLoading = true;
            this.errorMessage = '';
            this.videoData = null;
            this.formats = [];

            try {
                // Fetch Visual Metadata via Backend API (yt-dlp)
                let title = 'Ready for Download';
                let thumbnail = 'https://images.unsplash.com/photo-1611162617474-5b21e879e113?q=80&w=1000&auto=format&fit=crop';
                let duration = 'Auto';
                let rawFormats = null;
                const platformInfo = this.detectPlatform(this.url);

                const apiBase = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
                    ? 'http://localhost:8002'
                    : window.location.origin;

                // Retry fetching info up to 3 times - YouTube sometimes needs multiple attempts
                const MAX_INFO_RETRIES = 3;
                for (let attempt = 1; attempt <= MAX_INFO_RETRIES; attempt++) {
                    try {
                        if (attempt > 1) {
                            this.errorMessage = `Fetching video info... (attempt ${attempt}/${MAX_INFO_RETRIES})`;
                            await new Promise(r => setTimeout(r, 1500));
                        }
                        const controller = new AbortController();
                        const infoTimeout = setTimeout(() => controller.abort(), 90000); // 90s per attempt
                        const metaRes = await fetch(`${apiBase}/api/info?url=${encodeURIComponent(this.url)}`, { signal: controller.signal });
                        clearTimeout(infoTimeout);
                        if (metaRes.ok) {
                            const meta = await metaRes.json();
                            const gotRealTitle = meta.title && meta.title !== 'Video Download' && !meta.error;
                            if (meta.title && !meta.error) title = meta.title;
                            if (meta.thumbnail && !meta.error) thumbnail = meta.thumbnail;
                            if (meta.duration && !meta.error) duration = meta.duration;
                            if (meta.formats && meta.formats.length > 0) rawFormats = meta.formats;
                            // If we got a real title, stop retrying
                            if (gotRealTitle) break;
                            // If we got 'Video Download' default, retry to see if we can do better
                            if (attempt < MAX_INFO_RETRIES) continue;
                        }
                        break; // non-ok response, stop
                    } catch (metaErr) {
                        if (attempt === MAX_INFO_RETRIES) {
                            // Final attempt failed, continue with defaults
                        }
                        console.warn('[metadata] failed to fetch from server.js info endpoint:', metaErr);
                    }
                }
                this.errorMessage = ''; // Clear retry messages

                // Render Preview immediately, even if metadata is still default
                this.renderPreview({
                    title: title,
                    thumbnail: thumbnail,
                    duration: duration,
                    platform: platformInfo,
                    originalUrl: this.url
                });

                // ALWAYS render download options - this is the FAIL-SAFE
                this.renderDownloadOptions(rawFormats, this.url);

            } catch (error) {
                console.error('fetchVideoData global catch:', error);
                this.errorMessage = 'Could not fetch video details, but you can still try downloading below.';
                
                // Fallback rendering
                this.renderPreview({
                    title: 'Video Download',
                    thumbnail: 'https://images.unsplash.com/photo-1611162617474-5b21e879e113?q=80&w=1000&auto=format&fit=crop',
                    duration: 'Auto',
                    platform: this.detectPlatform(this.url),
                    originalUrl: this.url
                });
                this.renderDownloadOptions(null, this.url);
            } finally {
                this.isLoading = false;

                // Even if totally failed, ensure options are there
                if (!this.formats || this.formats.length === 0) {
                    this.renderDownloadOptions(null, this.url);
                }

                // Smooth scroll to results
                setTimeout(() => {
                    const el = document.getElementById('preview-section');
                    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }, 100);
            }
        },

        renderPreview(data) {
            this.videoData = data;
        },

        renderDownloadOptions(rawFormats, videoUrl) {
            // Always show the same standard quality options for all platforms.
            // The download handler uses 'bestvideo[height<=N]+bestaudio/best'
            // so it will pick the best available quality up to the selected height.
            this.formats = [
                { quality: '180',  label: '180p',          type: 'MP4', icon: 'fa-mobile-screen',        sizeLabel: 'Small' },
                { quality: '360',  label: '360p',          type: 'MP4', icon: 'fa-mobile-screen',        sizeLabel: 'Medium' },
                { quality: '480',  label: '480p',          type: 'MP4', icon: 'fa-tablet-screen-button', sizeLabel: 'Good' },
                { quality: '720',  label: '720p HD',       type: 'MP4', icon: 'fa-desktop',              sizeLabel: 'HD' },
                { quality: '1080', label: '1080p Full HD', type: 'MP4', icon: 'fa-tv',                   sizeLabel: 'Full HD' },
                { quality: 'audio', label: 'MP3 Audio',   type: 'MP3', icon: 'fa-headphones',            sizeLabel: 'Audio' },
            ];
        },

        async startDownload(format) {
            if (!this.url || this.isDownloading) return;

            this.selectedFormat = format.quality;
            this.isDownloading = true;
            this.downloadProgress = 0;
            this.errorMessage = '';

            try {
                const params = new URLSearchParams();
                params.set('url', this.url);
                params.set('quality', format.quality);
                if (this.videoData && this.videoData.title) {
                    params.set('title', this.videoData.title);
                }
                if (format.quality === 'audio') {
                    params.set('type', 'audio');
                }

                const apiBase = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
                    ? 'http://localhost:8002'
                    : window.location.origin;

                const downloadUrl = `${apiBase}/api/download?${params.toString()}`;

                // Track actual progress using XMLHttpRequest
                const xhr = new XMLHttpRequest();
                xhr.open('GET', downloadUrl, true);
                xhr.responseType = 'blob';
                xhr.timeout = 8 * 60 * 1000; // 8 minute max wait (1080p can take time)

                // Show status message while server is preparing
                this.errorMessage = '';
                const qualityLabel = format.quality === 'audio' ? 'MP3' : `${format.quality}p`;
                // Small indicator — will be cleared on success

                xhr.onprogress = (event) => {
                    if (event.lengthComputable) {
                        const percentComplete = (event.loaded / event.total) * 100;
                        this.downloadProgress = Math.floor(percentComplete);
                    } else {
                        // Server is still processing — pulse slowly up to 90%
                        if (this.downloadProgress < 90) {
                            this.downloadProgress = Math.min(90, this.downloadProgress + 0.2);
                        }
                    }
                };

                xhr.onload = () => {
                    if (xhr.status === 200) {
                        this.downloadProgress = 100;

                        let filename = 'download';
                        const disposition = xhr.getResponseHeader('Content-Disposition');
                        if (disposition && disposition.indexOf('attachment') !== -1) {
                            const filenameRegex = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/;
                            const matches = filenameRegex.exec(disposition);
                            if (matches != null && matches[1]) {
                                filename = matches[1].replace(/['"]/g, '');
                            }
                        } else {
                            let safeTitle = (this.videoData && this.videoData.title) ? this.videoData.title.replace(/[^a-z0-9]/gi, '_').toLowerCase() : 'video';
                            if (safeTitle.length > 50) safeTitle = safeTitle.substring(0, 50);
                            const extension = format.quality === 'audio' ? 'mp3' : 'mp4';
                            filename = `FastDown_${safeTitle}_${format.quality}.${extension}`;
                        }

                        const blob = xhr.response;
                        const defaultUrl = window.URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.style.display = 'none';
                        a.href = defaultUrl;
                        a.download = filename;
                        document.body.appendChild(a);
                        a.click();
                        document.body.removeChild(a);
                        setTimeout(() => window.URL.revokeObjectURL(defaultUrl), 1000);

                        setTimeout(() => {
                            this.isDownloading = false;
                            this.downloadProgress = 0;
                            this.selectedFormat = '';
                        }, 2000);

                    } else {
                        // Try to read error message from JSON response
                        this.isDownloading = false;
                        this.downloadProgress = 0;
                        const reader = new FileReader();
                        reader.onload = () => {
                            try {
                                const errData = JSON.parse(reader.result);
                                this.errorMessage = errData.message + (errData.details ? ` Details: ${errData.details}` : '');
                            } catch (_) {
                                this.errorMessage = 'Download failed (server error ' + xhr.status + '). Please try again.';
                            }
                        };
                        reader.readAsText(xhr.response);
                    }
                };

                xhr.ontimeout = () => {
                    this.isDownloading = false;
                    this.downloadProgress = 0;
                    this.errorMessage = 'Download timed out. YouTube may be blocking this — try a shorter video or a TikTok/Instagram link.';
                };

                xhr.onerror = () => {
                    this.isDownloading = false;
                    this.downloadProgress = 0;
                    this.errorMessage = 'Network error. Check your connection and try again.';
                };

                xhr.send();

            } catch (e) {
                this.isDownloading = false;
                this.downloadProgress = 0;
                this.errorMessage = 'Download initialization failed. Please try again.';
            }
        }
    }));
});
