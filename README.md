# GLKVM Linker

**GLKVM Linker** is a Google Chrome extension (Manifest V3) designed for GL.iNet KVM-over-IP devices (such as the GL-RM1 Comet series). It adds a convenient menu item to your browser's right-click context menu when clicking on hyperlinks, enabling seamless transmission of URLs directly into your remote computer via GLKVM.

---

## What It Does

When you right-click on any hyperlink and select **"Send to GLKVM"**, the extension automatically performs the following five actions:

1. **Copies the URL** to your local system clipboard (using an MV3 offscreen document fallback).
2. **Locates the tab** with the domain `glkvm.local` (or a custom domain/IP configured in settings).
3. **Clicks the button** with the exact text `"Ctrl-L + L"` on the GLKVM tab.
4. **Pastes the copied URL with a trailing newline (`\n`)** into the `<textarea>` component on that tab (triggering appropriate React/Vue DOM events and simulating an Enter keystroke on the remote device).
5. **Clicks the button** with the exact text `"Paste To Remote Device"` on that tab.

---

## Directory Structure

```text
glkvm-linker/
├── manifest.json       # Manifest V3 extension configuration
├── background.js       # Background service worker (context menu & tab automation)
├── offscreen.html      # Offscreen document for clipboard operations
├── offscreen.js        # Offscreen script handling clipboard write
├── popup/              # Extension action popup
│   ├── popup.html      # Status monitor, quick send, and configuration UI
│   ├── popup.css       # Dark-mode styling matching KVM consoles
│   └── popup.js        # Live connection check & settings management
├── icons/              # Extension icons (16, 32, 48, 128 px)
│   ├── icon16.png
│   ├── icon32.png
│   ├── icon48.png
│   └── icon128.png
├── test/               # Local testing suite
│   ├── mock-glkvm.html # Mock GLKVM web console for verification
│   └── run-test.js     # Automated headless Chrome CDP test runner
└── README.md
```

---

## Installation in Google Chrome

1. Open Google Chrome.
2. In the URL address bar, enter:
   ```text
   chrome://extensions
   ```
3. Enable **Developer mode** using the toggle switch in the top-right corner.
4. Click the **Load unpacked** button in the top-left corner.
5. Select this directory (`/home/dburger/src/glkvm-linker`).
6. The **GLKVM Linker** extension is now installed and active!

---

## How to Use

1. Ensure your GLKVM web management interface is open in a browser tab (`http://glkvm.local`).
2. Browse any webpage and locate a hyperlink you want to open or paste into your remote computer.
3. Right-click the hyperlink and select **"Send to GLKVM"** from the context menu.
4. The extension will automatically copy the link and relay it through GLKVM to the remote device.
5. An extension badge (`OK`) and desktop notification will confirm delivery.

---

## Extension Popup Features

Click the **GLKVM Linker** icon in your Chrome toolbar to open the popup:

- **Live Tab Status**: Shows whether a tab with `glkvm.local` is currently open and connected.
- **Quick Send**: Type or paste any URL manually and click **Send** to send it directly to GLKVM.
- **Settings**:
  - **Target Domain / IP**: Defaults to `glkvm.local`, but can be changed to an IP address (e.g., `192.168.8.1`) or custom hostname.
  - **Switch to GLKVM Tab**: Optional toggle to focus the GLKVM tab after sending.
  - **Append Newline**: Enabled by default to automatically press Enter when sending.
  - **Notification Toasts**: Toggle desktop notifications on/off.

---

## Testing & Verification

### Interactive Simulator
Open `test/mock-glkvm.html` in Chrome:
1. Open Chrome and navigate to `file:///home/dburger/src/glkvm-linker/test/mock-glkvm.html`.
2. In the extension popup or settings, ensure the domain matches or test using the Quick Send tool.
3. Right-click on any of the sample links on the page and click **"Send to GLKVM"**.
4. Observe the modal open, URL paste, and the Remote Device Input Log record the event.

### Automated End-to-End Test
Run the automated headless test runner:
```bash
node test/run-test.js
```
This launches headless Google Chrome, loads `mock-glkvm.html`, executes the automation logic over Chrome DevTools Protocol (CDP), and verifies that all 5 steps complete successfully.
