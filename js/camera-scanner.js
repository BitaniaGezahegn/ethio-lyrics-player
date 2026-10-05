/**
 * In-Browser Camera QR Code Scanner with Manual Code Fallback
 * Lightweight, zero-dependency camera viewfinder for mobile pairing.
 */

export const CameraScanner = {
  activeStream: null,
  scanInterval: null,

  /**
   * Check if native BarcodeDetector API is supported in this browser.
   */
  isBarcodeDetectorSupported() {
    return 'BarcodeDetector' in window;
  },

  /**
   * Starts camera scanner and streams into a video element.
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

      if (this.isBarcodeDetectorSupported()) {
        const barcodeDetector = new window.BarcodeDetector({ formats: ['qr_code'] });
        this.scanInterval = setInterval(async () => {
          if (videoEl.readyState >= 2) {
            try {
              const barcodes = await barcodeDetector.detect(videoEl);
              if (barcodes.length > 0) {
                const text = barcodes[0].rawValue;
                this.stop();
                onCodeDetected(text);
              }
            } catch (e) {}
          }
        }, 200);
      }
    } catch (err) {
      console.warn('[CameraScanner] Camera error:', err);
      if (onError) onError(err);
    }
  },

  /**
   * Stops the camera and releases device hardware.
   */
  stop() {
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
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
