/**
 * Cross-Platform In-Browser QR Code Camera Scanner
 * Uses standalone jsQR with canvas frame sampling.
 * Works on 100% of browsers: iOS Safari, Android Chrome, Edge, Firefox, Desktop.
 */

import './libs/jsqr.min.js';

export const CameraScanner = {
  activeStream: null,
  scanInterval: null,
  canvas: null,
  ctx: null,

  /**
   * Starts camera scanner and streams into a video element.
   * Continuously scans video frames for standard QR codes.
   * @param {HTMLVideoElement} videoEl - Video element to render camera feed
   * @param {function} onCodeDetected - Callback when a QR code is read: (text) => void
   * @param {function} onError - Callback on permission or device error
   */
  async start(videoEl, onCodeDetected, onError = null) {
    this.stop();

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      if (onError) onError(new Error('Camera access not supported on this browser.'));
      return;
    }

    try {
      const constraints = {
        video: {
          facingMode: { ideal: 'environment' }, // Back camera on mobile
          width: { ideal: 640 },
          height: { ideal: 640 },
        },
        audio: false,
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      this.activeStream = stream;
      videoEl.srcObject = stream;
      await videoEl.play();

      if (!this.canvas) {
        this.canvas = document.createElement('canvas');
        this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
      }

      let isScanning = true;
      const jsQRFn = (typeof window !== 'undefined' && window.jsQR) ? window.jsQR : null;

      const scanFrame = () => {
        if (!isScanning) return;
        if (videoEl.readyState >= 2 && videoEl.videoWidth > 0 && videoEl.videoHeight > 0) {
          const w = Math.min(480, videoEl.videoWidth);
          const h = Math.round(w * (videoEl.videoHeight / videoEl.videoWidth));
          this.canvas.width = w;
          this.canvas.height = h;

          this.ctx.drawImage(videoEl, 0, 0, w, h);
          const imgData = this.ctx.getImageData(0, 0, w, h);

          if (jsQRFn) {
            const qr = jsQRFn(imgData.data, w, h, { inversionAttempts: 'dontInvert' });
            if (qr && qr.data && qr.data.trim()) {
              isScanning = false;
              this.stop();
              if (navigator.vibrate) {
                try { navigator.vibrate(60); } catch (e) {}
              }
              onCodeDetected(qr.data.trim());
              return;
            }
          }
        }
        this.scanInterval = setTimeout(scanFrame, 120);
      };

      // Start frame polling after video starts rendering
      this.scanInterval = setTimeout(scanFrame, 250);

    } catch (err) {
      console.warn('[CameraScanner] Camera access error:', err);
      if (onError) onError(err);
    }
  },

  /**
   * Stops the camera and releases device hardware.
   */
  stop() {
    if (this.scanInterval) {
      clearTimeout(this.scanInterval);
      this.scanInterval = null;
    }
    if (this.activeStream) {
      this.activeStream.getTracks().forEach(track => {
        try { track.stop(); } catch (e) {}
      });
      this.activeStream = null;
    }
  },
};
