# Ethio Lyrics Player 🎵

A modern, high-performance web music player designed for synchronized Ethiopian and multilingual lyrics, featuring real-time dynamic artwork color extraction, living ambient background motion, an in-app visual LRC editor, and modular display themes.

---

## ✨ Features

- **Dynamic Artwork Ambient Mode (Default)**: Automatically samples loaded album covers in real time to generate fluid, living ambient gradient meshes and radiant vinyl reflections.
- **Ambient Particles Engine**: Subtle, floating dust motes & gentle snowflakes drifting at 60 FPS across the canvas.
- **Visual LRC Editor**:
  - **Tap-Sync Mode**: Tap the spacebar or sync button to align lyrics line-by-line to music with zero latency.
  - **Edit Timestamps Mode**: Fine-tune timestamp offsets (`+0.1s`, `-0.1s`), nudges, and text.
  - **Raw LRC & Export**: Paste or export standard `.lrc` files.
- **Persistent Music Library (IndexedDB)**:
  - Add custom tracks with audio file, album cover image, and metadata.
  - Mandatory fields: Artist Name and Song Title.
  - Edit metadata, artwork, and lyrics at any time.
- **Modular Presentation Themes**:
  1. **Dynamic Artwork Ambient**: Fluid ambient gradient mesh generated from the album artwork colors.
  2. **1999 Ethio Lyrics Video**: Classic Ethiopian television broadcast replica with deep crimson vignette and studio red beacon.
  3. **Apple Music Ambient Canvas**: 3D physical album sleeve with rotating vinyl record sliding out and depth-of-field blur.
  4. **Cinema Concert Horizon**: 21:9 Widescreen letterbox with theatrical spotlight and golden karaoke light sweep.
  5. **Cyber Neon Club & Lounge**: Cyberpunk laser grid with dual counter-rotating groove rings.
- **Mobile Responsive Dock**: Full touchscreen scrubbing, responsive layout, and mobile-optimized player dock.

---

## 🚀 Cloudflare Pages Deployment (100% Free)

This project is a 100% client-side web application (HTML5, Vanilla CSS, ES Modules) requiring zero build step or server runtime.

### Step 1: Push to GitHub
```bash
git init
git add .
git commit -m "feat: initial commit"
git branch -M main
git remote add origin https://github.com/<YOUR_USERNAME>/<YOUR_REPOSITORY>.git
git push -u origin main
```

### Step 2: Connect to Cloudflare Pages
1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com/) and navigate to **Workers & Pages**.
2. Click **Create application** > **Pages** > **Connect to Git**.
3. Select your repository.
4. Set the build configuration:
   - **Framework preset**: `None`
   - **Build command**: *(Leave blank)*
   - **Build output directory**: `/` (or leave as root)
5. Click **Save and Deploy**. Your site will be live with a free `*.pages.dev` URL and unlimited CDN bandwidth!
